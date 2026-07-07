// Read LeetCode cookies directly from an installed browser's cookie store,
// so `lc login` doesn't require copy-pasting from DevTools.
//
// - Firefox: cookies.sqlite stores values in plaintext.
// - Chromium (Chrome/Edge/Brave): values are AES-256-GCM encrypted with a key
//   that itself is DPAPI-protected inside "Local State". We unwrap the key via
//   PowerShell's ProtectedData, then decrypt each cookie with Node's crypto.
//
// Windows-only for the encrypted paths (that's this user's platform).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WANTED = ['LEETCODE_SESSION', 'csrftoken'];

// node:sqlite prints an ExperimentalWarning on first load; hide just that one.
async function loadSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = (msg, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' || /SQLite/i.test(String(msg))) return;
    return orig.call(process, msg, ...rest);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = orig;
  }
}

// Copy a file that another process may hold open. Chrome/Edge keep an
// exclusive-ish lock on the cookie DB while running, so a plain copyFileSync
// fails with EBUSY. Retry via a .NET handle opened with FileShare.ReadWrite.
function robustCopy(src, dst) {
  try {
    fs.copyFileSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
  }
  const script =
    "$ErrorActionPreference='Stop';" +
    "$in=[System.IO.File]::Open($env:LC_SRC,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);" +
    "$out=[System.IO.File]::Create($env:LC_DST);" +
    'try{$in.CopyTo($out)}finally{$out.Close();$in.Close()}';
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, LC_SRC: src, LC_DST: dst },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

// The copied cookie DB holds session cookies in plaintext, so keep every copy
// inside a private (0700) temp dir with a random name, and make sure it is
// removed even if the process exits abnormally before cleanup() runs.
const tempDirs = new Set();
let exitHookInstalled = false;
function installExitCleanup() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

// Copy a (possibly locked) sqlite db to a private temp dir and open read-only.
async function openReadonlyCopy(dbPath) {
  const { DatabaseSync } = await loadSqlite();
  installExitCleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cookies-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* windows: ignore */ }
  tempDirs.add(dir);
  const tmp = path.join(dir, 'Cookies.sqlite');
  robustCopy(dbPath, tmp);
  for (const suffix of ['-wal', '-shm']) {
    const extra = dbPath + suffix;
    if (fs.existsSync(extra)) {
      try { robustCopy(extra, tmp + suffix); } catch { /* ignore */ }
    }
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
  const cleanup = () => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    tempDirs.delete(dir);
  };
  return { db, cleanup };
}

// ---------- Firefox ----------

function firefoxProfiles() {
  const base = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((d) => path.join(base, d, 'cookies.sqlite'))
    .filter((p) => fs.existsSync(p))
    // prefer the "default-release" profile
    .sort((a, b) => (b.includes('default-release') ? 1 : 0) - (a.includes('default-release') ? 1 : 0));
}

async function fromFirefox() {
  for (const dbPath of firefoxProfiles()) {
    let handle;
    try {
      handle = await openReadonlyCopy(dbPath);
      const rows = handle.db
        .prepare(
          `SELECT name, value FROM moz_cookies
           WHERE host LIKE '%leetcode.com' AND name IN (?, ?)`
        )
        .all(...WANTED);
      const out = {};
      for (const r of rows) out[r.name] = r.value;
      if (out.LEETCODE_SESSION) return { source: 'Firefox', cookies: out };
    } catch {
      /* try next profile */
    } finally {
      handle?.cleanup();
    }
  }
  return null;
}

// ---------- Chromium family ----------

function chromiumRoots() {
  const L = process.env.LOCALAPPDATA || '';
  return [
    { name: 'Chrome', root: path.join(L, 'Google', 'Chrome', 'User Data') },
    { name: 'Edge', root: path.join(L, 'Microsoft', 'Edge', 'User Data') },
    { name: 'Brave', root: path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  ];
}

// All cookie DBs under a Chromium root: "Default" plus every "Profile N".
// (A user can be logged into LeetCode under any profile, not just Default.)
function chromiumCookieDbs(root) {
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles = entries
    .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
    .map((e) => e.name)
    // Default first, then Profile 1, 2, ... in numeric order.
    .sort((a, b) =>
      a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true })
    );
  const dbs = [];
  for (const prof of profiles) {
    const db = path.join(root, prof, 'Network', 'Cookies');
    if (fs.existsSync(db)) dbs.push(db);
  }
  return dbs;
}

