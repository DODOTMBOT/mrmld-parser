import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { generateNews, generateOpinion, generateCustom } from './llm.js';
import { log } from './logger.js';
import { listAllSources, addSource, removeSource, toggleSource } from './sources.js';
import { canPublishNow, secondsUntilPublish, markPublished, markQueued } from './comment-state.js';
import { sendCommentToPost } from './gramjs-client.js';
import { saveHeadline } from './llm.js';

// ─── Persistent pending store ─────────────────────────────────────────────────

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR    = join(ROOT, 'parser-data');
const PENDING_FILE = join(DATA_DIR, 'pending.json');
const PHOTO_CACHE_DIR = join(DATA_DIR, 'photo-cache');

function loadPending() {
  try {
    if (!existsSync(PENDING_FILE)) return new Map();
    const obj = JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function savePending(map) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(map)), 'utf-8');
  } catch (err) {
    log('error', `savePending failed: ${err.message}`);
  }
}

// postKey ("username:id") → { post, rawDraft, chatId, msgId, llmText, editedText }
const pending = loadPending();

// promptMsgId → { postKey, moderationChatId, moderationMsgId }
const editPrompts = new Map();

// custom prompt replies: promptMsgId → { postKey, moderationChatId, moderationMsgId }
const custPrompts = new Map();

// ─── Pending comments store ───────────────────────────────────────────────────

const COMMENTS_FILE = join(DATA_DIR, 'pending-comments.json');

function loadComments() {
  try {
    if (!existsSync(COMMENTS_FILE)) return new Map();
    const obj = JSON.parse(readFileSync(COMMENTS_FILE, 'utf-8'));
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveComments(map) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(COMMENTS_FILE, JSON.stringify(Object.fromEntries(map)), 'utf-8');
  } catch (err) {
    log('error', `saveComments failed: ${err.message}`);
  }
}

// commentKey ("username:id") → { post, commentText, editedText, chatId, msgId }
const pendingComments = loadComments();

// promptMsgId → { commentKey, moderationChatId, moderationMsgId }
const commentEditPrompts = new Map();

const FOOTER = '\n\n<b><a href="https://t.me/+Y31Fj1QPm6AwOTQ6">Мармелад | Общепит, магазины, рестораны</a></b>';

function extractHeadline(text) {
  // First non-empty line, stripped of emoji and HTML tags
  const plain = text.replace(/<[^>]+>/g, '').trim();
  const line = plain.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{E000}-\u{F8FF}]/gu, '').trim();
}
const CAPTION_LIMIT = 1024;

const LOGO_PATH = join(ROOT, 'assets', 'logo.png');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// Cached base64 font — loaded once, avoids fontconfig dependency
let _fontB64 = null;
function getFontB64() {
  if (_fontB64 === null) {
    try { _fontB64 = readFileSync(FONT_PATH).toString('base64'); } catch { _fontB64 = ''; }
  }
  return _fontB64;
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractPlainTitle(text) {
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const firstLine = plain.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  // Strip emoji and non-printable/special Unicode symbols
  return firstLine
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{E000}-\u{F8FF}]/gu, '')
    .trim();
}

