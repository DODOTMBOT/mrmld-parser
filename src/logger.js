import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'parser-data');
const LOG_FILE = join(DATA_DIR, 'parser.log');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function log(level, message) {
  ensureDir();
  const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${message}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}
