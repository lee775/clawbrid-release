/**
 * Google Chat Bridge 독립 실행 (PM2용)
 */
const gchat = require('./google-chat');

gchat.start().then(ok => {
  if (ok) console.log('[ClawBrid] Google Chat Bridge running...');
  else { console.error('[ClawBrid] Google Chat Bridge failed - check config'); process.exit(1); }
}).catch(err => {
  console.error(`[ClawBrid] Google Chat Bridge 오류: ${err.message}`);
  process.exit(1);
});
