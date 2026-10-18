import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT     = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'parser-data');
const FILE     = join(DATA_DIR, 'comment-state.json');

// 1 day between queueing comments for the same source
const SOURCE_COOLDOWN_MS  = 24 * 60 * 60 * 1000;
// 5–10 min randomised gap between published comments (globally)
const PUBLISH_MIN_MS = 5 * 60 * 1000;
const PUBLISH_MAX_MS = 10 * 60 * 1000;

function read() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf-8'));
  } catch {}
  return { nextGlobalAt: 0, perSource: {} };
}

function save(state) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

// Returns true if we haven't queued a comment for this source in the last day
export function canQueueComment(username) {
  const last = read().perSource?.[username] ?? 0;
  return Date.now() - last >= SOURCE_COOLDOWN_MS;
}

// Returns true if global publish cooldown has elapsed
export function canPublishNow() {
  return Date.now() >= (read().nextGlobalAt ?? 0);
}

// Seconds remaining until next publish is allowed (0 if ready)
export function secondsUntilPublish() {
  return Math.max(0, Math.ceil(((read().nextGlobalAt ?? 0) - Date.now()) / 1000));
}

// Call after a comment is sent to moderation (prevents repeated queueing for same source)
export function markQueued(username) {
  const state = read();
  state.perSource = state.perSource ?? {};
  state.perSource[username] = Date.now();
  save(state);
}

// Call after a comment is successfully published via MTProto
export function markPublished(username) {
  const state = read();
  const delay = PUBLISH_MIN_MS + Math.random() * (PUBLISH_MAX_MS - PUBLISH_MIN_MS);
  state.nextGlobalAt = Date.now() + delay;
  state.perSource = state.perSource ?? {};
  state.perSource[username] = Date.now();
  save(state);
}
