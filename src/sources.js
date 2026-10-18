import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const ROOT      = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR  = join(ROOT, 'parser-data');
const LOCAL_FILE = join(DATA_DIR, 'sources.json');

// Legacy fallback (website file)
const LEGACY_FILE = '/var/www/mrmld/src/data/sources.json';

function readSources() {
  if (existsSync(LOCAL_FILE)) {
    return JSON.parse(readFileSync(LOCAL_FILE, 'utf-8'));
  }
  // First run: migrate from legacy file
  if (existsSync(LEGACY_FILE)) {
    const list = JSON.parse(readFileSync(LEGACY_FILE, 'utf-8'));
    writeSources(list);
    log('info', `Migrated ${list.length} sources from legacy file`);
    return list;
  }
  return [];
}

function writeSources(list) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCAL_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

export function fetchActiveSources() {
  try {
    return readSources().filter((s) => s.active !== false);
  } catch (err) {
    log('error', `fetchActiveSources failed: ${err.message}`);
    return [];
  }
}

export function listAllSources() {
  try {
    return readSources();
  } catch {
    return [];
  }
}

export function addSource(username) {
  const list = readSources();
  const clean = username.replace(/^@/, '').toLowerCase();
  if (list.find((s) => s.username.toLowerCase() === clean)) return false;
  list.push({ username: clean, active: true });
  writeSources(list);
  return true;
}

export function removeSource(username) {
  const list = readSources();
  const clean = username.replace(/^@/, '').toLowerCase();
  const idx = list.findIndex((s) => s.username.toLowerCase() === clean);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeSources(list);
  return true;
}

export function toggleSource(username) {
  const list = readSources();
  const clean = username.replace(/^@/, '').toLowerCase();
  const src = list.find((s) => s.username.toLowerCase() === clean);
  if (!src) return null;
  src.active = !src.active;
  writeSources(list);
  return src.active;
}
