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

// Copy a (possibly locked) sqlite db to temp and open read-only.
async function openReadonlyCopy(dbPath) {
  const { DatabaseSync } = await loadSqlite();
  const tmp = path.join(os.tmpdir(), `lc-cookies-${process.pid}-${Date.now()}.sqlite`);
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
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmp + s); } catch { /* ignore */ }
    }
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

async function fromChromium() {
  let sawAppBound = false;
  const locked = [];
  for (const { name, root } of chromiumRoots()) {
    const cookiesDb = path.join(root, 'Default', 'Network', 'Cookies');
    if (!fs.existsSync(cookiesDb)) continue;
    let handle;
    let key;
    try {
      key = chromiumKey(root);
    } catch {
      continue; // can't get key for this browser
    }
    try {
      handle = await openReadonlyCopy(cookiesDb);
      const rows = handle.db
        .prepare(
          `SELECT name, encrypted_value FROM cookies
           WHERE host_key LIKE '%leetcode.com' AND name IN (?, ?)`
        )
        .all(...WANTED);
      const out = {};
      for (const r of rows) {
        try {
          out[r.name] = decryptChromiumValue(Buffer.from(r.encrypted_value), key);
        } catch (e) {
          if (e.appBound) sawAppBound = true;
        }
      }
      if (out.LEETCODE_SESSION) return { source: name, cookies: out };
    } catch (e) {
      if (isLockError(e)) locked.push(name);
      /* try next browser */
    } finally {
      handle?.cleanup();
    }
  }
  if (sawAppBound) {
    const err = new Error(
      'Your Chrome/Edge uses app-bound cookie encryption (v20), which cannot be read at the user level. ' +
        'Use Firefox for auto-login, or fall back to manual: lc login'
    );
    err.appBound = true;
    throw err;
  }
  if (locked.length) {
    const err = new Error(
      `${locked.join(' and ')} ${locked.length > 1 ? 'are' : 'is'} running and lock the cookie database. ` +
        `Fully close ${locked.join('/')} (check the system tray) and retry, or use: lc login --manual`
    );
    err.locked = true;
    throw err;
  }
  return null;
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

  let firstErr;
  for (const fn of tryers) {
    try {
      const res = await fn();
      if (res?.cookies?.LEETCODE_SESSION) return res;
    } catch (e) {
      firstErr = firstErr || e;
    }
  }
  if (firstErr) throw firstErr;
  return null;
}

async function fromChromiumOnly(name) {
  const target = chromiumRoots().find((b) => b.name.toLowerCase() === name);
  if (!target) return null;
  const cookiesDb = path.join(target.root, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(cookiesDb)) return null;
  const key = chromiumKey(target.root);
  let handle;
  try {
    handle = await openReadonlyCopy(cookiesDb);
  } catch (e) {
    if (isLockError(e)) {
      const err = new Error(
        `${target.name} is running and locks the cookie database. ` +
          `Fully close ${target.name} (check the system tray) and retry, or use: lc login --manual`
      );
      err.locked = true;
      throw err;
    }
    throw e;
  }
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
    if (out.LEETCODE_SESSION) return { source: target.name, cookies: out };
    if (sawAppBound) {
      const err = new Error(
        `${target.name} uses app-bound cookie encryption (v20), which can't be read at the user level. ` +
          `Log in to leetcode.com in Firefox for auto-login, or use: lc login --manual`
      );
      err.appBound = true;
      throw err;
    }
    return null;
  } finally {
    handle.cleanup();
  }
}