// Wrap plain text into lines of max charsPerLine, word-boundary only
function wrapLines(text, availW, fontSize, maxLines = 2) {
  const charW = fontSize * 0.72;
  const cpl   = Math.floor(availW / charW);
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (test.length <= cpl) { cur = test; }
    else { if (cur) lines.push(cur); cur = w; if (lines.length >= maxLines - 1) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

async function applyWatermark(photoBuffer, title = '') {
  try {
    if (!existsSync(LOGO_PATH)) return photoBuffer;

    // Crop portrait photos to 4:3 landscape before watermarking
    const TARGET_RATIO = 4 / 3;
    const meta0 = await sharp(photoBuffer).metadata();
    if ((meta0.height ?? 0) > (meta0.width ?? 0)) {
      const newH = Math.round((meta0.width ?? meta0.height ?? 0) / TARGET_RATIO);
      photoBuffer = await sharp(photoBuffer)
        .resize(meta0.width, newH, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 95 })
        .toBuffer();
    }

    const img = sharp(photoBuffer);
    const { width: W, height: H } = await img.metadata();

    // ── Dimensions ────────────────────────────────────────────────────────────
    const border   = Math.round(W * 0.028);           // yellow frame width
    const blockH   = Math.round(H * 0.33);            // yellow block height
    const blockTop = H - blockH;
    const availW   = W - border * 2;                  // usable width inside frame

    // ── Font ──────────────────────────────────────────────────────────────────
    const fontB64    = getFontB64();
    const fontStyle  = fontB64
      ? `@font-face{font-family:'MFont';src:url('data:font/truetype;base64,${fontB64}')}`
      : '';
    const fontFamily = fontB64 ? 'MFont, sans-serif' : 'DejaVu Sans, sans-serif';

    // ── "#МАРМЕЛАД" stretched to full image width ────────────────────────────
    const brandText      = '#MRMLD';
    const brandFontSz    = Math.round(blockH * 0.36);
    const brandGapTop    = Math.round(blockH * 0.04);
    const brandBaselineY = blockTop + brandGapTop + brandFontSz;

    // ── Title text below brand ─────────────────────────────────────────────────
    const titleFontSz = Math.round(blockH * 0.14);
    const titleLineH  = Math.round(titleFontSz * 1.32);
    const titleTopY   = brandBaselineY + Math.round(blockH * 0.05) + titleFontSz;
    const titleLines  = wrapLines(title, availW - Math.round(W * 0.18), titleFontSz, 3);

    // ── Logo (bottom-right of yellow block) ────────────────────────────────────
    const logoSz  = Math.round(blockH * 0.62);
    const logoL   = W - border - logoSz;
    const logoT   = H - border - logoSz;

    // ── Rounded corner radius for frame ───────────────────────────────────────
    const rx      = Math.round(border * 2.8);
    const innerRx = Math.max(0, rx - border);

    // ── Layer 1: dark overlay on photo behind yellow block (readability) ───────
    const darkSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect x="0" y="${blockTop}" width="${W}" height="${blockH}" fill="rgba(0,0,0,0.40)"/>` +
      `</svg>`
    );

    // ── Layer 2: yellow frame (rounded) + yellow block — NO text mask in SVG ───
    // librsvg doesn't reliably render custom fonts inside <mask>; instead we
    // build the yellow layer as a PNG then punch the brand text out via dest-out.
    const yellowBaseSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs>` +
      `<mask id="frame-mask" maskUnits="userSpaceOnUse">` +
        `<rect fill="white" x="0" y="0" width="${W}" height="${H}" rx="${rx}"/>` +
        `<rect fill="black" x="${border}" y="${border}" width="${W - border * 2}" height="${blockTop - border}" rx="${innerRx}"/>` +
      `</mask>` +
      `</defs>` +
      `<rect fill="#F5E401" x="0" y="0" width="${W}" height="${H}" mask="url(#frame-mask)"/>` +
      `<rect fill="#F5E401" x="0" y="${blockTop}" width="${W}" height="${blockH}"/>` +
      `</svg>`
    );

    // Brand text as opaque black — will be used with dest-out to punch cutout
    const brandSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      (fontStyle ? `<defs><style>${fontStyle}</style></defs>` : '') +
      `<text fill="black" x="${Math.round(W/2)}" y="${brandBaselineY}" text-anchor="middle" ` +
        `font-family="${fontFamily}" font-size="${brandFontSz}" font-weight="bold" ` +
        `textLength="${W}" lengthAdjust="spacingAndGlyphs">` +
        `${xmlEscape(brandText)}</text>` +
      `</svg>`
    );

    // Composite yellow base + punch text out → transparent where letters are
    const yellowLayer = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: yellowBaseSvg, blend: 'over' },
        { input: brandSvg,      blend: 'dest-out' },
      ])
      .png()
      .toBuffer();

    // ── Layer 3: title text (solid dark) ──────────────────────────────────────
    const tspans = titleLines.map((ln, i) =>
      `<tspan x="${border}" dy="${i === 0 ? 0 : titleLineH}">${xmlEscape(ln)}</tspan>`
    ).join('');

    const titleSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      (fontStyle ? `<defs><style>${fontStyle}</style></defs>` : '') +
      `<text x="${border}" y="${titleTopY}" ` +
        `font-family="${fontFamily}" font-size="${titleFontSz}" font-weight="bold" ` +
        `fill="#2B2E30">${tspans}</text>` +
      `</svg>`
    );

    // ── Logo ──────────────────────────────────────────────────────────────────
    const logoResized = await sharp(LOGO_PATH)
      .resize(logoSz, logoSz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    return img
      .composite([
        { input: darkSvg,     blend: 'over' },
        { input: yellowLayer, blend: 'over' },
        { input: titleSvg,    blend: 'over' },
        { input: logoResized, left: logoL, top: logoT, blend: 'over' },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

  } catch (err) {
    log('warn', `watermark failed, using original: ${err.message}`);
    return photoBuffer;
  }
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

function baseUrl() {
  return `https://api.telegram.org/bot${process.env.MODERATION_BOT_TOKEN}`;
}

async function tg(method, params = {}, retries = 2) {
  const telegramTimeout = (params.timeout ?? 0) * 1000;
  const abortMs = telegramTimeout > 0 ? telegramTimeout + 10_000 : 15_000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(abortMs),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`TG ${method}: ${data.description}`);
      return data.result;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Bold the first line of LLM output, escape the rest
function formatLlmText(text) {
  const nlIdx = text.indexOf('\n');
  if (nlIdx === -1) return escapeHtml(text);
  const title = text.slice(0, nlIdx).trim();
  const body  = text.slice(nlIdx + 1).trim();
  return body
    ? `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`
    : `<b>${escapeHtml(title)}</b>`;
}

function clearButtons(chatId, messageId) {
  return tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

// Edit text or caption — tries the right method first, falls back to the other
async function editMsgContent(chatId, msgId, isPhoto, text, extra = {}) {
  const params = { chat_id: chatId, message_id: msgId, ...extra };
  const [primary, fallback] = isPhoto
    ? [() => tg('editMessageCaption', { ...params, caption: text }),
       () => tg('editMessageText',    { ...params, text })]
    : [() => tg('editMessageText',    { ...params, text }),
       () => tg('editMessageCaption', { ...params, caption: text })];
  try {
    await primary();
  } catch (e) {
    try {
      await fallback();
    } catch (e2) {
      log('error', `editMsg failed: ${e2.message}`);
    }
  }
}

// ─── Photo handling ───────────────────────────────────────────────────────────

// Persistent undici agent — created once, reused for all photo fetches
import { Agent as UndiciAgent } from 'undici';
const _photoAgent = new UndiciAgent({ connect: { rejectUnauthorized: false } });

async function fetchPhotoBuffer(url) {
  // cdn4.telesco.pe is blocked in Russia — route through Dutch proxy on 72.56.65.179:8444
  const proxyBase = process.env.CDN_PROXY_BASE;
  const agent = _photoAgent;

  const tryFetch = async (fetchUrl) => {
    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(7_000),
      dispatcher: agent,
    });
    return res;
  };

  let fetchUrl = url;
  if (proxyBase && url.includes('telesco.pe/file/')) {
    const path = url.slice(url.indexOf('/file/'));
    fetchUrl = proxyBase + path;
  }

  let res = await tryFetch(fetchUrl);

  // Proxy returned an error — fall back to original URL
  if (!res.ok && fetchUrl !== url) {
    log('warn', `proxy fetch ${res.status}, retrying original URL`);
    res = await tryFetch(url);
  }

  if (!res.ok) throw new Error(`photo fetch ${res.status} ${fetchUrl}`);
  return Buffer.from(await res.arrayBuffer());
}

// Download a photo via Bot API getFile (never blocked, file_id never expires)
async function fetchByFileId(fileId) {
  const data = await tg('getFile', { file_id: fileId });
  const filePath = data.file_path;
  const url = `https://api.telegram.org/file/bot${process.env.MODERATION_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`getFile download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function tgSendMediaMultipart(chatId, mediaUrl, mediaType, caption, extra = {}) {
  let buf;
  if (extra._localFile && existsSync(extra._localFile)) {
    buf = readFileSync(extra._localFile);
  } else if (extra._fileId) {
    buf = await fetchByFileId(extra._fileId);
  } else {
    buf = await fetchPhotoBuffer(mediaUrl);
  }
  // watermark disabled
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const isVideo = mediaType === 'video';
  const mime = isVideo ? 'video/mp4' : 'image/jpeg';
  const fname = isVideo ? 'video.mp4' : 'photo.jpg';
  const field = isVideo ? 'video' : 'photo';
  const method = isVideo ? 'sendVideo' : 'sendPhoto';
  form.append(field, new Blob([buf], { type: mime }), fname);
  if (caption) form.append('caption', caption);
  if (extra.parse_mode) form.append('parse_mode', extra.parse_mode);
  if (extra.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup));
  if (isVideo) form.append('supports_streaming', 'true');

  const res = await fetch(`${baseUrl()}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`TG ${method}: ${data.description}`);
  return data.result;
}

async function tgSendMediaGroupMultipart(chatId, items, caption, extra = {}) {
  const localFileMap = extra._localFileMap ?? {};
  const buffers = await Promise.all(items.map(async (item, i) => {
    if (localFileMap[i] && existsSync(localFileMap[i])) {
      return readFileSync(localFileMap[i]);
    }
    return fetchPhotoBuffer(item.url);
  }));

  const form = new FormData();
  form.append('chat_id', String(chatId));

  const mediaJson = items.map((item, i) => {
    const isVideo = item.type === 'video';
    const fieldName = `file${i}`;
    form.append(
      fieldName,
      new Blob([buffers[i]], { type: isVideo ? 'video/mp4' : 'image/jpeg' }),
      isVideo ? `video${i}.mp4` : `photo${i}.jpg`,
    );
    const entry = { type: item.type, media: `attach://${fieldName}` };
    if (i === 0 && caption) {
      entry.caption = caption;
      if (extra.parse_mode) entry.parse_mode = extra.parse_mode;
    }
    return entry;
  });

  form.append('media', JSON.stringify(mediaJson));

  const res = await fetch(`${baseUrl()}/sendMediaGroup`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`TG sendMediaGroup: ${data.description}`);
  return data.result;
}

