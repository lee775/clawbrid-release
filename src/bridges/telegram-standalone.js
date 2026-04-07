#!/usr/bin/env node
/**
 * Telegram Bridge 독립 실행 (PM2용)
 */
const telegram = require('./telegram');

telegram.start().then(ok => {
  if (ok) console.log('[ClawBrid] Telegram Bridge running...');
  else { console.error('[ClawBrid] Telegram Bridge failed - check config'); process.exit(1); }
}).catch(err => {
  console.error(`[ClawBrid] Telegram Bridge 오류: ${err.message}`);
  process.exit(1);
});
