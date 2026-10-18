import sharp from 'sharp';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT      = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGO_PATH = join(ROOT, 'assets', 'logo.png');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

let _fontB64 = null;
function getFontB64() {
  if (_fontB64 === null) {
    try { _fontB64 = readFileSync(FONT_PATH).toString('base64'); } catch { _fontB64 = ''; }
  }
  return _fontB64;
}
function xmlEscape(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
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
  if (!existsSync(LOGO_PATH)) { console.error('Logo not found:', LOGO_PATH); return photoBuffer; }

  // Crop portrait to 4:3 landscape
  const TARGET_RATIO = 4 / 3;
  const meta0 = await sharp(photoBuffer).metadata();
  if ((meta0.height ?? 0) > (meta0.width ?? 0)) {
    const newH = Math.round((meta0.width ?? 0) / TARGET_RATIO);
    photoBuffer = await sharp(photoBuffer)
      .resize(meta0.width, newH, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  const img = sharp(photoBuffer);
  const { width: W, height: H } = await img.metadata();

  const border   = Math.round(W * 0.028);
  const blockH   = Math.round(H * 0.33);
  const blockTop = H - blockH;
  const availW   = W - border * 2;

  const fontB64    = getFontB64();
  const fontStyle  = fontB64
    ? `@font-face{font-family:'MFont';src:url('data:font/truetype;base64,${fontB64}')}`
    : '';
  const fontFamily = fontB64 ? 'MFont, sans-serif' : 'DejaVu Sans, sans-serif';

  const brandText      = '#MRMLD';
  const brandFontSz    = Math.round(blockH * 0.36);
  const brandGapTop    = Math.round(blockH * 0.04);
  const brandBaselineY = blockTop + brandGapTop + brandFontSz;

  const titleFontSz = Math.round(blockH * 0.14);
  const titleLineH  = Math.round(titleFontSz * 1.32);
  const titleTopY   = brandBaselineY + Math.round(blockH * 0.05) + titleFontSz;
  const titleLines  = wrapLines(title, availW - Math.round(W * 0.18), titleFontSz, 3);

  const logoSz = Math.round(blockH * 0.62);
  const logoL  = W - border - logoSz;
  const logoT  = H - border - logoSz;

  const rx      = Math.round(border * 2.8);
  const innerRx = Math.max(0, rx - border);

  // Layer 1: dark overlay behind yellow block area
  const darkSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect x="0" y="${blockTop}" width="${W}" height="${blockH}" fill="rgba(0,0,0,0.40)"/>` +
    `</svg>`
  );

  // Layer 2: yellow frame + block (no text mask), then punch brand text via dest-out
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

  const brandSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    (fontStyle ? `<defs><style>${fontStyle}</style></defs>` : '') +
    `<text fill="black" x="${Math.round(W/2)}" y="${brandBaselineY}" text-anchor="middle" ` +
      `font-family="${fontFamily}" font-size="${brandFontSz}" font-weight="bold" ` +
      `textLength="${W}" lengthAdjust="spacingAndGlyphs">` +
      `${xmlEscape(brandText)}</text>` +
    `</svg>`
  );

  const yellowLayer = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([
    { input: yellowBaseSvg, blend: 'over' },
    { input: brandSvg,      blend: 'dest-out' },
  ]).png().toBuffer();

  // Layer 3: title text
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

  const logoResized = await sharp(LOGO_PATH)
    .resize(logoSz, logoSz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();

  return img.composite([
    { input: darkSvg,     blend: 'over' },
    { input: yellowLayer, blend: 'over' },
    { input: titleSvg,    blend: 'over' },
    { input: logoResized, left: logoL, top: logoT, blend: 'over' },
  ]).jpeg({ quality: 92 }).toBuffer();
}

// ── Generate test images ────────────────────────────────────────────────────

async function makeTestImage(w, h, r, g, b) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .jpeg().toBuffer();
}

// Simulated "textured" background with gradient-like noise using sharp
async function makeCheckerImage(w, h) {
  // Create two alternating colored bands to simulate a complex/busy photo
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#8B4513"/>
        <stop offset="50%" stop-color="#D2691E"/>
        <stop offset="100%" stop-color="#A0522D"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g1)"/>
    <rect x="0" y="0" width="${w/2}" height="${h/2}" fill="rgba(255,200,100,0.3)"/>
    <rect x="${w/2}" y="${h/2}" width="${w/2}" height="${h/2}" fill="rgba(0,50,100,0.4)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

const tests = [
  { name: 'test1-landscape', w: 1080, h: 720,  title: '«Перекрёсток» выпустил линейку ремесленного хлеба', bg: [20, 20, 30] },
  { name: 'test2-landscape', w: 1080, h: 720,  title: 'В Бургер Кинге появился новый фирменный соус',      bg: [240, 230, 220] },
  { name: 'test3-portrait',  w: 600,  h: 900,  title: 'В Москве открылась кофейня Norme',                   bg: [180, 130, 80] },
  { name: 'test4-portrait',  w: 600,  h: 900,  title: 'Корнер русской кухни открылся в бизнес-парке',       bg: [210, 170, 110] },
  { name: 'test5-portrait',  w: 720,  h: 1280, title: 'Из Испании: Оливки La Explanada Gourmet с игристым', bg: [200, 180, 100] },
];

for (const t of tests) {
  const base = await makeTestImage(t.w, t.h, ...t.bg);
  const out  = await applyWatermark(base, t.title);
  const path = join(ROOT, `${t.name}.jpg`);
  writeFileSync(path, out);
  console.log(`✓ ${t.name}.jpg  (title: "${t.title}")`);
}

// Bonus: busy/mixed background
const busyBase = await makeCheckerImage(1080, 720);
const busyOut  = await applyWatermark(busyBase, 'Шоколадный фондан появился в меню ресторана Pinzeria by Bontempi');
writeFileSync(join(ROOT, 'test5-busy.jpg'), busyOut);
console.log('✓ test5-busy.jpg  (mixed background)');

console.log('\nDone — download with:');
console.log('  scp root@186.246.9.147:/var/www/mrmld-parser/test*.jpg /tmp/');
