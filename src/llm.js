import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { Agent } from 'undici';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'parser-data');
const HEADLINES_FILE = join(DATA_DIR, 'published-headlines.json');

export function loadRecentHeadlines() {
  try { return JSON.parse(readFileSync(HEADLINES_FILE, 'utf-8')); } catch { return []; }
}

export function saveHeadline(headline) {
  if (!headline) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const list = loadRecentHeadlines();
  list.push({ headline, ts: new Date().toISOString() });
  if (list.length > 50) list.splice(0, list.length - 50);
  try { writeFileSync(HEADLINES_FILE, JSON.stringify(list)); } catch {}
}

function buildNewsSystem(recentHeadlines) {
  const headlineList = recentHeadlines.length
    ? recentHeadlines.slice(-30).map((h) => `• ${h.headline}`).join('\n')
    : '(пока нет опубликованных постов)';

  return `Ты — редактор новостного Telegram-канала «Мармелад» про еду, ритейл и общепит. Перепиши новость по правилам ниже.

ФОРМАТ:
{эмодзи} {Заголовок}

{Текст: 3–4 предложения}

ЗАГОЛОВОК:
- Это сама новость одной фразой, а не тема: «Twix выпустил мороженое со вкусом имбирного печенья», а не «Новинка от Twix»
- Не длиннее 12 слов — он также размещается на фото
- Один эмодзи в начале по смыслу: ⚠️ инциденты и скандалы, 📈📉 цифры и рынок, 🛒 магазины, 🍔🍕☕ еда и напитки, 🆕 открытия, 🚪 закрытия

ТЕКСТ:
- 3–4 предложения: детали, цифры, контекст — то, чего нет в заголовке
- Только факты, без личных оценок и мнений редакции
- Переписывай своими словами, не копируй фразы источника
- Допустима одна короткая ироничная фраза в конце, если новость лёгкая (новинки, курьёзы). В серьёзных новостях — инциденты, отравления, увольнения, суды — без шуток

КОРОТКИЕ НОВОСТИ:
- Если источник короткий, раскрой подробнее то, что в нём уже есть: что за продукт, где продаётся, сколько стоит, с какого числа — только если эти данные есть в источнике
- КАТЕГОРИЧЕСКИ НЕЛЬЗЯ придумывать факты, цифры, даты, цены, места продаж и цитаты, которых нет в источнике
- Если фактов мало — напиши 2 предложения. Короткий честный пост лучше длинного с выдумкой

ЦИТАТЫ:
- Прямую речь используй только дословно из источника

УДАЛЯТЬ ВСЕГДА:
- Благодарности и упоминания авторов: «спасибо подписчику», «прислал читатель», «фото: …», «через @бот»
- Упоминания и метки источника: @каналы, подписи других каналов, ссылки
- Призывы подписаться, пометки «Реклама», erid, хештеги

НАПИСАНИЕ БРЕНДОВ:
- Пиши название так, как его пишет сама компания в России: «Бургер Кинг», а не Burger King; KFC, а не «КФС»
- Русские названия — в кавычках-ёлочках: «Пятёрочка», «Самокат», «Сибирская коллекция»
- Латинские названия — без кавычек, как есть: KFC, Subway, Red Bull, Twix, Lay's, Wildberries, Ozon
- Названия продуктов и вкусов — в кавычках: энергетик «Болотная вода», пицца «Дзинки»
- Не переводи и не транслитерируй название сам. Если не уверен, как правильно, — оставь написание из источника
- Один и тот же бренд во всех постах пиши одинаково

Частые бренды (писать строго так):
«Вкусно — и точка», «Додо Пицца», «Бургер Кинг», «Пятёрочка», «Перекрёсток», «ВкусВилл», «Самокат», «Яндекс Лавка», «Магнит», «Лента», «Ашан», X5, KFC

ПРОВЕРКА НА ПОВТОРЫ:
Последние опубликованные заголовки канала:
${headlineList}
Если новость уже была — ответь строго одним словом: ДУБЛЬ
Если новость противоречит ранее опубликованному — ответь: ПРОТИВОРЕЧИЕ: (короткое объяснение)

Формат ответа — чистый текст, без HTML-разметки.`;
}

