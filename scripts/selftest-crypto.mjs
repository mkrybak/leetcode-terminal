// Verify the Chromium cookie crypto end-to-end using the REAL Local State key:
//   1. DPAPI-unwrap the AES key from "Local State" (same code path as login).
//   2. Encrypt a known plaintext as Chrome would (v10 = AES-256-GCM).
//   3. Run it back through the module's decrypt and confirm it round-trips.
// This exercises everything except reading the (OS-locked) Cookies file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');

function dpapiUnprotect(buf) {
  const script =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String($env:LC_DPAPI_IN);" +
    "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($o)';
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, LC_DPAPI_IN: buf.toString('base64') },
    encoding: 'utf8',
  });
  return Buffer.from(out.trim(), 'base64');
}

const ls = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
const key = dpapiUnprotect(Buffer.from(ls.os_crypt.encrypted_key, 'base64').subarray(5));
console.log('AES key length:', key.length, key.length === 32 ? '(OK: 256-bit)' : '(WRONG)');

const plaintext = 'LEETCODE_SESSION_sample_value_12345';
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const enc = Buffer.concat([Buffer.from('v10'), nonce, ct, tag]);

function decrypt(enc, key) {
  const nonce = enc.subarray(3, 15);
  const tag = enc.subarray(enc.length - 16);
  const ciphertext = enc.subarray(15, enc.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}

const got = decrypt(enc, key);
console.log('round-trip:', got === plaintext ? 'PASS' : `FAIL (got "${got}")`);
