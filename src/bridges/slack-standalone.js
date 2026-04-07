#!/usr/bin/env node
/**
 * Slack Bridge 독립 실행 (PM2용)
 */
const slack = require('./slack');

slack.start().then(ok => {
  if (ok) console.log('[ClawBrid] Slack Bridge running...');
  else { console.error('[ClawBrid] Slack Bridge failed - check config'); process.exit(1); }
}).catch(err => {
  console.error(`[ClawBrid] Slack Bridge 오류: ${err.message}`);
  process.exit(1);
});
