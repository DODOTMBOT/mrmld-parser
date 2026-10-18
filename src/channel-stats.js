import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { request } from 'https';
import { lookup } from 'dns/promises';
import { log } from './logger.js';

const ROOT     = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'parser-data');
const SNAP_FILE = join(DATA_DIR, 'member-snapshots.json');

function loadSnapshots() {
  try { return JSON.parse(readFileSync(SNAP_FILE, 'utf-8')); } catch { return []; }
}

function saveSnapshot(count) {
  mkdirSync(DATA_DIR, { recursive: true });
  const snaps = loadSnapshots();
  const today = new Date().toISOString().slice(0, 10);
  const last  = snaps[snaps.length - 1];
  if (last?.date === today) {
    last.count = count;
  } else {
    snaps.push({ date: today, count });
    // Keep 90 days max
    if (snaps.length > 90) snaps.splice(0, snaps.length - 90);
  }
  writeFileSync(SNAP_FILE, JSON.stringify(snaps));
  return snaps;
}

function growthDelta(snaps, days) {
  if (snaps.length < 2) return null;
  const now  = snaps[snaps.length - 1];
  const past = [...snaps].reverse().find(s => {
    const d = (new Date(now.date) - new Date(s.date)) / 86400000;
    return d >= days;
  });
  if (!past) return null;
  return now.count - past.count;
}

function parseViews(str) {
  if (!str) return 0;
  const s = str.trim().replace(/\s/g, '').replace(',', '.');
  if (s.endsWith('K') || s.endsWith('k')) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith('M') || s.endsWith('m')) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s, 10) || 0;
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      timeout: 10_000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function tgApi(method, params = {}) {
  const url  = `https://api.telegram.org/bot${process.env.MODERATION_BOT_TOKEN}/${method}`;
  const data = await httpsPost(url, JSON.stringify(params));
  if (!data.ok) throw new Error(data.description);
  return data.result;
}

async function fetchMemberCount(channelId) {
  try { return await tgApi('getChatMemberCount', { chat_id: channelId }); } catch { return null; }
}

async function resolveHost(hostname) {
  // Prefer IPv6 since Telegram's IPv4 may be blocked in Russia
  try {
    const r = await lookup(hostname, { family: 6 });
    return { address: `[${r.address}]`, family: 6 };
  } catch {
    const r = await lookup(hostname, { family: 4 });
    return { address: r.address, family: 4 };
  }
}

async function httpsGet(urlStr) {
  const u = new URL(urlStr);
  const { address } = await resolveHost(u.hostname);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: address.replace(/^\[|\]$/g, ''),
      port: 443,
      path: u.pathname + u.search,
      headers: {
        'Host': u.hostname,
        'User-Agent': 'Mozilla/5.0 (compatible; MrmldParser/1.0)',
        'Accept-Encoding': 'identity',
      },
      servername: u.hostname,
      timeout: 15_000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function scrapeChannelPosts(username) {
  const html = await httpsGet(`https://t.me/s/${username}`);
  const $    = cheerio.load(html);

  const posts = [];

  $('.tgme_widget_message').each((_, el) => {
    const dataPost = $(el).attr('data-post') ?? '';
    const idStr    = dataPost.split('/')[1];
    const id       = parseInt(idStr, 10);
    if (!id) return;

    // Skip forwarded
    if ($(el).find('.tgme_widget_message_forwarded_from').length > 0) return;

    const viewsEl  = $(el).find('.tgme_widget_message_views');
    const views    = parseViews(viewsEl.text());

    const dateEl   = $(el).find('.tgme_widget_message_date time');
    const datetime = dateEl.attr('datetime') ?? '';
    const date     = datetime ? new Date(datetime) : null;

    const textEl   = $(el).find('.tgme_widget_message_text').first();
    const text     = textEl.text().trim().slice(0, 120);

    const hasPhoto = $(el).find('.tgme_widget_message_photo_wrap').length > 0;
    const hasVideo = $(el).find('video.tgme_widget_message_video').length > 0;

    posts.push({ id, views, date, text, hasPhoto, hasVideo, url: `https://t.me/${username}/${id}` });
  });

  return posts;
}

export async function getChannelStats() {
  const channelId = process.env.APERITIV_CHANNEL_ID;
  const username  = channelId.replace('@', '');

  const [members, posts] = await Promise.all([
    fetchMemberCount(channelId),
    scrapeChannelPosts(username).catch(e => {
      log('warn', `[channel-stats] scrape failed: ${e.message}`);
      return [];
    }),
  ]);

  // Save subscriber snapshot
  const snaps = members !== null ? saveSnapshot(members) : loadSnapshots();

  const growthDay   = growthDelta(snaps, 1);
  const growthWeek  = growthDelta(snaps, 7);
  const growthMonth = growthDelta(snaps, 30);

  // Post analytics (posts with views > 0)
  const withViews = posts.filter(p => p.views > 0);
  const maxViews  = withViews.length ? Math.max(...withViews.map(p => p.views)) : null;
  const minViews  = withViews.length ? Math.min(...withViews.map(p => p.views)) : null;
  const avgViews  = withViews.length ? Math.round(withViews.reduce((s, p) => s + p.views, 0) / withViews.length) : null;
  const bestPost  = withViews.length ? withViews.reduce((a, b) => b.views > a.views ? b : a) : null;

  // Sort by views desc for the posts table
  const sortedPosts = [...posts].sort((a, b) => b.views - a.views).slice(0, 10);

  return {
    members,
    growthDay,
    growthWeek,
    growthMonth,
    maxViews,
    minViews,
    avgViews,
    bestPost,
    posts: sortedPosts,
    totalPosts: posts.length,
  };
}
