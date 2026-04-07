/**
 * ClawBrid 크론 워커
 * PM2로 백그라운드 실행 - 대시보드 없이도 크론 작업 수행
 */
const cronManager = require('./core/cron-manager');

console.log('[CRON-WORKER] Starting...');
cronManager.startAll();
console.log('[CRON-WORKER] All crons loaded. Running in background.');

// 크론 파일 변경 감지 (대시보드에서 수정 시 반영)
const fs = require('fs');
const path = require('path');
const os = require('os');
const CRON_FILE = path.join(os.homedir(), '.clawbrid', 'crons.json');

let lastMtime = 0;
setInterval(() => {
  try {
    const stat = fs.statSync(CRON_FILE);
    if (stat.mtimeMs > lastMtime) {
      lastMtime = stat.mtimeMs;
      cronManager.stopAll();
      cronManager.startAll();
      console.log('[CRON-WORKER] Crons reloaded.');
    }
  } catch {}
}, 5000);

// 프로세스 유지
process.on('SIGINT', () => { cronManager.stopAll(); process.exit(0); });
process.on('SIGTERM', () => { cronManager.stopAll(); process.exit(0); });
