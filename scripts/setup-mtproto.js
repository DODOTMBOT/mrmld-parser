#!/usr/bin/env node
/**
 * One-time MTProto session setup for GramJS.
 * Run: node scripts/setup-mtproto.js
 * Prints GRAMJS_SESSION=... to paste into .env
 */
import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const apiId   = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error(
    '\nError: TG_API_ID and TG_API_HASH must be set in parser/.env\n' +
    'Get them at: https://my.telegram.org → API development tools\n',
  );
  rl.close();
  process.exit(1);
}

console.log('\nConnecting to Telegram...\n');

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask('Phone number (with country code, e.g. +79001234567): '),
  phoneCode:   () => ask('Code from Telegram: '),
  password:    () => ask('2FA password (press Enter if none): '),
  onError:     (err) => console.error('Auth error:', err.message),
});

const sessionString = client.session.save();

console.log('\n=== Add this line to parser/.env ===');
console.log(`GRAMJS_SESSION=${sessionString}`);
console.log('=====================================\n');
console.log('Also add to .env if not already set:');
console.log('TG_API_ID=<your api_id>');
console.log('TG_API_HASH=<your api_hash>');
console.log('TG_SEND_AS_CHANNEL=@mrmld_hrc  # optional: post comments as channel\n');

await client.disconnect();
rl.close();
