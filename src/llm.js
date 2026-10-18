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

const ENDINGS_FILE = join(DATA_DIR, 'recent-endings.json');

function loadRecentEndings() {
  try { return JSON.parse(readFileSync(ENDINGS_FILE, 'utf-8')); } catch { return []; }
}

// Запоминаем последние концовки, чтобы модель не повторялась
function saveEnding(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return;
  const last = lines[lines.length - 1];
  if (last.length > 80) return; // длинная последняя строка — это не концовка, а текст
  mkdirSync(DATA_DIR, { recursive: true });
  const list = loadRecentEndings();
  list.push(last);
  if (list.length > 15) list.splice(0, list.length - 15);
  try { writeFileSync(ENDINGS_FILE, JSON.stringify(list)); } catch {}
}

const STYLE_RULES = `КАК ПИШЕМ:
Пост — это живая короткая новость, как будто рассказываешь другу. НИКАКИХ отдельных заголовков, жирных строк и эмодзи в начале.

Структура:
{Первое предложение — сама новость}
{0–2 предложения деталей}

{Концовка — отдельной строкой}

ПЕРВОЕ ПРЕДЛОЖЕНИЕ — главное:
- Начинай с самого цепляющего: странный вкус, цена, абсурд, масштаб. Часто — с самого предмета, а глагол после него: «Чипсы со вкусом селёдки под шубой завезли в Перекрёсток»
- Через тире можно добавить уточнение: «…нашли в Самокате — пачка стоит 189 рублей»
- Чередуй начала, не строй все посты одинаково. Варианты:
  • предмет → глагол → где: «Энергетик со вкусом розы завезли в Самокат»
  • бренд → глагол → что: «Добрый выпустил колу без сахара и кофеина»
  • цифра или цена первой: «За 600 тысяч рублей продают десерт в московском ресторане»
  • прямая цитата из источника первой, если она яркая: «Все слышат, ты не слышишь?» — …
  • для курьёзов иногда «Ор:» или «POV:» в начале — не чаще одного раза из десяти
- Одно ключевое слово можно выделить КАПСОМ (вкус, предмет, главная деталь): «Мороженое со вкусом ЧАК-ЧАКА…». Не в каждом посте, примерно в каждом третьем, и только одно слово
- Глаголы живые и разные: завезли, выкатил, дропнул, нашли, выпустил, запустил, появился, отыскали, тестирует. Не повторяй один глагол подряд

ДЕТАЛИ:
- Только то, что нужно читателю: где купить, сколько стоит, когда появится, из чего
- Разговорные слова уместны: энергос, лимитка, новинка, хрустелки, коллаба, маркетплейсы
- Если фактов мало — достаточно одного первого предложения и концовки. Не растягивай
- Весь пост — обычно 25–60 слов

КОНЦОВКА — отдельной строкой, 2–6 слов, своя шутка или реакция:
Выбирай тип, который подходит новости, и меняй типы от поста к посту:
  • обращение к тем, кому это интересно + действие: «Сладкоежки, на выход.» / «Зожники, это вам.»
  • короткий вердикт: «Выглядит проклято.» / «Сильный ход.»
  • ироничное следствие: «Диета откладывается до весны.» / «Кошелёк, держись.»
  • каламбур или словечко от названия продукта или бренда
  • отсылка к мему или поп-культуре, если она очевидна массовому читателю
  • короткий вопрос к читателю: «Кто уже пробовал?»
- НЕ бери шутку или концовку из исходного поста — придумай свою
- Без шаблонов-паразитов: не начинай с «Кажется», «Похоже», «Что ж», «Интересно»
- Не больше одного эмодзи в концовке, и только если он сам по себе шутка

СЕРЬЁЗНЫЕ НОВОСТИ (сбои сервисов, мошенники, отравления, суды, законы, налоги, увольнения, ЧП):
- Без шуток и без концовки. Факт, детали, всё
- Для срочного сбоя или важного закона можно поставить ⚡️ в начале
- Если в новости список мер или изменений — дай его строками через «—», каждый пункт коротко

ФАКТЫ — строго:
- КАТЕГОРИЧЕСКИ НЕЛЬЗЯ придумывать факты, цифры, даты, цены, места продаж и цитаты, которых нет в источнике
- Прямая речь — только дословно из источника
- Переписывай своими словами, не копируй фразы источника

УДАЛЯТЬ ВСЕГДА:
- Благодарности и упоминания авторов: «спасибо подписчику», «прислал читатель», «фото: …», «через @бот»
- Упоминания и метки источника: @каналы, подписи других каналов, ссылки
- Призывы подписаться, пометки «Реклама», erid, хештеги

НАЗВАНИЯ:
- Магазины, сервисы и бренды — без кавычек: Самокат, Пятёрочка, Перекрёсток, ВкусВилл, Яндекс Лавка, Магнит, Лента, Ашан, Додо Пицца, Бургер Кинг, Вкусно — и точка, Rostic's, KFC, Wildberries, Ozon, X5
- Названия конкретных продуктов и вкусов — в кавычках-ёлочках: энергетик «Болотная вода», эскимо «Сладобон»
- Не переводи и не транслитерируй название сам. Если не уверен — оставь как в источнике
- Один и тот же бренд во всех постах пиши одинаково`;

