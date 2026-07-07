import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root = parent of src/
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LC_DIR = path.join(ROOT, '.lc');
const CONFIG_FILE = path.join(LC_DIR, 'config.json');
const META_FILE = path.join(LC_DIR, 'meta.json');
export const SOLUTIONS_DIR = path.join(ROOT, 'solutions');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  try { fs.chmodSync(file, 0o600); } catch { /* windows: ignore */ }
}

export function getConfig() {
  return readJson(CONFIG_FILE, {});
}

export function saveConfig(patch) {
  const cfg = { ...getConfig(), ...patch };
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

// meta.json maps titleSlug -> { questionId, frontendId, title, difficulty, file, lang }
export function getMeta() {
  return readJson(META_FILE, {});
}

export function saveMeta(slug, entry) {
  const meta = getMeta();
  meta[slug] = { ...(meta[slug] || {}), ...entry };
  writeJson(META_FILE, meta);
  return meta[slug];
}