const SYSTEM_COMMENT = `Ты — управляющий партнёр ресторанной группы с 12-летним опытом в HoReCa.
Напиши короткий комментарий (1–3 предложения) к этой новости для публикации под постом в Telegram.
Добавь реальную ценность: конкретное наблюдение, уточнение или практический нюанс.
Пиши от первого лица, коротко и по делу. Без заголовков, без хэштегов. Не упоминай свой канал или бренд.
Чистый текст, без HTML-разметки.`;

const SYSTEM_OPINION = `Ты — управляющий партнёр ресторанной группы с 12-летним опытом в HoReCa.
Используй приведённую новость как повод для личного комментария от первого лица. Не пересказывай новость — выскажи мнение практика: что это значит для рынка, как ты к этому относишься, что советуешь делать прямо сейчас.

Структура ответа:
— первая строка: короткий заголовок (3–6 слов)
— пустая строка
— основной текст от первого лица

Без маркированных списков, без хэштегов. Чистый текст, без HTML-разметки.`;

function toPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function getApiConfig() {
  const apiKey  = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  const apiBase = process.env.OPENROUTER_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : (process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1');
  const defaultModel = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o-mini' : 'gpt-6-luna';
  const model   = process.env.LLM_MODEL ?? defaultModel;
  const fetchOpts = process.env.OPENAI_API_BASE
    ? { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }
    : {};
  return { apiKey, apiBase, model, fetchOpts };
}

async function chatComplete(system, user, maxTokens = 1000) {
  const { apiKey, apiBase, model, fetchOpts } = getApiConfig();
  if (!apiKey) throw new Error('No API key configured');

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
    ...fetchOpts,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function generateNews(post) {
  try {
    const system = buildNewsSystem(loadRecentHeadlines());
    const result = await chatComplete(system, `Исходный текст:\n${toPlainText(post.html)}`);
    // Return null on dedup signals so caller can skip silently
    if (!result) return null;
    const trimmed = result.trim();
    if (trimmed === 'ДУБЛЬ' || trimmed.startsWith('ПРОТИВОРЕЧИЕ')) return trimmed;
    return trimmed;
  } catch (err) {
    log('error', `generateNews failed for ${post.url}: ${err.message}`);
    return null;
  }
}

export async function generateOpinion(post) {
  try {
    return await chatComplete(SYSTEM_OPINION, `Текст поста:\n${toPlainText(post.html)}`);
  } catch (err) {
    log('error', `generateOpinion failed for ${post.url}: ${err.message}`);
    return null;
  }
}

export async function generateCustom(post, userPrompt) {
  const system = `Ты редактор Telegram-канала «Мармелад» — канала для владельцев и управляющих кафе, кофеен, ресторанов.
Выполни инструкцию пользователя применительно к тексту поста. Верни только готовый текст.

Структура ответа:
— первая строка: короткий заголовок (3–6 слов)
— пустая строка
— основной текст

Без маркированных списков, без хэштегов. Чистый текст, без HTML-разметки.`;

  try {
    return await chatComplete(
      system,
      `Инструкция: ${userPrompt}\n\nТекст поста:\n${toPlainText(post.html)}`,
    );
  } catch (err) {
    log('error', `generateCustom failed for ${post.url}: ${err.message}`);
    return null;
  }
}

export async function generateComment(post) {
  try {
    return await chatComplete(SYSTEM_COMMENT, `Текст поста:\n${toPlainText(post.html)}`, 300);
  } catch (err) {
    log('error', `generateComment failed for ${post.url}: ${err.message}`);
    return null;
  }
}