const STYLE_EXAMPLES = `ПРИМЕРЫ НУЖНОГО ТОНА (не копируй их, это ориентир):

Голубой KitKat со вкусом САХАРНОЙ ВАТЫ появился на маркетплейсах — лимитку выпустили в Бразилии, за батончик просят 600 рублей.

Детство подорожало.

---

Онигири из перловки с треской и креветкой нашли в российском магазине.

Япония, мы вас догнали.

---

Добрый выпустил колу без сахара, кофеина и калорий — бутылки уже стоят на полках, а в Самокате новинку видно, но заказать пока нельзя.

Зожники, ждём отмашку.

---

Додо Пицца легла целиком — не работают ни сайт, ни приложение, ни кассы в самих пиццериях. В компании говорят, что уже чинят.`;

function buildNewsSystem(recentHeadlines, recentEndings = []) {
  const headlineList = recentHeadlines.length
    ? recentHeadlines.slice(-30).map((h) => `• ${h.headline}`).join('\n')
    : '(пока нет опубликованных постов)';

  const endingList = recentEndings.length
    ? recentEndings.slice(-10).map((e) => `• ${e}`).join('\n')
    : '(пока нет)';

  return `Ты — редактор массового Telegram-канала «Мармелад» про новинки, магазины, еду и всё, что обсуждают покупатели. Читатель — обычный человек, не специалист. Цель — чтобы пост хотелось переслать другу.

Перепиши новость по правилам ниже.

${STYLE_RULES}

${STYLE_EXAMPLES}

ПОСЛЕДНИЕ КОНЦОВКИ КАНАЛА — не повторяй ни их, ни их конструкцию:
${endingList}

ПРОВЕРКА НА ПОВТОРЫ:
Начала последних опубликованных постов:
${headlineList}
Если новость уже была — ответь строго одним словом: ДУБЛЬ
Если новость противоречит ранее опубликованному — ответь: ПРОТИВОРЕЧИЕ: (короткое объяснение)

Формат ответа — чистый текст, без HTML и Markdown, абзацы разделяй пустой строкой.`;
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
  const isOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const apiKey  = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  const apiBase = isOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : (process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1');
  const defaultModel = isOpenRouter ? 'openai/gpt-6.1-sol' : 'gpt-6.1-sol';
  const model   = process.env.LLM_MODEL ?? defaultModel;
  // low | medium | high — для коротких постов хватает low: быстрее и дешевле
  const effort  = process.env.LLM_REASONING_EFFORT ?? 'low';
  const fetchOpts = process.env.OPENAI_API_BASE
    ? { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }
    : {};
  return { apiKey, apiBase, model, effort, isOpenRouter, fetchOpts };
}

// Модели GPT-6 рассуждают перед ответом, и эти токены входят в лимит
// max_completion_tokens. Без запаса ответ может прийти пустым.
const REASONING_ALLOWANCE = 4000;

async function chatComplete(system, user, maxTokens = 1000) {
  const { apiKey, apiBase, model, effort, isOpenRouter, fetchOpts } = getApiConfig();
  if (!apiKey) throw new Error('No API key configured');

  const body = {
    model,
    max_completion_tokens: maxTokens + REASONING_ALLOWANCE,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  };
  if (isOpenRouter) body.reasoning = { effort };
  else body.reasoning_effort = effort;

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
    ...fetchOpts,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!content) {
    const reason = data.choices?.[0]?.finish_reason ?? 'unknown';
    throw new Error(`Empty response from ${model} (finish_reason: ${reason})`);
  }
  return content;
}

export async function generateNews(post) {
  try {
    const system = buildNewsSystem(loadRecentHeadlines(), loadRecentEndings());
    const result = await chatComplete(system, `Исходный текст:\n${toPlainText(post.html)}`);
    if (!result) return null;
    const trimmed = result.trim();
    if (trimmed === 'ДУБЛЬ' || trimmed.startsWith('ПРОТИВОРЕЧИЕ')) return trimmed;
    saveEnding(trimmed);
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
  const system = `Ты — редактор массового Telegram-канала «Мармелад» про новинки, магазины, еду и всё, что обсуждают покупатели. Читатель — обычный человек, не специалист.
Выполни инструкцию пользователя применительно к тексту поста. Если инструкция чего-то не уточняет — держись стиля канала ниже. Инструкция пользователя важнее правил стиля.

${STYLE_RULES}

Верни только готовый текст поста. Чистый текст, без HTML и Markdown, абзацы разделяй пустой строкой.`;

  try {
    const result = await chatComplete(
      system,
      `Инструкция: ${userPrompt}\n\nТекст поста:\n${toPlainText(post.html)}`,
    );
    if (result) saveEnding(result);
    return result;
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