// Read the Windows clipboard as text (for `lc login --clip`).
export function readClipboard() {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8' }
    );
  } catch {
    return '';
  }
}

// Pull LEETCODE_SESSION / csrftoken out of arbitrary pasted text — a full
// "Cookie:" request header, a "key=value; key=value" string, JSON, or lines.
export function parseLeetcodeCookies(text) {
  const s = String(text || '');
  const grab = (name) =>
    s.match(new RegExp(`${name}["']?\\s*[=:]\\s*["']?([^;,\\s"']+)`, 'i'))?.[1];
  const out = {};
  const session = grab('LEETCODE_SESSION');
  const csrf = grab('csrftoken');
  if (session) out.LEETCODE_SESSION = session;
  if (csrf) out.csrftoken = csrf;
  return out;
}

const EXE_BY_NAME = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' };

export function isBrowserRunning(name) {
  const exe = EXE_BY_NAME[String(name).toLowerCase()];
  if (!exe) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], {
      encoding: 'utf8',
    });
    return out.toLowerCase().includes(exe);
  } catch {
    return false;
  }
}

// Which Chromium-family browsers are currently running (proper-cased names).
export function runningChromiumBrowsers() {
  return ['Chrome', 'Edge', 'Brave'].filter((n) => isBrowserRunning(n));
}

// Force-close a browser (and its child processes). Chrome/Edge restore tabs on
// next launch. Returns true if a process was terminated.
export function closeBrowser(name) {
  const exe = EXE_BY_NAME[String(name).toLowerCase()];
  if (!exe) return false;
  try {
    execFileSync('taskkill', ['/IM', exe, '/F', '/T'], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function dpapiUnprotect(buf) {
  // Decrypt a DPAPI blob (CurrentUser) via PowerShell; base64 in/out to dodge escaping.
  const script =
    "$ErrorActionPreference='Stop';" +
    'Add-Type -AssemblyName System.Security;' +
    "$b=[Convert]::FromBase64String($env:LC_DPAPI_IN);" +
    "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($o)';
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, LC_DPAPI_IN: buf.toString('base64') }, encoding: 'utf8' }
  );
  return Buffer.from(out.trim(), 'base64');
}

function chromiumKey(root) {
  const localState = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
  const b64 = localState?.os_crypt?.encrypted_key;
  if (!b64) throw new Error('no os_crypt key');
  const blob = Buffer.from(b64, 'base64');
  const dpapiBlob = blob.subarray(5); // strip "DPAPI" prefix
  return dpapiUnprotect(dpapiBlob);
}

