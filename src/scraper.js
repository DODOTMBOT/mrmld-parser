import * as cheerio from 'cheerio';
import { log } from './logger.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Recursively convert a DOM node to Telegram-compatible HTML
function toTgHtml($, node) {
  let result = '';

  $(node).contents().each((_, child) => {
    if (child.type === 'text') {
      result += escapeHtml(child.data);
      return;
    }
    if (child.type !== 'tag') return;

    const tag = child.name.toLowerCase();
    const inner = toTgHtml($, child);

    switch (tag) {
      case 'br':
        result += '\n';
        break;
      case 'b':
      case 'strong':
        result += `<b>${inner}</b>`;
        break;
      case 'i':
      case 'em':
        result += `<i>${inner}</i>`;
        break;
      case 'u':
        result += `<u>${inner}</u>`;
        break;
      case 's':
      case 'strike':
      case 'del':
        result += `<s>${inner}</s>`;
        break;
      case 'code':
        result += `<code>${inner}</code>`;
        break;
      case 'pre':
        result += `<pre>${inner}</pre>`;
        break;
      case 'a': {
        const href = $(child).attr('href') ?? '';
        // Only keep absolute http(s) links — relative and tg:// links break Telegram HTML parser
        if (href.startsWith('http://') || href.startsWith('https://')) {
          result += `<a href="${escapeHtml(href)}">${inner}</a>`;
        } else {
          result += inner;
        }
        break;
      }
      case 'tg-emoji':
        // Custom emoji: skip wrapper, keep fallback text
        result += inner;
        break;
      default:
        // span, div, p, etc. — just unwrap
        result += inner;
    }
  });

  return result;
}

async function fetchPage(username, before = null) {
  const url = `https://t.me/s/${username}${before ? `?before=${before}` : ''}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MrmldParser/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchNewPosts(username, sinceId) {
  try {
    const MAX_PAGES = 5;
    const allPosts = [];
    let before = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const html = await fetchPage(username, before);
      const $ = cheerio.load(html);

      const pagePosts = [];
      let oldestIdOnPage = Infinity;

      $('.tgme_widget_message').each((_, el) => {
        const dataPost = $(el).attr('data-post') ?? '';
        const idStr = dataPost.split('/')[1];
        const id = parseInt(idStr, 10);
        if (!id) return;

        oldestIdOnPage = Math.min(oldestIdOnPage, id);
        if (id <= sinceId) return;

        if ($(el).find('.tgme_widget_message_forwarded_from').length > 0) return;

        const textEl = $(el).find('.tgme_widget_message_text').first();
        const postHtml = textEl.length ? toTgHtml($, textEl[0]).trim() : '';

        // Collect all photos
        const mediaItems = [];
        $(el).find('.tgme_widget_message_photo_wrap').each((_, wrap) => {
          const style = $(wrap).attr('style') ?? '';
          const m = style.match(/background-image:url\('([^']+)'\)/);
          if (m) mediaItems.push({ type: 'photo', url: m[1] });
        });

        // Collect videos — prefer non-blurred, skip blurred duplicates
        const seenVideoUrls = new Set();
        $(el).find('video.tgme_widget_message_video').each((_, vid) => {
          const src = $(vid).attr('src');
          const cls = $(vid).attr('class') ?? '';
          if (src && !cls.includes('blured') && !seenVideoUrls.has(src)) {
            seenVideoUrls.add(src);
            mediaItems.push({ type: 'video', url: src });
          }
        });
        if (!mediaItems.some((m) => m.type === 'video')) {
          $(el).find('video.tgme_widget_message_video').each((_, vid) => {
            const src = $(vid).attr('src');
            if (src && !seenVideoUrls.has(src)) {
              seenVideoUrls.add(src);
              mediaItems.push({ type: 'video', url: src });
            }
          });
        }

        if (!postHtml && mediaItems.length === 0) return;

        pagePosts.push({ id, username, url: `https://t.me/${username}/${id}`, html: postHtml, mediaItems });
      });

      allPosts.push(...pagePosts);

      // Stop if oldest post on page is already older than sinceId — no need to go further
      if (oldestIdOnPage <= sinceId || oldestIdOnPage === Infinity) break;

      // All posts on this page are newer than sinceId — fetch previous page
      const dataBefore = $('[data-before]').attr('data-before');
      if (!dataBefore) break;
      before = dataBefore;
    }

    return allPosts.sort((a, b) => a.id - b.id);
  } catch (err) {
    log('error', `scrape failed for ${username}: ${err.message}`);
    return [];
  }
}
