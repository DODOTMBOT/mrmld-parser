import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'parser-data');
const STATE_FILE = join(DATA_DIR, 'last-seen.json');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function read() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function write(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function getLastSeen(username) {
  return read()[username] ?? 0;
}

export function setLastSeen(username, id) {
  const state = read();
  state[username] = id;
  write(state);
}