function decryptChromiumValue(enc, key) {
  if (enc.length === 0) return '';
  const prefix = enc.subarray(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const ciphertext = enc.subarray(15, enc.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  if (prefix === 'v20') {
    // App-bound encryption (Chrome 127+): key is machine/SYSTEM-bound, not
    // recoverable at user level here. Signal so we can fall back gracefully.
    const err = new Error('app-bound-encryption');
    err.appBound = true;
    throw err;
  }
  // Legacy: whole value is a DPAPI blob.
  return dpapiUnprotect(enc).toString('utf8');
}

function isLockError(e) {
  return (
    e &&
    (e.code === 'EBUSY' ||
      e.code === 'EPERM' ||
      e.code === 'EACCES' ||
      /being used by another process|cannot access the file/i.test(String(e.message)))
  );
}

function lockedError(name) {
  const err = new Error(
    `${name} is running and locks the cookie database. ` +
      `Fully close ${name} (check the system tray) and retry, or use: lc login --manual`
  );
  err.locked = true;
  err.browser = name;
  return err;
}

function appBoundError(name) {
  const err = new Error(
    `${name} uses app-bound cookie encryption (v20), which can't be read at the user level. ` +
      `Log in to leetcode.com in Firefox for auto-login, or use: lc login --manual`
  );
  err.appBound = true;
  err.browser = name;
  return err;
}

// Read + decrypt the wanted cookies from a single Chromium cookie DB.
// Returns { cookies, sawAppBound }. Throws lock errors up to the caller.
async function readChromiumCookieDb(cookiesDb, key) {
  const handle = await openReadonlyCopy(cookiesDb);
  try {
    const rows = handle.db
      .prepare(
        `SELECT name, encrypted_value FROM cookies
         WHERE host_key LIKE '%leetcode.com' AND name IN (?, ?)`
      )
      .all(...WANTED);
    const out = {};
    let sawAppBound = false;
    for (const r of rows) {
      try {
        out[r.name] = decryptChromiumValue(Buffer.from(r.encrypted_value), key);
      } catch (e) {
        if (e.appBound) sawAppBound = true;
        else throw e;
      }
    }
    return { cookies: out, sawAppBound };
  } finally {
    handle.cleanup();
  }
}

// Read cookies from one Chromium browser, scanning every profile.
// Returns { source, cookies } | null. Throws a tagged error (.locked /
// .appBound) when that's the reason no cookies could be read.
async function readChromiumBrowser(name, root) {
  let key;
  try {
    key = chromiumKey(root);
  } catch {
    return null; // can't get the decryption key for this browser
  }
  let sawAppBound = false;
  for (const cookiesDb of chromiumCookieDbs(root)) {
    let res;
    try {
      res = await readChromiumCookieDb(cookiesDb, key);
    } catch (e) {
      if (isLockError(e)) throw lockedError(name);
      throw e;
    }
    if (res.sawAppBound) sawAppBound = true;
    if (res.cookies.LEETCODE_SESSION) return { source: name, cookies: res.cookies };
  }
  if (sawAppBound) throw appBoundError(name);
  return null;
}

async function fromChromium() {
  let appBoundErr;
  const locked = [];
  for (const { name, root } of chromiumRoots()) {
    try {
      const res = await readChromiumBrowser(name, root);
      if (res?.cookies?.LEETCODE_SESSION) return res;
    } catch (e) {
      if (e.locked) locked.push(name);
      else if (e.appBound) appBoundErr = appBoundErr || e;
      // otherwise: skip this browser, try the next
    }
  }
  if (locked.length) {
    const err = new Error(
      `${locked.join(' and ')} ${locked.length > 1 ? 'are' : 'is'} running and lock the cookie database. ` +
        `Fully close ${locked.join('/')} (check the system tray) and retry, or use: lc login --manual`
    );
    err.locked = true;
    throw err;
  }
  if (appBoundErr) throw appBoundErr;
  return null;
}

async function fromChromiumOnly(name) {
  const target = chromiumRoots().find((b) => b.name.toLowerCase() === name);
  if (!target) return null;
  return readChromiumBrowser(target.name, target.root);
}

// Try browsers in order; return { source, cookies } or null.
// `preferred` (optional): 'firefox' | 'chrome' | 'edge' | 'brave' to force one.
export async function getLeetcodeCookies(preferred) {
  if (process.platform !== 'win32') {
    throw new Error('Browser auto-login currently supports Windows only. Use: lc login');
  }
  const p = (preferred || '').toLowerCase();
  const tryers = [];
  if (p === 'firefox') tryers.push(fromFirefox);
  else if (p && p !== 'firefox') tryers.push(() => fromChromiumOnly(p));
  else tryers.push(fromFirefox, fromChromium);

  const errors = [];
  for (const fn of tryers) {
    try {
      const res = await fn();
      if (res?.cookies?.LEETCODE_SESSION) return res;
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) {
    // Surface the most actionable error first: a locked browser (the user can
    // close it, or re-run with --close-browser) or an app-bound explanation
    // beats a generic "not found" from another browser.
    const best =
      errors.find((e) => e.locked) || errors.find((e) => e.appBound) || errors[0];
    throw best;
  }
  return null;
}
