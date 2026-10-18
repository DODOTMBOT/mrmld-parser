import 'dotenv/config';
import { startPolling } from './src/bot.js';
import { runCycle } from './src/pipeline.js';
import { startStatsServer } from './src/stats-server.js';
import { log } from './src/logger.js';

const INTERVAL_MS = 10 * 60 * 1000; // 10 min

log('info', '════════════════════════════════════════');
log('info', ' mrmld-parser starting');
log('info', '════════════════════════════════════════');

// Start bot first, let it init before pipeline sends messages
await startPolling();
startStatsServer();

// First cycle immediately, then every 20 minutes
await runCycle();
setInterval(runCycle, INTERVAL_MS);
