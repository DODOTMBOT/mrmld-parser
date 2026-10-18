import { fetchActiveSources } from './sources.js';
import { fetchNewPosts } from './scraper.js';
import { getLastSeen, setLastSeen } from './state.js';
import { sendModerationMessage, sendCommentModerationMessage } from './bot.js';
import { generateComment } from './llm.js';
import { canQueueComment } from './comment-state.js';
import { log } from './logger.js';

// t.me/s preview doesn't expose comment availability via HTML, so we
// generate a draft for every post and let the user decide in moderation.
// GramJS will report an error at publish time if the channel has no discussion group.

const FOOTER = '\n\n<a href="https://t.me/+Y31Fj1QPm6AwOTQ6">Мармелад | Общепит, магазины, рестораны</a>';

function buildRawDraft(post) {
  return post.html + FOOTER;
}

export async function runCycle() {
  const t0 = Date.now();
  log('info', '─── cycle start ───────────────────────────────');

  const sources = await fetchActiveSources();
  log('info', `sources: ${sources.length} active`);

  let totalNew = 0;

  for (const source of sources) {
    const lastSeen = getLastSeen(source.username);
    const posts = await fetchNewPosts(source.username, lastSeen);

    if (posts.length === 0) {
      log('info', `@${source.username}: no new posts (last seen #${lastSeen})`);
      continue;
    }

    log('info', `@${source.username}: ${posts.length} new post(s) since #${lastSeen}`);
    totalNew += posts.length;

    for (const post of posts) {
      const rawDraft = buildRawDraft(post);
      await sendModerationMessage(post, rawDraft);
      log('info', `  ↳ queued for moderation: #${post.id}`);

      // Comment track: generate at most once per source per day
      if (canQueueComment(post.username)) {
        const commentText = await generateComment(post).catch((e) => {
          log('error', `  ↳ comment gen error: ${e.message}`);
          return null;
        });
        if (commentText) {
          await sendCommentModerationMessage(post, commentText).catch((e) =>
            log('error', `  ↳ comment moderation error: ${e.message}`)
          );
          log('info', `  ↳ comment queued for @${post.username}/${post.id}`);
        }
      }

      await new Promise((r) => setTimeout(r, 1_000));
    }

    const maxId = Math.max(...posts.map((p) => p.id));
    setLastSeen(source.username, maxId);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('info', `─── cycle done: ${totalNew} new post(s) in ${elapsed}s ───`);
}