// ─── Publish to channel ───────────────────────────────────────────────────────

// Returns first media item (for moderation preview — sendMediaGroup has no reply_markup support)
function getPostMedia(post) {
  if (post.mediaItems?.length) return post.mediaItems[0];
  // Legacy pending items stored with photoUrl/videoUrl
  if (post.videoUrl) return { url: post.videoUrl, type: 'video' };
  if (post.photoUrl) return { url: post.photoUrl, type: 'photo' };
  return null;
}

// Returns all media items for publishing
function getAllMedia(post) {
  if (post.mediaItems?.length) return post.mediaItems;
  const first = getPostMedia(post);
  return first ? [first] : [];
}

async function publishToChannel(text, post, cachedPhotos = []) {
  const allMedia = getAllMedia(post);
  const title    = extractPlainTitle(text);
  const dest     = process.env.APERITIV_CHANNEL_ID;

  if (allMedia.length === 0) {
    await tg('sendMessage', {
      chat_id: dest, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    return;
  }

  // Build local-file map from pre-cached photos (downloaded at moderation time)
  const localFileMap = {};
  for (const f of cachedPhotos) localFileMap[f.idx] = f.path;

  const sendTextOnly = () =>
    tg('sendMessage', { chat_id: dest, text, parse_mode: 'HTML', disable_web_page_preview: true });

  const cleanupCache = () => {
    for (const f of cachedPhotos) {
      try { if (existsSync(f.path)) unlinkSync(f.path); } catch {}
    }
  };

  try {
    if (allMedia.length === 1) {
      const m = allMedia[0];
      const extra = { parse_mode: 'HTML', _title: title, _localFile: localFileMap[0] };
      if (text.length <= CAPTION_LIMIT) {
        await tgSendMediaMultipart(dest, m.url, m.type, text, extra);
      } else {
        await tgSendMediaMultipart(dest, m.url, m.type, null, { _title: title, _localFile: localFileMap[0] });
        await tg('sendMessage', { chat_id: dest, text, parse_mode: 'HTML', disable_web_page_preview: true });
      }
    } else {
      const caption = text.length <= CAPTION_LIMIT ? text : null;
      await tgSendMediaGroupMultipart(dest, allMedia, caption, { parse_mode: 'HTML', _title: title, _localFileMap: localFileMap });
      if (!caption) await sendTextOnly();
    }
    cleanupCache();
  } catch (mediaErr) {
    log('warn', `media publish failed (${mediaErr.message}), publishing text only`);
    cleanupCache();
    await sendTextOnly();
  }
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

function rawKeyboard(postKey) {
  return {
    inline_keyboard: [
      [
        { text: '📰 LLM: переписать', callback_data: `llm_news:${postKey}` },
        { text: '✍️ Промт',           callback_data: `cust:${postKey}`     },
      ],
      [
        { text: '✅ Опубликовать',   callback_data: `pub_raw:${postKey}` },
        { text: '✏️ Редактировать', callback_data: `edt:${postKey}`     },
      ],
    ],
  };
}

function llmKeyboard(postKey) {
  return {
    inline_keyboard: [[
      { text: '✅ Опубликовать',   callback_data: `pub:${postKey}`    },
      { text: '✏️ Редактировать', callback_data: `edt:${postKey}`    },
      { text: '↩ Отмена',         callback_data: `cancel:${postKey}` },
    ]],
  };
}

function commentKeyboard(commentKey) {
  return {
    inline_keyboard: [[
      { text: '✅ Опубликовать', callback_data: `cmt_pub:${commentKey}` },
      { text: '✏️ Редактировать', callback_data: `cmt_edt:${commentKey}` },
      { text: '⏭ Пропустить',    callback_data: `cmt_skip:${commentKey}` },
    ]],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendModerationMessage(post, rawDraft) {
  const postKey = `${post.username}:${post.id}`;

  // Pre-cache all photos to disk while CDN URLs are still fresh (just scraped)
  mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
  const cachedPhotos = [];
  for (let i = 0; i < (post.mediaItems ?? []).length; i++) {
    const m = post.mediaItems[i];
    if (m.type !== 'photo') continue;
    try {
      const buf = await fetchPhotoBuffer(m.url);
      const safeKey = postKey.replace(/[^a-z0-9_]/gi, '_');
      const cachePath = join(PHOTO_CACHE_DIR, `${safeKey}-${i}.jpg`);
      writeFileSync(cachePath, buf);
      cachedPhotos.push({ idx: i, path: cachePath });
      log('info', `  photo cached: ${cachePath}`);
    } catch (e) {
      log('warn', `  photo pre-cache failed ${postKey}/${i}: ${e.message}`);
    }
  }

  pending.set(postKey, {
    post, rawDraft,
    chatId: null, msgId: null,
    isPhotoMsg: false,
    llmText: null, editedText: null,
    _cachedPhotos: cachedPhotos,
  });
  savePending(pending);

  const text = `Новость из <b>@${escapeHtml(post.username)}</b>\n\n${rawDraft}`;

  try {
    const allMedia = getAllMedia(post);
    let sent;
    let isMediaMsg = false;

    // Moderation preview uses first media only (sendMediaGroup has no reply_markup support).
    // All media are published to the channel when user clicks Опубликовать.
    const firstMedia = allMedia[0] ?? null;
    if (firstMedia && text.length <= CAPTION_LIMIT) {
      sent = await tgSendMediaMultipart(
        process.env.ADMIN_CHAT_ID,
        firstMedia.url, firstMedia.type,
        text,
        { parse_mode: 'HTML', reply_markup: rawKeyboard(postKey), _watermark: false },
      );
      isMediaMsg = true;
    } else {
      if (firstMedia) {
        await tgSendMediaMultipart(process.env.ADMIN_CHAT_ID, firstMedia.url, firstMedia.type, null, { _watermark: false })
          .catch((e) => log('warn', `media preview failed: ${e.message}`));
      }
      sent = await tg('sendMessage', {
        chat_id: process.env.ADMIN_CHAT_ID,
        text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: rawKeyboard(postKey),
      });
    }

    const item = pending.get(postKey);
    if (item) {
      item.chatId     = String(process.env.ADMIN_CHAT_ID);
      item.msgId      = sent.message_id;
      item.isMediaMsg = isMediaMsg;
      // Cache file_id for each media item so publish never hits the CDN again
      if (isMediaMsg) {
        if (sent.photo) {
          const best = sent.photo[sent.photo.length - 1];
          item._fileIds = [{ type: 'photo', fileId: best.file_id }];
        } else if (sent.video) {
          item._fileIds = [{ type: 'video', fileId: sent.video.file_id }];
        }
      }
      savePending(pending);
    }
  } catch (err) {
    log('error', `sendModerationMessage failed for ${postKey}: ${err.message}`);
    pending.delete(postKey);
    savePending(pending);
  }
}

export async function sendCommentModerationMessage(post, commentText) {
  const commentKey = `${post.username}:${post.id}`;

  pendingComments.set(commentKey, {
    post, commentText, editedText: null, chatId: null, msgId: null,
  });
  saveComments(pendingComments);

  const postLink = `https://t.me/${post.username}/${post.id}`;
  const text =
    `💬 <b>Комментарий к посту в @${escapeHtml(post.username)}</b>\n` +
    `<a href="${postLink}">→ Открыть пост</a>\n\n` +
    escapeHtml(commentText);

  try {
    const sent = await tg('sendMessage', {
      chat_id: process.env.ADMIN_CHAT_ID,
      text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: commentKeyboard(commentKey),
    });

    const item = pendingComments.get(commentKey);
    if (item) {
      item.chatId = String(process.env.ADMIN_CHAT_ID);
      item.msgId  = sent.message_id;
      saveComments(pendingComments);
    }
    markQueued(post.username);
  } catch (err) {
    log('error', `sendCommentModerationMessage failed for ${commentKey}: ${err.message}`);
    pendingComments.delete(commentKey);
    saveComments(pendingComments);
  }
}

// ─── Callback handler ─────────────────────────────────────────────────────────

async function handleCallback(query) {
  const { id: queryId, data = '', message } = query;
  const chatId = message?.chat?.id;
  const msgId  = message?.message_id;

  const colonIdx = data.indexOf(':');
  const action   = data.slice(0, colonIdx);
  const postKey  = data.slice(colonIdx + 1);

  const item = pending.get(postKey);
  const isPhoto = item?.isMediaMsg ?? false;

  const answerDone = () =>
    tg('answerCallbackQuery', { callback_query_id: queryId, text: 'Уже обработано' }).catch(() => {});

  // ── Publish raw ──────────────────────────────────────────────────────────────
  if (action === 'pub_raw') {
    if (!item) { await answerDone(); return; }
    await tg('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});
    try {
      await publishToChannel(item.rawDraft, item.post, item._cachedPhotos ?? []);
      saveHeadline(extractHeadline(item.rawDraft));
      pending.delete(postKey);
      savePending(pending);
      await clearButtons(chatId, msgId);
      await tg('sendMessage', {
        chat_id: chatId,
        text: '✅ Опубликовано!',
        reply_to_message_id: msgId,
      }).catch(() => {});
      log('info', `Published (raw): ${postKey}`);
    } catch (err) {
      log('error', `pub_raw error for ${postKey}: ${err.message}`);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `❌ Ошибка публикации:\n\n<code>${escapeHtml(err.message.slice(0, 300))}</code>`,
        parse_mode: 'HTML',
        reply_to_message_id: msgId,
      }).catch(() => {});
    }
    return;
  }

  // ── LLM triggers ─────────────────────────────────────────────────────────────
  if (action === 'llm_news') {
    if (!item) { await answerDone(); return; }

    await tg('answerCallbackQuery', { callback_query_id: queryId, text: '⏳ Генерирую...' });
    await editMsgContent(chatId, msgId, isPhoto,
      `Новость из <b>@${escapeHtml(item.post.username)}</b>\n\n⏳ Генерирую...`,
      { parse_mode: 'HTML' },
    );

    const llmText = await generateNews(item.post);

    if (!llmText) {
      await editMsgContent(chatId, msgId, isPhoto,
        `Новость из <b>@${escapeHtml(item.post.username)}</b>\n\n${item.rawDraft}`,
        { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: rawKeyboard(postKey) },
      );
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ LLM не ответил. Попробуйте ещё раз.',
        reply_to_message_id: msgId,
      }).catch(() => {});
      log('warn', `LLM failed for ${postKey}, restored raw message`);
      return;
    }

    if (llmText === 'ДУБЛЬ' || llmText.startsWith('ПРОТИВОРЕЧИЕ')) {
      await editMsgContent(chatId, msgId, isPhoto,
        `Новость из <b>@${escapeHtml(item.post.username)}</b>\n\n${item.rawDraft}`,
        { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: rawKeyboard(postKey) },
      );
      await tg('sendMessage', {
        chat_id: chatId,
        text: `⚠️ <b>${escapeHtml(llmText)}</b>\n\nLLM счёл эту новость дублём или противоречием. Можно опубликовать исходник вручную.`,
        parse_mode: 'HTML',
        reply_to_message_id: msgId,
      }).catch(() => {});
      log('warn', `LLM dedup signal for ${postKey}: ${llmText}`);
      return;
    }

    item.llmText    = llmText;
    item.editedText = null;
    savePending(pending);

    const llmDisplay = formatLlmText(llmText) + FOOTER;

    await editMsgContent(chatId, msgId, isPhoto,
      `Новость из <b>@${escapeHtml(item.post.username)}</b> — <i>переписано</i>\n\n${llmDisplay}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: llmKeyboard(postKey) },
    );
    log('info', `LLM draft ready: ${postKey}`);
    return;
  }

  // ── Custom prompt ────────────────────────────────────────────────────────────
  if (action === 'cust') {
    if (!item) { await answerDone(); return; }
    await tg('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});

    const promptMsg = await tg('sendMessage', {
      chat_id: chatId,
      text:
        '✍️ <b>Введи промт для переработки поста:</b>\n\n' +
        '<i>Например: «Сделай короче и добавь призыв к действию» или «Перепиши как инсайд от практика»</i>\n\n' +
        'Отправь текст ответом (Reply) на это сообщение.',
      parse_mode: 'HTML',
    });

    custPrompts.set(String(promptMsg.message_id), {
      postKey,
      moderationChatId: chatId,
      moderationMsgId:  msgId,
    });
    log('info', `Custom prompt requested: ${postKey}`);
    return;
  }

  // ── Publish (LLM or edited) ───────────────────────────────────────────────────
  if (action === 'pub') {
    if (!item) { await answerDone(); return; }

    let publishText;
    if (item.editedText !== null) {
      publishText = formatLlmText(item.editedText) + FOOTER;
    } else if (item.llmText !== null) {
      publishText = formatLlmText(item.llmText) + FOOTER;
    } else {
      publishText = item.rawDraft;
    }

    await tg('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});
    try {
      await publishToChannel(publishText, item.post, item._cachedPhotos ?? []);
      saveHeadline(extractHeadline(publishText));
      pending.delete(postKey);
      savePending(pending);
      await clearButtons(chatId, msgId);
      await tg('sendMessage', {
        chat_id: chatId,
        text: '✅ Опубликовано!',
        reply_to_message_id: msgId,
      }).catch(() => {});
      log('info', `Published (llm/edited): ${postKey}`);
    } catch (err) {
      log('error', `pub error for ${postKey}: ${err.message}`);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `❌ Ошибка публикации:\n\n<code>${escapeHtml(err.message.slice(0, 300))}</code>`,
        parse_mode: 'HTML',
        reply_to_message_id: msgId,
      }).catch(() => {});
    }
    return;
  }

  // ── Edit ─────────────────────────────────────────────────────────────────────
  if (action === 'edt') {
    if (!item) { await answerDone(); return; }
    await tg('answerCallbackQuery', { callback_query_id: queryId });

    const currentText = item.editedText ?? item.llmText ?? item.post.html
      .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    const promptMsg = await tg('sendMessage', {
      chat_id: chatId,
      text:
        `✏️ <b>Текущий текст:</b>\n\n${escapeHtml(currentText)}\n\n` +
        `<i>Отправь исправленный текст ответом (Reply) на это сообщение. Футер добавится автоматически.</i>`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    editPrompts.set(String(promptMsg.message_id), {
      postKey,
      moderationChatId: chatId,
      moderationMsgId: msgId,
    });
    log('info', `Edit requested: ${postKey}, prompt=${promptMsg.message_id}`);
    return;
  }

  // ── Cancel — return to stage 1 ────────────────────────────────────────────────
  if (action === 'cancel') {
    if (!item) { await answerDone(); return; }

    item.llmText    = null;
    item.editedText = null;
    savePending(pending);

    await editMsgContent(chatId, msgId, isPhoto,
      `Новость из <b>@${escapeHtml(item.post.username)}</b>\n\n${item.rawDraft}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: rawKeyboard(postKey) },
    );
    await tg('answerCallbackQuery', { callback_query_id: queryId });
    log('info', `Cancelled, restored stage 1: ${postKey}`);
    return;
  }
}

// ─── Comment callback handler ────────────────────────────────────────────────

async function handleCommentCallback(query) {
  const { id: queryId, data = '', message } = query;
  const chatId = message?.chat?.id;
  const msgId  = message?.message_id;

  const colonIdx  = data.indexOf(':');
  const action     = data.slice(0, colonIdx);
  const commentKey = data.slice(colonIdx + 1);

  const item = pendingComments.get(commentKey);

  const answerDone = () =>
    tg('answerCallbackQuery', { callback_query_id: queryId, text: 'Уже обработано' }).catch(() => {});

  // ── Publish ──────────────────────────────────────────────────────────────────
  if (action === 'cmt_pub') {
    if (!item) { await answerDone(); return; }

    if (!canPublishNow()) {
      const secs = secondsUntilPublish();
      await tg('answerCallbackQuery', {
        callback_query_id: queryId,
        text: `⏳ Подождите ещё ${secs} сек. перед следующим комментарием`,
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // Acknowledge callback once — error shown as a message, not a second answer
    await tg('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});

    const text = item.editedText ?? item.commentText;
    try {
      await sendCommentToPost(item.post.username, item.post.id, text);
      markPublished(item.post.username);
      pendingComments.delete(commentKey);
      saveComments(pendingComments);
      await clearButtons(chatId, msgId);
      log('info', `[comment] published: ${commentKey}`);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ Комментарий опубликован под @${escapeHtml(item.post.username)}/${item.post.id}`,
        reply_to_message_id: msgId,
      }).catch(() => {});
    } catch (err) {
      log('error', `[comment] publish error: ${err.message}`);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `❌ Ошибка публикации комментария:\n\n<code>${escapeHtml(err.message.slice(0, 300))}</code>`,
        parse_mode: 'HTML',
        reply_to_message_id: msgId,
      }).catch(() => {});
    }
    return;
  }

  // ── Edit ─────────────────────────────────────────────────────────────────────
  if (action === 'cmt_edt') {
    if (!item) { await answerDone(); return; }
    await tg('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});

    const currentText = item.editedText ?? item.commentText;
    const promptMsg = await tg('sendMessage', {
      chat_id: chatId,
      text:
        `✏️ <b>Текущий комментарий:</b>\n\n${escapeHtml(currentText)}\n\n` +
        `<i>Отправь исправленный текст ответом (Reply) на это сообщение.</i>`,
      parse_mode: 'HTML',
    });

    commentEditPrompts.set(String(promptMsg.message_id), {
      commentKey,
      moderationChatId: chatId,
      moderationMsgId:  msgId,
    });
    log('info', `[comment] edit requested: ${commentKey}`);
    return;
  }

  // ── Skip ─────────────────────────────────────────────────────────────────────
  if (action === 'cmt_skip') {
    pendingComments.delete(commentKey);
    saveComments(pendingComments);
    await clearButtons(chatId, msgId);
    await tg('answerCallbackQuery', { callback_query_id: queryId, text: '⏭ Пропущено' }).catch(() => {});
    log('info', `[comment] skipped: ${commentKey}`);
    return;
  }
}

// ─── Sources command handler ──────────────────────────────────────────────────

function sourcesKeyboard(sources) {
  return {
    inline_keyboard: sources.map((s) => [{
      text: `${s.active ? '✅' : '❌'} @${s.username}`,
      callback_data: `src_toggle:${s.username}`,
    }, {
      text: '🗑',
      callback_data: `src_del:${s.username}`,
    }]),
  };
}

async function handleSourcesCommand(chatId) {
  const sources = listAllSources();
  if (sources.length === 0) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Список каналов пуст. Добавь через /add @username',
    });
    return;
  }
  await tg('sendMessage', {
    chat_id: chatId,
    text: `📋 <b>Каналы для парсинга</b> (${sources.length}):\n\n✅ — активен, ❌ — выключен\nДля добавления: /add @username`,
    parse_mode: 'HTML',
    reply_markup: sourcesKeyboard(sources),
  });
}

async function handleSourceCallback(query) {
  const { id: queryId, data = '', message } = query;
  const chatId = message?.chat?.id;
  const msgId  = message?.message_id;

  if (String(chatId) !== String(process.env.ADMIN_CHAT_ID)) return;

  const colonIdx = data.indexOf(':');
  const action   = data.slice(0, colonIdx);
  const username = data.slice(colonIdx + 1);

  if (action === 'src_toggle') {
    const nowActive = toggleSource(username);
    if (nowActive === null) {
      await tg('answerCallbackQuery', { callback_query_id: queryId, text: 'Канал не найден' });
      return;
    }
    const sources = listAllSources();
    await tg('editMessageReplyMarkup', {
      chat_id: chatId, message_id: msgId,
      reply_markup: sourcesKeyboard(sources),
    }).catch(() => {});
    await tg('answerCallbackQuery', {
      callback_query_id: queryId,
      text: nowActive ? `✅ @${username} включён` : `❌ @${username} выключен`,
    });
    log('info', `Source toggled: @${username} → ${nowActive ? 'active' : 'inactive'}`);
    return;
  }

  if (action === 'src_del') {
    removeSource(username);
    const sources = listAllSources();
    if (sources.length === 0) {
      await tg('editMessageText', {
        chat_id: chatId, message_id: msgId,
        text: 'Список каналов пуст. Добавь через /add @username',
      }).catch(() => {});
    } else {
      await tg('editMessageReplyMarkup', {
        chat_id: chatId, message_id: msgId,
        reply_markup: sourcesKeyboard(sources),
      }).catch(() => {});
    }
    await tg('answerCallbackQuery', {
      callback_query_id: queryId,
      text: `🗑 @${username} удалён`,
    });
    log('info', `Source removed: @${username}`);
    return;
  }
}

// ─── Edit reply handler ───────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (String(msg.chat?.id) !== String(process.env.ADMIN_CHAT_ID)) return;

  const mainKeyboard = {
    keyboard: [
      [{ text: '📋 Каналы' }],
    ],
    resize_keyboard: true,
    persistent: true,
  };

  // /start or 🏠
  if (msg.text === '/start') {
    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '👋 <b>Мармелад Парсер</b>\n\nКоманды:\n• /sources — список каналов\n• /add @username — добавить канал\n• /last — последние 5 постов каждого канала',
      parse_mode: 'HTML',
      reply_markup: mainKeyboard,
    });
    return;
  }

  // /sources command or кнопка
  if (msg.text === '/sources' || msg.text === '📋 Каналы') {
    await handleSourcesCommand(msg.chat.id);
    return;
  }

  // /last — last 5 posts per source channel
  if (msg.text === '/last') {
    const sources = listAllSources();
    if (sources.length === 0) {
      await tg('sendMessage', { chat_id: msg.chat.id, text: 'Нет добавленных каналов.' });
      return;
    }
    await tg('sendMessage', { chat_id: msg.chat.id, text: `Загружаю последние посты из ${sources.length} каналов...` });
    for (const src of sources) {
      try {
        const { fetchNewPosts } = await import('./scraper.js');
        const posts = await fetchNewPosts(src.username, 0);
        const last5 = posts.slice(-5).reverse();
        if (last5.length === 0) {
          await tg('sendMessage', { chat_id: msg.chat.id, text: `@${src.username}: постов не найдено` });
          continue;
        }
        const lines = last5.map((p, i) => {
          const plain = p.html
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
            .slice(0, 80);
          return `${i + 1}. <a href="https://t.me/${src.username}/${p.id}">${escapeHtml(plain)}…</a>`;
        });
        const status = src.active ? '🟢' : '⚫️';
        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: `${status} <b>@${escapeHtml(src.username)}</b>\n\n${lines.join('\n')}`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (e) {
        await tg('sendMessage', { chat_id: msg.chat.id, text: `@${src.username}: ошибка — ${e.message}` });
      }
    }
    return;
  }

  // /add @username
  const addMatch = msg.text?.match(/^\/add\s+@?(\S+)/i);
  if (addMatch) {
    const username = addMatch[1].replace(/^@/, '');
    const added = addSource(username);
    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: added ? `✅ @${username} добавлен` : `⚠️ @${username} уже есть в списке`,
      reply_markup: mainKeyboard,
    });
    return;
  }

  if (!msg.reply_to_message) return;
  const promptId = String(msg.reply_to_message.message_id);

  // ── Main post edit reply ───────────────────────────────────────────────────
  const info = editPrompts.get(promptId);
  if (info) {
    const newText = msg.text?.trim();
    if (!newText) return;

    editPrompts.delete(promptId);

    const item = pending.get(info.postKey);
    if (!item) return;

    item.editedText = newText;
    savePending(pending);

    const display = formatLlmText(newText) + FOOTER;
    const isPhoto = item.isMediaMsg ?? false;

    await editMsgContent(
      info.moderationChatId,
      info.moderationMsgId,
      isPhoto,
      `Новость из <b>@${escapeHtml(item.post.username)}</b> — <i>редактировано</i>\n\n${display}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: llmKeyboard(info.postKey) },
    );

    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '✅ Текст обновлён. Нажми «Опубликовать» для публикации.',
      reply_to_message_id: msg.message_id,
    });
    log('info', `Edited text saved: ${info.postKey}`);
    return;
  }

  // ── Comment edit reply ─────────────────────────────────────────────────────
  const cInfo = commentEditPrompts.get(promptId);
  if (cInfo) {
    const newText = msg.text?.trim();
    if (!newText) return;

    commentEditPrompts.delete(promptId);

    const cItem = pendingComments.get(cInfo.commentKey);
    if (!cItem) return;

    cItem.editedText = newText;
    saveComments(pendingComments);

    const postLink = `https://t.me/${cItem.post.username}/${cItem.post.id}`;
    await tg('editMessageText', {
      chat_id: cInfo.moderationChatId,
      message_id: cInfo.moderationMsgId,
      text:
        `💬 <b>Комментарий к посту в @${escapeHtml(cItem.post.username)}</b> — <i>редактировано</i>\n` +
        `<a href="${postLink}">→ Открыть пост</a>\n\n` +
        escapeHtml(newText),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: commentKeyboard(cInfo.commentKey),
    }).catch((e) => log('error', `comment edit update: ${e.message}`));

    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '✅ Комментарий обновлён.',
      reply_to_message_id: msg.message_id,
    }).catch(() => {});
    log('info', `[comment] edited: ${cInfo.commentKey}`);
    return;
  }

  // ── Custom prompt reply ────────────────────────────────────────────────────
  const custInfo = custPrompts.get(promptId);
  if (custInfo) {
    const userPrompt = msg.text?.trim();
    if (!userPrompt) return;

    custPrompts.delete(promptId);

    const cItem = pending.get(custInfo.postKey);
    if (!cItem) return;

    const isPhoto = cItem.isMediaMsg ?? false;

    await editMsgContent(custInfo.moderationChatId, custInfo.moderationMsgId, isPhoto,
      `Новость из <b>@${escapeHtml(cItem.post.username)}</b>\n\n⏳ Генерирую по промту...`,
      { parse_mode: 'HTML' },
    );

    const result = await generateCustom(cItem.post, userPrompt);

    if (!result) {
      await editMsgContent(custInfo.moderationChatId, custInfo.moderationMsgId, isPhoto,
        `Новость из <b>@${escapeHtml(cItem.post.username)}</b>\n\n${cItem.rawDraft}`,
        { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: rawKeyboard(custInfo.postKey) },
      );
      await tg('sendMessage', {
        chat_id: msg.chat.id,
        text: '❌ LLM не ответил. Попробуйте ещё раз.',
        reply_to_message_id: msg.message_id,
      }).catch(() => {});
      return;
    }

    cItem.llmText    = result;
    cItem.editedText = null;
    savePending(pending);

    const display = formatLlmText(result) + FOOTER;
    await editMsgContent(custInfo.moderationChatId, custInfo.moderationMsgId, isPhoto,
      `Новость из <b>@${escapeHtml(cItem.post.username)}</b> — <i>промт</i>\n\n${display}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: llmKeyboard(custInfo.postKey) },
    );

    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '✅ Готово. Нажми «Опубликовать» для публикации.',
      reply_to_message_id: msg.message_id,
    }).catch(() => {});
    log('info', `Custom prompt applied: ${custInfo.postKey}`);
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

export async function startPolling() {
  if (!process.env.MODERATION_BOT_TOKEN) {
    log('warn', 'MODERATION_BOT_TOKEN not set — bot disabled');
    return;
  }

  let offset = 0;
  try {
    const old = await tg('getUpdates', { offset: -1, timeout: 0 });
    if (old.length > 0) offset = old[old.length - 1].update_id + 1;
    log('info', `Bot ready, offset=${offset}`);
  } catch (err) {
    log('warn', `Bot drain failed (${err.message}), polling from offset 0`);
  }

  // Register bot commands menu
  await tg('setMyCommands', {
    commands: [
      { command: 'start',   description: '🏠 Главное меню' },
      { command: 'sources', description: '📋 Список каналов для парсинга' },
      { command: 'add',     description: '➕ Добавить канал — /add @username' },
    ],
  }).catch(() => {});

  log('info', 'Bot polling started');

  async function poll() {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['callback_query', 'message'],
      });

      for (const upd of updates) {
        offset = upd.update_id + 1;
        if (upd.callback_query) {
          const cbData = upd.callback_query.data ?? '';
          if (cbData.startsWith('src_')) {
            await handleSourceCallback(upd.callback_query).catch((e) =>
              log('error', `src callback error: ${e.message}`)
            );
          } else if (cbData.startsWith('cmt_')) {
            await handleCommentCallback(upd.callback_query).catch((e) =>
              log('error', `comment callback error: ${e.message}`)
            );
          } else {
            await handleCallback(upd.callback_query).catch((e) =>
              log('error', `callback error: ${e.message}`)
            );
          }
        } else if (upd.message?.text) {
          await handleMessage(upd.message).catch((e) =>
            log('error', `message error: ${e.message}`)
          );
        }
      }
    } catch (err) {
      log('error', `polling error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    setImmediate(poll);
  }

  poll();
}
