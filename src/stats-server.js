import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { listAllSources } from './sources.js';
import { log } from './logger.js';
import { getChannelStats } from './channel-stats.js';

const ROOT      = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR  = join(ROOT, 'parser-data');
const ADS_FILE  = join(DATA_DIR, 'ads.json');
const PORT      = process.env.STATS_PORT ?? 3002;
const TOKEN     = process.env.STATS_TOKEN ?? '';

// ── Ads persistence ──────────────────────────────────────────────────────────
function loadAds() {
  try { return JSON.parse(readFileSync(ADS_FILE, 'utf-8')); } catch { return []; }
}
function saveAds(ads) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ADS_FILE, JSON.stringify(ads, null, 2));
}

// ── AI analysis via OpenAI ────────────────────────────────────────────────────
async function runAiAnalysis(ads, channelMembers) {
  const { request: httpsReq } = await import('https');
  const baseUrl = (process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model   = process.env.LLM_MODEL ?? 'gpt-6.1-sol';

  const adsText = ads.length === 0
    ? 'Данных о рекламных размещениях пока нет.'
    : ads.map((a, i) => {
        const cpf = (a.cost && a.results?.newSubs) ? (a.cost / a.results.newSubs).toFixed(0) + ' ₽/подп' : 'нет данных';
        const cr  = (a.results?.reach && a.results?.newSubs) ? ((a.results.newSubs / a.results.reach) * 100).toFixed(2) + '%' : 'нет данных';
        return `${i+1}. Канал: ${a.channelName || a.channelUrl || '?'} (${a.subscribers ? a.subscribers + ' подп.' : '?'})
   Дата: ${a.date || '?'} | Тип: ${a.adType} | Стоимость: ${a.cost ? a.cost + ' ₽' : '?'}
   Результат: охват ${a.results?.reach ?? '?'}, новых подписчиков ${a.results?.newSubs ?? '?'}, кликов ${a.results?.clicks ?? '?'}, заявок ${a.results?.leads ?? '?'}
   CPF: ${cpf} | CR: ${cr}${a.notes ? '\n   Заметки: ' + a.notes : ''}`;
      }).join('\n\n');

  const prompt = `Ты — аналитик по продвижению Telegram-каналов. Анализируй рекламные кампании канала и давай конкретные рекомендации.

Канал: @mrmld_hrc (массовый канал: новинки, магазины, еда, курьёзы из ритейла)
Текущие подписчики: ${channelMembers ?? 'неизвестно'}

Данные о рекламных размещениях:
${adsText}

Проведи анализ и ответь строго в JSON-формате:
{
  "summary": "2-3 предложения о текущем состоянии рекламной стратегии",
  "good": ["что работает хорошо — конкретные пункты"],
  "bad": ["что работает плохо или вызывает вопросы — конкретные пункты"],
  "actions": ["конкретные действия которые нужно сделать в ближайшее время"],
  "whereToAdvertise": ["рекомендации где и у кого размещаться для этой ниши"],
  "benchmarks": {
    "cpf_good": "X ₽",
    "cpf_ok": "X–Y ₽",
    "cpf_bad": "больше Y ₽",
    "cr_good": "X%",
    "comment": "пояснение бенчмарков для HoReCa/ритейл каналов"
  }
}

Отвечай только JSON, без markdown-обёртки.`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${baseUrl}/chat/completions`);
    const bodyStr = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: process.env.LLM_REASONING_EFFORT ?? 'low',
      max_completion_tokens: 6000,
    });

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 60_000,
    };

    const req = httpsReq(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw  = Buffer.concat(chunks).toString('utf-8');
          const data = JSON.parse(raw);
          log('info', `[ai] status ${res.statusCode}, finish_reason: ${data.choices?.[0]?.finish_reason}, usage: ${JSON.stringify(data.usage)}`);
          if (data.error) throw new Error(`API error: ${data.error.message}`);
          let text = data.choices?.[0]?.message?.content ?? '';
          // Strip markdown code fences if present
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          if (!text) {
            log('warn', `[ai] empty content, raw: ${raw.slice(0, 300)}`);
            throw new Error('Empty response from AI');
          }
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('AI parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('AI request timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function loadPendingStats() {
  try {
    const raw     = JSON.parse(readFileSync(join(DATA_DIR, 'pending.json'), 'utf-8'));
    const entries = Object.values(raw);
    return {
      total:     entries.length,
      withPhoto: entries.filter(e => (e.post?.mediaItems ?? []).some(m => m.type === 'photo')).length,
    };
  } catch { return { total: 0, withPhoto: 0 }; }
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ru-RU');
}

function fmtGrowth(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toLocaleString('ru-RU')}`;
}

function growthColor(n) {
  if (n === null || n === undefined) return '#bbb';
  if (n > 0) return '#1a7a3c';
  if (n < 0) return '#c0392b';
  return '#777';
}

function xmlE(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderPostsTable(posts) {
  if (!posts?.length) return '';
  const rows = posts.map((p, i) => {
    const date = p.date
      ? p.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
      : '—';
    const text = xmlE(p.text.slice(0, 90)) + (p.text.length > 90 ? '…' : '');
    const medal = i === 0 ? '🥇 ' : '';
    const media = p.hasVideo ? '🎥' : p.hasPhoto ? '📷' : '';
    return `<tr${i === 0 ? ' class="top-row"' : ''}>
      <td class="date-col">${date}</td>
      <td>${medal}<a href="${p.url}" target="_blank">${text || '<em class="dim">без текста</em>'}</a> ${media}</td>
      <td class="num-col" style="font-weight:${i===0?'800':'400'}">${fmtNum(p.views)}</td>
    </tr>`;
  }).join('');
  return `<div class="section">
    <h2>Топ постов по просмотрам</h2>
    <table>
      <thead><tr><th>Дата</th><th>Текст</th><th class="num-col">Просмотры</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function html(stats, pending, sources) {
  const { members, growthDay, growthWeek, growthMonth,
          maxViews, minViews, avgViews, bestPost, posts, totalPosts } = stats;

  const activeS   = sources.filter(s => s.active).length;
  const totalS    = sources.length;
  const channelId = (process.env.APERITIV_CHANNEL_ID ?? '').replace('@', '');

  const sourceRows = sources.map(s => `
    <tr>
      <td><a href="https://t.me/${s.username}" target="_blank">@${xmlE(s.username)}</a></td>
      <td>${s.active ? '<span class="badge green">активен</span>' : '<span class="badge grey">выкл</span>'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Мармелад — панель</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; }

  /* Header */
  .header { background: #F5E401; padding: 20px 32px 0; }
  .header-top { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .header h1 { font-size: 22px; font-weight: 800; color: #2B2E30; }
  .header-sub { font-size: 13px; color: #555; }

  /* Tabs */
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 10px 20px; font-size: 14px; font-weight: 600; color: #555; cursor: pointer;
         border-radius: 10px 10px 0 0; border: none; background: rgba(0,0,0,.06);
         transition: background .15s, color .15s; }
  .tab:hover { background: rgba(0,0,0,.12); color: #2B2E30; }
  .tab.active { background: #f5f5f5; color: #2B2E30; }

  /* Content */
  .content { max-width: 960px; margin: 28px auto; padding: 0 16px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Section labels */
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: .07em; color: #bbb; margin: 24px 0 10px; }

  /* Cards */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .card { background: #fff; border-radius: 12px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  .card .val { font-size: 30px; font-weight: 800; color: #2B2E30; line-height: 1; }
  .card .val.sm { font-size: 22px; }
  .card .lbl { font-size: 12px; color: #777; margin-top: 5px; }
  .card.span-all { grid-column: 1 / -1; }

  /* Best post card */
  .best-inner { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .best-badge { font-size: 36px; font-weight: 800; color: #F5E401; background: #2B2E30;
                border-radius: 10px; padding: 10px 18px; white-space: nowrap; flex-shrink: 0; }
  .best-text { font-size: 14px; line-height: 1.55; color: #2B2E30; }
  .best-link { font-size: 12px; color: #bbb; margin-top: 5px; }

  /* Section box */
  .section { background: #fff; border-radius: 12px; padding: 22px; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 18px; }
  .section h2 { font-size: 15px; font-weight: 700; margin-bottom: 14px; color: #2B2E30; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 8px 10px; text-align: left; border-bottom: 1px solid #f0f0f0; }
  th { font-weight: 600; color: #bbb; font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  tr.top-row { background: #fffbe6; }
  .num-col { text-align: right; }
  .date-col { color: #999; white-space: nowrap; font-size: 12px; }
  .dim { color: #ccc; }

  /* Links & badges */
  a { color: #2B2E30; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge.green { background: #e6f9ee; color: #1a7a3c; }
  .badge.grey  { background: #eee; color: #777; }

  /* Ads */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px;
         border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer;
         border: none; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn-primary { background: #2B2E30; color: #F5E401; }
  .btn-danger  { background: #fee; color: #c0392b; }
  .btn-ghost   { background: #f0f0f0; color: #2B2E30; }
  .ads-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .ads-empty { text-align: center; padding: 48px; color: #ccc; font-size: 15px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #f0f0f0; color: #555; }
  .tag.post       { background: #e8f4fd; color: #1a6fa0; }
  .tag.repost     { background: #fef3e2; color: #a06010; }
  .tag.integration{ background: #f0fae8; color: #3a7a1a; }
  .tag.story      { background: #f5e8fa; color: #7a1a9a; }

  /* Modal */
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45);
              z-index: 100; align-items: center; justify-content: center; }
  .modal-bg.open { display: flex; }
  .modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 520px;
           max-height: 90vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,.18); }
  .modal h3 { font-size: 17px; font-weight: 800; color: #2B2E30; margin-bottom: 20px; }
  .form-row { margin-bottom: 14px; }
  .form-row label { display: block; font-size: 12px; font-weight: 600; color: #777;
                    text-transform: uppercase; letter-spacing: .05em; margin-bottom: 5px; }
  .form-row input, .form-row select, .form-row textarea {
    width: 100%; padding: 9px 12px; border: 1.5px solid #e8e8e8; border-radius: 8px;
    font-size: 14px; font-family: inherit; color: #1a1a1a; background: #fafafa;
    outline: none; transition: border-color .15s; }
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus { border-color: #2B2E30; background: #fff; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .form-section { font-size: 11px; font-weight: 700; text-transform: uppercase;
                  letter-spacing: .07em; color: #bbb; margin: 18px 0 10px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 22px; }

  /* Metric cards with annotation */
  .metric-card { background:#fff; border-radius:12px; padding:18px 20px 16px;
                 box-shadow:0 1px 3px rgba(0,0,0,.07); position:relative; }
  .metric-card .m-val { font-size:30px; font-weight:800; color:#2B2E30; line-height:1; }
  .metric-card .m-val.good  { color:#1a7a3c; }
  .metric-card .m-val.ok    { color:#a06010; }
  .metric-card .m-val.bad   { color:#c0392b; }
  .metric-card .m-lbl { font-size:12px; color:#777; margin-top:4px; font-weight:600; }
  .metric-card .m-hint { font-size:11px; color:#bbb; margin-top:6px; line-height:1.45;
                          border-top:1px solid #f5f5f5; padding-top:8px; margin-top:8px; }
  .metric-card .m-bench { font-size:10px; margin-top:5px; display:flex; gap:6px; flex-wrap:wrap; }
  .bench-tag { padding:2px 7px; border-radius:5px; font-weight:600; }
  .bench-g { background:#e6f9ee; color:#1a7a3c; }
  .bench-o { background:#fef3e2; color:#a06010; }
  .bench-r { background:#fee; color:#c0392b; }

  /* AI block */
  .ai-block { background:#fff; border-radius:12px; padding:24px;
              box-shadow:0 1px 3px rgba(0,0,0,.07); margin-bottom:18px; }
  .ai-block .ai-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
  .ai-block h2 { font-size:15px; font-weight:700; color:#2B2E30; }
  .ai-section { margin-bottom:14px; }
  .ai-section .ai-title { font-size:11px; font-weight:700; text-transform:uppercase;
                          letter-spacing:.07em; color:#bbb; margin-bottom:7px; }
  .ai-summary { font-size:14px; line-height:1.6; color:#2B2E30; }
  .ai-list { list-style:none; padding:0; }
  .ai-list li { font-size:13px; line-height:1.5; padding:5px 0 5px 20px; position:relative;
                border-bottom:1px solid #f5f5f5; color:#333; }
  .ai-list li:last-child { border-bottom:none; }
  .ai-list li::before { position:absolute; left:0; font-size:14px; }
  .ai-list.good li::before { content:'✓'; color:#1a7a3c; }
  .ai-list.bad  li::before { content:'✕'; color:#c0392b; }
  .ai-list.act  li::before { content:'→'; color:#2B2E30; }
  .ai-list.where li::before { content:'📍'; font-size:12px; }
  .ai-spinner { text-align:center; padding:32px; color:#bbb; font-size:14px; }
  .ai-placeholder { text-align:center; padding:32px; color:#ccc; }
  .ai-placeholder p { font-size:14px; margin-top:8px; }
  .ai-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media(max-width:600px){ .ai-grid { grid-template-columns:1fr; } }

  .updated { font-size:11px; color:#ccc; text-align:right; margin-top:20px; }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <h1>#MRMLD</h1>
    <span class="header-sub"><a href="https://t.me/${channelId}" target="_blank" style="color:#555">@${channelId}</a> · ${fmtNum(members)} подп. · ${totalPosts} постов</span>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('channel')">Статистика канала</button>
    <button class="tab" onclick="switchTab('parser')">Парсер</button>
    <button class="tab" onclick="switchTab('ads')">Реклама</button>
  </div>
</div>

<!-- ═══════════════════════════════ CHANNEL TAB ═══════════════════════════════ -->
<div id="tab-channel" class="tab-panel active">
<div class="content">

  <div class="section-title">Подписчики</div>
  <div class="grid">
    <div class="card">
      <div class="val">${fmtNum(members)}</div>
      <div class="lbl">Всего</div>
    </div>
    <div class="card">
      <div class="val sm" style="color:${growthColor(growthDay)}">${fmtGrowth(growthDay)}</div>
      <div class="lbl">За день</div>
    </div>
    <div class="card">
      <div class="val sm" style="color:${growthColor(growthWeek)}">${fmtGrowth(growthWeek)}</div>
      <div class="lbl">За неделю</div>
    </div>
    <div class="card">
      <div class="val sm" style="color:${growthColor(growthMonth)}">${fmtGrowth(growthMonth)}</div>
      <div class="lbl">За месяц</div>
    </div>
  </div>

  <div class="section-title">Просмотры постов</div>
  <div class="grid">
    <div class="card">
      <div class="val">${fmtNum(maxViews)}</div>
      <div class="lbl">Максимум</div>
    </div>
    <div class="card">
      <div class="val">${fmtNum(avgViews)}</div>
      <div class="lbl">Среднее</div>
    </div>
    <div class="card">
      <div class="val">${fmtNum(minViews)}</div>
      <div class="lbl">Минимум</div>
    </div>
    ${bestPost ? `<div class="card span-all">
      <div class="lbl" style="margin-bottom:12px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#bbb">Лучший пост</div>
      <div class="best-inner">
        <div class="best-badge">${fmtNum(bestPost.views)}</div>
        <div>
          <div class="best-text">${xmlE(bestPost.text) || '<em class="dim">без текста</em>'}</div>
          <div class="best-link"><a href="${bestPost.url}" target="_blank">${bestPost.url}</a></div>
        </div>
      </div>
    </div>` : ''}
  </div>

  ${renderPostsTable(posts)}

  <p class="updated">Обновлено: ${new Date().toLocaleString('ru-RU')}</p>
</div>
</div>

<!-- ═══════════════════════════════ PARSER TAB ════════════════════════════════ -->
<div id="tab-parser" class="tab-panel">
<div class="content">

  <div class="section-title">Очередь публикаций</div>
  <div class="grid">
    <div class="card">
      <div class="val">${pending.total}</div>
      <div class="lbl">Постов в очереди</div>
    </div>
    <div class="card">
      <div class="val">${pending.withPhoto}</div>
      <div class="lbl">С фото</div>
    </div>
    <div class="card">
      <div class="val">${activeS} / ${totalS}</div>
      <div class="lbl">Активных каналов</div>
    </div>
  </div>

  <div class="section-title" style="margin-top:28px">Каналы-источники</div>
  <div class="section">
    <table>
      <thead><tr><th>Канал</th><th>Статус</th></tr></thead>
      <tbody>${sourceRows}</tbody>
    </table>
  </div>

  <p class="updated">Обновлено: ${new Date().toLocaleString('ru-RU')}</p>
</div>
</div>

<!-- ═══════════════════════════════ ADS TAB ══════════════════════════════════ -->
<div id="tab-ads" class="tab-panel">
<div class="content">

  <!-- Metrics -->
  <div class="section-title">Ключевые метрики</div>
  <div id="metrics-grid" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-bottom:24px"></div>

  <!-- AI Analysis -->
  <div class="ai-block">
    <div class="ai-header">
      <h2>AI-анализ рекламных кампаний</h2>
      <button class="btn btn-primary" id="btn-analyze" onclick="runAnalysis()">✦ Запустить анализ</button>
    </div>
    <div id="ai-result">
      <div class="ai-placeholder">
        <div style="font-size:32px">✦</div>
        <p>Нажми «Запустить анализ» — GPT разберёт кампании, оценит метрики и скажет что улучшить</p>
      </div>
    </div>
  </div>

  <!-- Table -->
  <div class="ads-toolbar">
    <div style="font-size:13px;color:#999" id="ads-summary"></div>
    <button class="btn btn-primary" onclick="openModal()">+ Добавить рекламу</button>
  </div>
  <div class="section" style="padding:0;overflow:hidden">
    <div id="ads-table-wrap"></div>
  </div>
  <p class="updated" id="ads-updated"></p>
</div>
</div>

<!-- Modal -->
<div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h3 id="modal-title">Добавить рекламу</h3>
    <input type="hidden" id="edit-id">

    <div class="form-row">
      <label>Ссылка на канал</label>
      <input type="text" id="f-url" placeholder="https://t.me/channel или @channel">
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>Название канала</label>
        <input type="text" id="f-name" placeholder="Channel Name">
      </div>
      <div class="form-row">
        <label>Подписчиков (на момент)</label>
        <input type="number" id="f-subs" placeholder="50000">
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>Дата размещения</label>
        <input type="date" id="f-date">
      </div>
      <div class="form-row">
        <label>Тип рекламы</label>
        <select id="f-type">
          <option value="post">Пост</option>
          <option value="repost">Репост</option>
          <option value="integration">Интеграция</option>
          <option value="story">Сторис</option>
          <option value="other">Другое</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <label>Стоимость (₽)</label>
      <input type="number" id="f-cost" placeholder="5000">
    </div>

    <div class="form-section">Результаты</div>
    <div class="form-grid">
      <div class="form-row">
        <label>Охват / просмотры</label>
        <input type="number" id="f-reach" placeholder="1500">
      </div>
      <div class="form-row">
        <label>Новых подписчиков</label>
        <input type="number" id="f-new-subs" placeholder="25">
      </div>
      <div class="form-row">
        <label>Переходов / кликов</label>
        <input type="number" id="f-clicks" placeholder="200">
      </div>
      <div class="form-row">
        <label>Заявок / лидов</label>
        <input type="number" id="f-leads" placeholder="10">
      </div>
    </div>
    <div class="form-row">
      <label>Комментарий</label>
      <textarea id="f-notes" rows="2" placeholder="Любые заметки…"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Отмена</button>
      <button class="btn btn-danger" id="btn-delete" onclick="deleteAd()" style="display:none">Удалить</button>
      <button class="btn btn-primary" onclick="saveAd()">Сохранить</button>
    </div>
  </div>
</div>

<script>
// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  history.replaceState(null, '', location.pathname + '?token=${TOKEN}&tab=' + name);
  if (name === 'ads') loadAds();
}
const urlTab = new URLSearchParams(location.search).get('tab');
if (urlTab) {
  const btn = [...document.querySelectorAll('.tab')].find(t => t.getAttribute('onclick')?.includes("'" + urlTab + "'"));
  if (btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + urlTab)?.classList.add('active');
    btn.classList.add('active');
    if (urlTab === 'ads') loadAds();
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const API = '/api/ads?token=${TOKEN}';
const TYPE_LABELS = { post:'Пост', repost:'Репост', integration:'Интеграция', story:'Сторис', other:'Другое' };
function fmt(n) { return (n != null && n !== '') ? Number(n).toLocaleString('ru-RU') : '—'; }
function pct(a, b) { return (a && b) ? ((a/b)*100).toFixed(1)+'%' : null; }
function cpf(cost, subs) { return (cost && subs) ? (cost/subs).toFixed(0) : null; }

// ── Metrics section ───────────────────────────────────────────────────────────
const METRICS_DEF = [
  {
    id: 'total_cost',
    label: 'Суммарный бюджет',
    hint: 'Общая сумма, потраченная на все рекламные размещения за всё время.',
    unit: '₽',
    bench: null,
    calc: ads => ads.reduce((s,a) => s + (Number(a.cost)||0), 0) || null,
    fmt: v => fmt(v) + ' ₽',
    scoreClass: () => '',
  },
  {
    id: 'avg_cpf',
    label: 'Средний CPF',
    hint: 'Cost Per Follower — сколько рублей стоит привлечение одного подписчика. Главная метрика эффективности рекламы в Telegram.',
    bench: [
      { label: 'Хорошо: до 80 ₽', cls: 'bench-g' },
      { label: 'Норма: 80–150 ₽', cls: 'bench-o' },
      { label: 'Дорого: >150 ₽',  cls: 'bench-r' },
    ],
    calc: ads => {
      const valid = ads.filter(a => a.cost && a.results?.newSubs);
      if (!valid.length) return null;
      const total = valid.reduce((s,a) => s + a.cost/a.results.newSubs, 0);
      return Math.round(total / valid.length);
    },
    fmt: v => fmt(v) + ' ₽',
    scoreClass: v => v < 80 ? 'good' : v < 150 ? 'ok' : 'bad',
  },
  {
    id: 'avg_cr',
    label: 'Средняя конверсия',
    hint: 'CR (Conversion Rate) — процент людей, которые увидели рекламу и подписались. Считается: новые подписчики ÷ охват × 100%. Норма для тематических каналов — 1–3%.',
    bench: [
      { label: 'Хорошо: >3%',   cls: 'bench-g' },
      { label: 'Норма: 1–3%',   cls: 'bench-o' },
      { label: 'Слабо: <1%',    cls: 'bench-r' },
    ],
    calc: ads => {
      const valid = ads.filter(a => a.results?.reach && a.results?.newSubs);
      if (!valid.length) return null;
      const sum = valid.reduce((s,a) => s + (a.results.newSubs/a.results.reach)*100, 0);
      return (sum/valid.length).toFixed(2);
    },
    fmt: v => v + '%',
    scoreClass: v => v > 3 ? 'good' : v >= 1 ? 'ok' : 'bad',
  },
  {
    id: 'avg_ctr',
    label: 'Средний CTR',
    hint: 'Click-Through Rate — процент людей, кликнувших по ссылке в рекламном посте. Показывает насколько цепляет текст и оффер. Норма для Telegram — 2–5%.',
    bench: [
      { label: 'Хорошо: >5%',  cls: 'bench-g' },
      { label: 'Норма: 2–5%',  cls: 'bench-o' },
      { label: 'Слабо: <2%',   cls: 'bench-r' },
    ],
    calc: ads => {
      const valid = ads.filter(a => a.results?.reach && a.results?.clicks);
      if (!valid.length) return null;
      const sum = valid.reduce((s,a) => s + (a.results.clicks/a.results.reach)*100, 0);
      return (sum/valid.length).toFixed(1);
    },
    fmt: v => v + '%',
    scoreClass: v => v > 5 ? 'good' : v >= 2 ? 'ok' : 'bad',
  },
  {
    id: 'total_subs',
    label: 'Всего привлечено',
    hint: 'Суммарное количество новых подписчиков, привлечённых через все рекламные размещения.',
    bench: null,
    calc: ads => ads.reduce((s,a) => s + (Number(a.results?.newSubs)||0), 0) || null,
    fmt: v => '+' + fmt(v) + ' подп.',
    scoreClass: () => '',
  },
  {
    id: 'best_cpf',
    label: 'Лучший CPF',
    hint: 'Самый низкий CPF среди всех кампаний — показывает, какое размещение обошлось дешевле всего на одного подписчика.',
    bench: null,
    calc: ads => {
      const v = ads.filter(a => a.cost && a.results?.newSubs).map(a => a.cost/a.results.newSubs);
      return v.length ? Math.round(Math.min(...v)) : null;
    },
    fmt: v => fmt(v) + ' ₽',
    scoreClass: v => v < 80 ? 'good' : v < 150 ? 'ok' : 'bad',
  },
];

function renderMetrics(ads) {
  const grid = document.getElementById('metrics-grid');
  if (!ads.length) {
    grid.innerHTML = '<div style="color:#ccc;font-size:13px;padding:16px 0">Добавь первое размещение, чтобы увидеть метрики</div>';
    return;
  }
  grid.innerHTML = METRICS_DEF.map(m => {
    const val = m.calc(ads);
    const cls = val != null ? m.scoreClass(val) : '';
    const display = val != null ? m.fmt(val) : '—';
    const benches = (m.bench||[]).map(b => \`<span class="bench-tag \${b.cls}">\${b.label}</span>\`).join('');
    return \`<div class="metric-card">
      <div class="m-val \${cls}">\${display}</div>
      <div class="m-lbl">\${m.label}</div>
      <div class="m-hint">\${m.hint}\${benches ? '<div class="m-bench">'+benches+'</div>' : ''}</div>
    </div>\`;
  }).join('');
}

// ── AI Analysis ───────────────────────────────────────────────────────────────
async function runAnalysis() {
  const btn = document.getElementById('btn-analyze');
  const box = document.getElementById('ai-result');
  btn.disabled = true;
  btn.textContent = '⏳ Анализирую…';
  box.innerHTML = '<div class="ai-spinner">GPT анализирует кампании — обычно 10–20 секунд…</div>';

  // Pass current subscriber count for context
  const membersEl = document.querySelector('#tab-channel .val');
  const members = membersEl ? membersEl.textContent.replace(/\s/g,'') : null;

  try {
    const r = await fetch('/api/ads/analyze?token=${TOKEN}', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ members }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    renderAiResult(data);
  } catch(e) {
    box.innerHTML = \`<div class="ai-placeholder" style="color:#c0392b"><p>\${e.message}</p></div>\`;
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Обновить анализ';
  }
}

function esc(s) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderAiResult(d) {
  const box = document.getElementById('ai-result');
  const list = (items, cls) => items?.length
    ? \`<ul class="ai-list \${cls}">\${items.map(i=>\`<li>\${esc(i)}</li>\`).join('')}</ul>\`
    : '<p style="color:#ccc;font-size:13px">Нет данных</p>';

  const bench = d.benchmarks ? \`
    <div class="ai-section" style="margin-top:16px">
      <div class="ai-title">Ориентиры для вашей ниши (HoReCa / ритейл)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="bench-tag bench-g">CPF хорошо: \${esc(d.benchmarks.cpf_good)}</span>
        <span class="bench-tag bench-o">CPF норма: \${esc(d.benchmarks.cpf_ok)}</span>
        <span class="bench-tag bench-r">CPF дорого: \${esc(d.benchmarks.cpf_bad)}</span>
        <span class="bench-tag bench-g">CR хорошо: \${esc(d.benchmarks.cr_good)}</span>
      </div>
      <div style="font-size:12px;color:#999">\${esc(d.benchmarks.comment||'')}</div>
    </div>\` : '';

  box.innerHTML = \`
    <div class="ai-section">
      <div class="ai-title">Общая оценка</div>
      <div class="ai-summary">\${esc(d.summary)}</div>
    </div>
    <div class="ai-grid">
      <div class="ai-section">
        <div class="ai-title" style="color:#1a7a3c">Что работает</div>
        \${list(d.good,'good')}
      </div>
      <div class="ai-section">
        <div class="ai-title" style="color:#c0392b">Что не работает / под вопросом</div>
        \${list(d.bad,'bad')}
      </div>
    </div>
    <div class="ai-section">
      <div class="ai-title">Конкретные действия</div>
      \${list(d.actions,'act')}
    </div>
    <div class="ai-section">
      <div class="ai-title">Где рекламироваться</div>
      \${list(d.whereToAdvertise,'where')}
    </div>
    \${bench}
  \`;
}

// ── Ads table ─────────────────────────────────────────────────────────────────
async function loadAds() {
  const r   = await fetch(API);
  const ads = await r.json();

  renderMetrics(ads);

  const wrap = document.getElementById('ads-table-wrap');
  const sum  = document.getElementById('ads-summary');
  const upd  = document.getElementById('ads-updated');

  const totalCost = ads.reduce((s,a) => s + (Number(a.cost)||0), 0);
  const totalSubs = ads.reduce((s,a) => s + (Number(a.results?.newSubs)||0), 0);
  sum.textContent = ads.length
    ? \`\${ads.length} размещений · \${fmt(totalCost)} ₽ · +\${fmt(totalSubs)} подписчиков\`
    : '';
  upd.textContent = 'Обновлено: ' + new Date().toLocaleString('ru-RU');

  if (!ads.length) {
    wrap.innerHTML = '<div class="ads-empty">Нет записей о рекламе. Добавьте первое размещение.</div>';
    return;
  }

  const rows = ads.map(a => {
    const typeTag = \`<span class="tag \${a.adType}">\${TYPE_LABELS[a.adType] ?? a.adType}</span>\`;
    const link = a.channelUrl
      ? \`<a href="\${a.channelUrl}" target="_blank">\${esc(a.channelName || a.channelUrl)}</a>\`
      : esc(a.channelName || '—');
    const cpfVal = cpf(a.cost, a.results?.newSubs);
    const crVal  = pct(a.results?.newSubs, a.results?.reach);
    const cpfCls = cpfVal ? (cpfVal<80?'color:#1a7a3c':cpfVal<150?'color:#a06010':'color:#c0392b') : '';
    return \`<tr onclick="editAd('\${a.id}')" style="cursor:pointer">
      <td class="date-col">\${a.date ? new Date(a.date).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'2-digit'}) : '—'}</td>
      <td>\${link}<br><span style="font-size:11px;color:#bbb">\${fmt(a.subscribers)} подп.</span></td>
      <td>\${typeTag}</td>
      <td class="num-col">\${a.cost ? fmt(a.cost)+' ₽' : '—'}</td>
      <td class="num-col">\${fmt(a.results?.reach)}</td>
      <td class="num-col" style="font-weight:700;color:\${a.results?.newSubs>0?'#1a7a3c':'inherit'}">\${a.results?.newSubs!=null?'+'+fmt(a.results.newSubs):'—'}</td>
      <td class="num-col">\${crVal ?? '—'}</td>
      <td class="num-col" style="\${cpfCls};font-weight:600">\${cpfVal ? cpfVal+' ₽' : '—'}</td>
    </tr>\`;
  }).join('');

  wrap.innerHTML = \`<table>
    <thead><tr>
      <th>Дата</th><th>Канал</th><th>Тип</th>
      <th class="num-col">Бюджет</th>
      <th class="num-col">Охват</th>
      <th class="num-col">+Подп.</th>
      <th class="num-col">CR</th>
      <th class="num-col">CPF</th>
    </tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(ad) {
  const editing = !!ad;
  document.getElementById('modal-title').textContent = editing ? 'Редактировать рекламу' : 'Добавить рекламу';
  document.getElementById('edit-id').value       = ad?.id ?? '';
  document.getElementById('f-url').value          = ad?.channelUrl ?? '';
  document.getElementById('f-name').value         = ad?.channelName ?? '';
  document.getElementById('f-subs').value         = ad?.subscribers ?? '';
  document.getElementById('f-date').value         = ad?.date ?? new Date().toISOString().slice(0,10);
  document.getElementById('f-type').value         = ad?.adType ?? 'post';
  document.getElementById('f-cost').value         = ad?.cost ?? '';
  document.getElementById('f-reach').value        = ad?.results?.reach ?? '';
  document.getElementById('f-new-subs').value     = ad?.results?.newSubs ?? '';
  document.getElementById('f-clicks').value       = ad?.results?.clicks ?? '';
  document.getElementById('f-leads').value        = ad?.results?.leads ?? '';
  document.getElementById('f-notes').value        = ad?.notes ?? '';
  document.getElementById('btn-delete').style.display = editing ? 'inline-flex' : 'none';
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }

async function editAd(id) {
  const r = await fetch(API);
  const ad = (await r.json()).find(a => a.id === id);
  if (ad) openModal(ad);
}

function getFormData() {
  const num = id => { const v = document.getElementById(id).value; return v !== '' ? Number(v) : null; };
  return {
    channelUrl:  document.getElementById('f-url').value.trim(),
    channelName: document.getElementById('f-name').value.trim(),
    subscribers: num('f-subs'),
    date:        document.getElementById('f-date').value,
    adType:      document.getElementById('f-type').value,
    cost:        num('f-cost'),
    results: { reach: num('f-reach'), newSubs: num('f-new-subs'), clicks: num('f-clicks'), leads: num('f-leads') },
    notes:       document.getElementById('f-notes').value.trim(),
  };
}

async function saveAd() {
  const id = document.getElementById('edit-id').value;
  const method = id ? 'PUT' : 'POST';
  const url    = id ? \`/api/ads/\${id}?token=${TOKEN}\` : API;
  await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) });
  closeModal(); loadAds();
}

async function deleteAd() {
  const id = document.getElementById('edit-id').value;
  if (!id || !confirm('Удалить эту запись?')) return;
  await fetch(\`/api/ads/\${id}?token=${TOKEN}\`, { method: 'DELETE' });
  closeModal(); loadAds();
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
</script>
</body>
</html>`;
}

export function startStatsServer() {
  if (!TOKEN) {
    log('warn', '[stats] STATS_TOKEN not set — stats server disabled');
    return;
  }

  const server = createServer(async (req, res) => {
    const url   = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get('token') ?? '';

    if (token !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    const json = (data, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const body = () => new Promise(resolve => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')));
    });

    // ── AI analysis ──────────────────────────────────────────────────────────
    if (url.pathname === '/api/ads/analyze' && req.method === 'POST') {
      try {
        const ads     = loadAds();
        const members = (await body()).members ?? null;
        const result  = await runAiAnalysis(ads, members);
        return json(result);
      } catch (e) {
        log('error', `[stats] AI analysis error: ${e.message}`);
        return json({ error: e.message }, 500);
      }
    }

    // ── Ads API ──────────────────────────────────────────────────────────────
    if (url.pathname === '/api/ads') {
      if (req.method === 'GET')  { return json(loadAds()); }
      if (req.method === 'POST') {
        const ads  = loadAds();
        const data = await body();
        ads.unshift({ id: randomUUID(), createdAt: new Date().toISOString(), ...data });
        saveAds(ads);
        return json({ ok: true });
      }
    }
    const adMatch = url.pathname.match(/^\/api\/ads\/([^/]+)$/);
    if (adMatch) {
      const id  = adMatch[1];
      const ads = loadAds();
      const idx = ads.findIndex(a => a.id === id);
      if (req.method === 'PUT') {
        if (idx === -1) return json({ error: 'not found' }, 404);
        ads[idx] = { ...ads[idx], ...await body() };
        saveAds(ads);
        return json({ ok: true });
      }
      if (req.method === 'DELETE') {
        if (idx === -1) return json({ error: 'not found' }, 404);
        ads.splice(idx, 1);
        saveAds(ads);
        return json({ ok: true });
      }
    }

    // ── Main HTML page ───────────────────────────────────────────────────────
    try {
      const [stats, sources] = await Promise.all([
        getChannelStats(),
        Promise.resolve(listAllSources()),
      ]);
      const pending = loadPendingStats();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html(stats, pending, sources));
    } catch (err) {
      log('error', `[stats] render error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
    }
  });

  server.listen(PORT, () => {
    log('info', `[stats] server running on port ${PORT}`);
    log('info', `[stats] URL: http://186.246.9.147:${PORT}/?token=${TOKEN}`);
  });
}
