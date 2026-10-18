import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { log } from './logger.js';

let _client = null;

function isConfigured() {
  return !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.GRAMJS_SESSION);
}

async function getClient() {
  if (_client?.connected) return _client;

  if (!isConfigured()) {
    throw new Error(
      'MTProto not configured. Set TG_API_ID, TG_API_HASH, GRAMJS_SESSION in .env\n' +
      'Run: node scripts/setup-mtproto.js to obtain a session string.',
    );
  }

  const session = new StringSession(process.env.GRAMJS_SESSION);
  _client = new TelegramClient(
    session,
    Number(process.env.TG_API_ID),
    process.env.TG_API_HASH,
    { connectionRetries: 3 },
  );
  await _client.connect();

  if (!await _client.isUserAuthorized()) {
    _client = null;
    throw new Error('GramJS session expired. Re-run: node scripts/setup-mtproto.js');
  }
  log('info', '[mtproto] client connected');
  return _client;
}

export function isMtprotoConfigured() {
  return isConfigured();
}

// Returns channel statistics via MTProto stats.getBroadcastStats.
// Requires the channel to have 500+ subscribers for full stats.
export async function getChannelStats(channelId) {
  const client = await getClient();
  const entity = await client.getEntity(channelId);

  // Basic info always available
  const fullChannel = await client.invoke(
    new Api.channels.GetFullChannel({ channel: entity }),
  );
  const full  = fullChannel.fullChat;
  const chat  = fullChannel.chats?.[0];
  const about = full.about ?? '';
  const members = full.participantsCount ?? chat?.participantsCount ?? null;

  // Recent posts (last 10) with their view counts
  const history = await client.invoke(
    new Api.messages.GetHistory({
      peer: entity,
      limit: 10,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }),
  );
  const posts = (history.messages ?? [])
    .filter(m => m.className === 'Message' && m.message !== undefined)
    .map(m => ({
      id:        m.id,
      date:      m.date,
      text:      (m.message ?? '').slice(0, 120),
      views:     m.views ?? 0,
      forwards:  m.forwards ?? 0,
      reactions: (m.reactions?.results ?? []).reduce((s, r) => s + (r.count ?? 0), 0),
    }));

  // Broadcast stats (available for channels with 500+ members)
  let broadcastStats = null;
  try {
    const statsResult = await client.invoke(
      new Api.stats.GetBroadcastStats({ channel: entity, dark: false }),
    );
    const s = statsResult;
    broadcastStats = {
      followersMin:   s.followers?.min ?? null,
      followersMax:   s.followers?.max ?? null,
      viewsMin:       s.viewsPerPost?.min ?? null,
      viewsMax:       s.viewsPerPost?.max ?? null,
      sharesMin:      s.sharesPerPost?.min ?? null,
      sharesMax:      s.sharesPerPost?.max ?? null,
      reactionsMin:   s.reactionsPerPost?.min ?? null,
      reactionsMax:   s.reactionsPerPost?.max ?? null,
      enabledNotifications: s.enabledNotifications?.part ?? null,
      meanViewsPerPost: s.meanViewsPerPost ?? null,
      meanSharesPerPost: s.meanSharesPerPost ?? null,
      meanReactionsPerPost: s.meanReactionsPerPost ?? null,
    };
  } catch (e) {
    log('warn', `[mtproto] broadcast stats unavailable: ${e.message}`);
  }

  return { members, about, posts, broadcastStats, entity: chat };
}

// Publishes `text` as a comment under channelUsername/postId.
// Uses GramJS commentTo, which resolves the linked discussion group automatically.
// If TG_SEND_AS_CHANNEL is set (e.g. "@mrmld_hrc" or its id), sends as that channel
// instead of the personal account (requires user to be admin of that channel).
export async function sendCommentToPost(channelUsername, postId, text) {
  const client = await getClient();
  const channelEntity = await client.getEntity(channelUsername);

  // Resolve sendAs entity (optional)
  const sendAsId = process.env.TG_SEND_AS_CHANNEL;
  let sendAsEntity;
  if (sendAsId) {
    try {
      sendAsEntity = await client.getEntity(sendAsId);
    } catch {
      log('warn', `[mtproto] TG_SEND_AS_CHANNEL "${sendAsId}" not accessible, posting as user`);
    }
  }

  await client.sendMessage(channelEntity, {
    message: text,
    commentTo: postId,
    ...(sendAsEntity ? { sendAs: sendAsEntity } : {}),
  });

  log('info', `[mtproto] comment sent to @${channelUsername}/${postId}`);
}
