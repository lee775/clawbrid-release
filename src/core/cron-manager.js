/**
 * ClawBrid 크론 매니저
 * - crons.json에 작업 저장
 * - node-cron 기반 표준 cron expression 사용 (분 시 일 월 요일)
 * - Claude 호출 또는 쉘 명령 실행
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cron = require('node-cron');
const { runClaude, extractText } = require('./claude-runner');

const CRON_FILE = path.join(os.homedir(), '.clawbrid', 'crons.json');
const CRON_LOG_DIR = path.join(os.homedir(), '.clawbrid', 'cron-logs');

const activeTasks = new Map();

function ensureLogDir() {
  if (!fs.existsSync(CRON_LOG_DIR)) fs.mkdirSync(CRON_LOG_DIR, { recursive: true });
}

function loadCrons() {
  try {
    if (fs.existsSync(CRON_FILE)) return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8'));
  } catch {}
  return [];
}

function saveCrons(crons) {
  fs.writeFileSync(CRON_FILE, JSON.stringify(crons, null, 2), 'utf-8');
}

function addCron({ name, type, command, schedule, target }) {
  const crons = loadCrons();
  const id = Date.now().toString(36);
  const entry = {
    id,
    name,
    type,            // 'claude' | 'shell'
    command,         // 프롬프트 또는 쉘 명령
    schedule,        // cron expression (예: "*/30 * * * *", "0 9 * * *", "50 18 * * 1-5")
    target,          // 'slack' | 'telegram' | 'none'
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: new Date().toISOString(),
  };
  crons.push(entry);
  saveCrons(crons);
  return entry;
}

function removeCron(id) {
  stopCron(id);
  const crons = loadCrons().filter(c => c.id !== id);
  saveCrons(crons);
}

function toggleCron(id) {
  const crons = loadCrons();
  const entry = crons.find(c => c.id === id);
  if (!entry) return;
  entry.enabled = !entry.enabled;
  saveCrons(crons);
  if (entry.enabled) startCron(entry);
  else stopCron(id);
}

function stopCron(id) {
  if (activeTasks.has(id)) {
    activeTasks.get(id).stop();
    activeTasks.delete(id);
  }
}

function logCronResult(entry, result) {
  ensureLogDir();
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(CRON_LOG_DIR, `${date}.md`);
  const time = new Date().toISOString().slice(11, 19);
  const logEntry = `### [${time}] ${entry.name}\n- 타입: ${entry.type}\n- 명령: ${entry.command}\n- 결과: ${result.slice(0, 500)}\n\n`;
  fs.appendFileSync(logFile, logEntry, 'utf-8');
}

async function executeCron(entry) {
  const crons = loadCrons();
  const target = crons.find(c => c.id === entry.id);
  if (!target || !target.enabled) return;

  try {
    let result = '';
    let sessionId = null;

    if (entry.type === 'shell') {
      const { execSync } = require('child_process');
      result = execSync(entry.command, { encoding: 'utf-8', timeout: 60000, windowsHide: true }).trim();
    } else {
      // Claude 실행 (타임아웃 시 이어서 계속)
      const { extractSessionId } = require('./claude-runner');
      let attempts = 0;
      const maxAttempts = 3;

      const cronSystemPrompt = '결과를 보고할 내용이 없거나 변경사항이 없으면 빈 문자열만 출력하고 다른 말은 하지 마.';

      while (attempts < maxAttempts) {
        try {
          const res = await runClaude(
            attempts === 0 ? entry.command : '이어서 계속 진행해줘',
            {
              ...(sessionId ? { resumeSessionId: sessionId } : {}),
              appendSystemPrompt: cronSystemPrompt,
            }
          );
          sessionId = extractSessionId(res);
          const text = extractText(res);
          result += (result ? '\n' : '') + text;
          break;
        } catch (err) {
          if (err.message.includes('타임아웃') && attempts < maxAttempts - 1) {
            attempts++;
            console.log(`[CRON] ${entry.name}: 타임아웃, 이어서 계속 (${attempts}/${maxAttempts})`);
            continue;
          }
          throw err;
        }
      }
    }

    // 결과 저장
    target.lastRun = new Date().toISOString();
    target.lastResult = result.slice(0, 200);
    saveCrons(crons);
    logCronResult(entry, result);

    // 타겟에 전송 (내용이 있을 때만)
    if (entry.target && entry.target !== 'none' && result && result.trim()) {
      sendToTarget(entry.target, `[크론: ${entry.name}]\n${result}`);
    }
  } catch (err) {
    target.lastRun = new Date().toISOString();
    target.lastResult = `에러: ${err.message}`.slice(0, 200);
    saveCrons(crons);
  }
}

function sendToTarget(target, message) {
  const cfg = require('./config').load();
  if (target === 'slack' && cfg.slack.botToken) {
    const https = require('https');
    const postData = JSON.stringify({
      channel: cfg.slack.cronChannel || cfg.slack.defaultChannel || 'D0ANB4ED28L',
      text: message,
    });
    const options = {
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${cfg.slack.botToken}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, () => {});
    req.on('error', (e) => console.error(`[CRON] Slack send error: ${e.message}`));
    req.write(postData);
    req.end();
  } else if (target === 'telegram' && cfg.telegram.botToken) {
    const https = require('https');
    const chatId = cfg.telegram.adminUser;
    if (!chatId) return;
    const postData = JSON.stringify({ chat_id: chatId, text: message });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${cfg.telegram.botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = https.request(options, () => {});
    req.on('error', (e) => console.error(`[CRON] Telegram send error: ${e.message}`));
    req.write(postData);
    req.end();
  }
  console.log(`[CRON → ${target}] ${message.slice(0, 100)}`);
}

function startCron(entry) {
  stopCron(entry.id);
  if (!entry.enabled) return;

  if (!entry.schedule || !cron.validate(entry.schedule)) {
    console.log(`[CRON] Skipped: ${entry.name} (invalid schedule: "${entry.schedule}")`);
    return;
  }

  const task = cron.schedule(entry.schedule, () => executeCron(entry));
  activeTasks.set(entry.id, task);
  console.log(`[CRON] Started: ${entry.name} (${entry.schedule})`);
}

function startAll() {
  const crons = loadCrons();
  for (const entry of crons) {
    if (entry.enabled) startCron(entry);
  }
  console.log(`[CRON] ${crons.filter(c => c.enabled).length}/${crons.length} crons started`);
}

function stopAll() {
  for (const [id] of activeTasks) {
    stopCron(id);
  }
}

module.exports = { loadCrons, saveCrons, addCron, removeCron, toggleCron, startCron, startAll, stopAll, executeCron };
