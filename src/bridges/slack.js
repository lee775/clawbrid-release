/**
 * ClawBrid - Slack Bridge
 */
const { App } = require('@slack/bolt');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const config = require('../core/config');
const StatusReporter = require('../core/status-reporter');
const { runClaude, extractText, extractSessionId, runCodexReview, hasCodeChanges } = require('../core/claude-runner');

let app = null;
let status = null;

// ── 세션 관리 ──
function loadSessions() {
  try {
    const p = config.SESSIONS_FILE;
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return new Map(Object.entries(data.slack || {}));
    }
  } catch {}
  return new Map();
}

function saveSessions(sessions) {
  try {
    let data = {};
    if (fs.existsSync(config.SESSIONS_FILE)) {
      data = JSON.parse(fs.readFileSync(config.SESSIONS_FILE, 'utf-8'));
    }
    data.slack = Object.fromEntries(sessions);
    fs.writeFileSync(config.SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}

// ── 대화 기록 (일별 MD) ──
function getHistoryDir(chatId) {
  const dir = path.join(config.HISTORY_DIR, `slack_${chatId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getTodayPath(chatId) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getHistoryDir(chatId), `${date}.md`);
}

function addToHistory(chatId, role, content) {
  try {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const label = role === 'user' ? '사용자' : 'Claude';
    const line = `### ${label} (${now})\n${content}\n\n`;
    fs.appendFileSync(getTodayPath(chatId), line, 'utf-8');
  } catch {}
}

function getRecentHistory(chatId, days = 3) {
  try {
    const dir = getHistoryDir(chatId);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
    if (!files.length) return '';

    const recent = files.slice(0, days);
    let combined = '';
    for (const f of recent.reverse()) {
      combined += `## ${f.replace('.md', '')}\n`;
      combined += fs.readFileSync(path.join(dir, f), 'utf-8');
    }
    return `--- 최근 ${days}일 대화 기록 ---\n${combined}--- 대화 기록 끝 ---\n\n`;
  } catch {}
  return '';
}

function searchHistory(chatId, keyword) {
  try {
    const dir = getHistoryDir(chatId);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    const results = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (content.includes(keyword)) {
        // 키워드 포함된 블록만 추출
        const blocks = content.split(/(?=### )/);
        for (const block of blocks) {
          if (block.includes(keyword)) results.push(`[${f.replace('.md', '')}] ${block.trim()}`);
        }
      }
    }
    return results.length ? `--- 검색 결과: "${keyword}" (${results.length}건) ---\n${results.join('\n\n')}\n--- 검색 끝 ---\n\n` : '';
  } catch {}
  return '';
}

// ── 파일 다운로드 ──
function downloadFile(url, destPath, token) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location, destPath, token).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function handleFiles(event, token) {
  if (!event.files || event.files.length === 0) return [];
  const downloaded = [];
  for (const file of event.files) {
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._\-가-힣]/g, '_');
      const destPath = path.join(config.DOWNLOADS_DIR, `${Date.now()}_${safeName}`);
      const url = file.url_private_download || file.url_private;
      if (!url) continue;
      await downloadFile(url, destPath, token);
      downloaded.push({ name: file.name, path: destPath, type: file.filetype, size: file.size });
    } catch (err) {
      console.error(`[SLACK FILE ERROR] ${file.name}: ${err.message}`);
    }
  }
  return downloaded;
}

// ── 메시지 분할 ──
async function sendLongMessage(say, text) {
  const MAX = 3900;
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { await say({ text: remaining }); break; }
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut === -1 || cut < MAX * 0.5) cut = MAX;
    await say({ text: remaining.slice(0, cut) });
    remaining = remaining.slice(cut);
  }
}

// ── 메인 핸들러 ──
const activeSessions = new Map();
const channelSessions = loadSessions();

async function handleMessage({ event, say, client }) {
  if (event.bot_id) return;
  if (event.subtype && event.subtype !== 'file_share') return;

  const cfg = config.load();
  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const text = event.text?.trim() || '';
  const hasFiles = event.files && event.files.length > 0;

  if (!text && !hasFiles) return;

  // 특수 명령어
  if (text.toLowerCase() === '!stop') {
    const key = `${channelId}:${threadTs}`;
    const active = activeSessions.get(key);
    if (active) { active.kill?.('SIGTERM'); activeSessions.delete(key); await say('🛑 중단됨'); }
    else await say('ℹ️ 실행 중인 작업 없음');
    return;
  }
  if (text.toLowerCase() === '!reset') {
    channelSessions.delete(channelId); saveSessions(channelSessions);
    await say('🔄 세션 초기화됨'); return;
  }
  if (text.toLowerCase() === '!help') {
    await say('*ClawBrid 명령어*\n• `!stop` 작업 중단\n• `!reset` 세션 초기화\n• `!cron list` 크론 목록\n• `!cron add [이름] [간격(분)] [명령]` 크론 추가\n• `!cron del [이름]` 크론 삭제\n• `!cron run [이름]` 즉시 실행\n• `!help` 도움말'); return;
  }

  // ── 크론 명령어 ──
  if (text.toLowerCase().startsWith('!cron')) {
    const cronManager = require('../core/cron-manager');
    const parts = text.slice(5).trim().split(/\s+/);
    const sub = (parts[0] || '').toLowerCase();

    if (sub === 'list' || !sub) {
      const crons = cronManager.loadCrons();
      if (!crons.length) { await say('등록된 크론 작업이 없습니다.'); return; }
      const list = crons.map(c => {
        const status = c.enabled ? '🟢' : '⚪';
        const last = c.lastRun ? new Date(c.lastRun).toLocaleTimeString('ko-KR') : '-';
        return `${status} *${c.name}* | ${c.type} | ${c.intervalMin}분 | 마지막: ${last}`;
      }).join('\n');
      await say(`*⏰ 크론 작업 목록*\n${list}`); return;
    }

    if (sub === 'add') {
      // !cron add 이름 간격(분) 명령어...
      const name = parts[1];
      const interval = parseInt(parts[2]);
      const command = parts.slice(3).join(' ');
      if (!name || !interval || !command) {
        await say('사용법: `!cron add [이름] [간격(분)] [명령/프롬프트]`'); return;
      }
      const isShell = command.startsWith('!');
      const cron = cronManager.addCron({
        name,
        type: isShell ? 'shell' : 'claude',
        command: isShell ? command.slice(1) : command,
        intervalMin: interval,
        target: 'slack',
      });
      cronManager.startCron(cron);
      await say(`✅ 크론 추가: *${name}* (${interval}분 간격, ${isShell ? '쉘' : 'Claude'})`); return;
    }

    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
      const name = parts.slice(1).join(' ');
      const crons = cronManager.loadCrons();
      const found = crons.find(c => c.name === name);
      if (!found) { await say(`❌ "${name}" 크론을 찾을 수 없습니다.`); return; }
      cronManager.removeCron(found.id);
      await say(`🗑️ 크론 삭제: *${name}*`); return;
    }

    if (sub === 'run') {
      const name = parts.slice(1).join(' ');
      const crons = cronManager.loadCrons();
      const found = crons.find(c => c.name === name);
      if (!found) { await say(`❌ "${name}" 크론을 찾을 수 없습니다.`); return; }
      await say(`⏳ 크론 실행 중: *${name}*`);
      await cronManager.executeCron(found);
      const updated = cronManager.loadCrons().find(c => c.id === found.id);
      await say(`✅ 실행 완료: ${updated?.lastResult || '(결과 없음)'}`); return;
    }

    if (sub === 'on' || sub === 'off') {
      const name = parts.slice(1).join(' ');
      const crons = cronManager.loadCrons();
      const found = crons.find(c => c.name === name);
      if (!found) { await say(`❌ "${name}" 크론을 찾을 수 없습니다.`); return; }
      if ((sub === 'on' && found.enabled) || (sub === 'off' && !found.enabled)) {
        await say(`ℹ️ *${name}*은(는) 이미 ${found.enabled ? '활성' : '비활성'} 상태입니다.`); return;
      }
      cronManager.toggleCron(found.id);
      await say(`${sub === 'on' ? '🟢' : '⚪'} *${name}* ${sub === 'on' ? '활성화' : '비활성화'}됨`); return;
    }

    await say('사용법: `!cron list|add|del|run|on|off`'); return;
  }

  const sessionKey = `${channelId}:${threadTs}`;
  if (activeSessions.has(sessionKey)) {
    await say('⏳ 이전 작업 진행 중. `!stop`으로 중단 가능'); return;
  }

  const startMsg = await say('⏳ 작업 진행중');
  let dotCount = 0;
  const progressTimer = setInterval(async () => {
    dotCount = (dotCount + 1) % 4;
    try {
      await client.chat.update({ channel: channelId, ts: startMsg.ts, text: `⏳ 작업 진행중${'.'.repeat(dotCount || 1)}` });
    } catch {}
  }, 5000);

  const resumeSessionId = channelSessions.get(channelId) || null;

  try {
    activeSessions.set(sessionKey, true);
    status.start(text || '[파일 첨부]', userId, channelId);

    let prompt = text;
    if (hasFiles) {
      const files = await handleFiles(event, cfg.slack.botToken);
      if (files.length > 0) {
        const info = files.map(f => `[첨부파일] ${f.name} (${f.type}, ${(f.size/1024).toFixed(1)}KB)\n경로: ${f.path}`).join('\n');
        prompt = prompt
          ? `${prompt}\n\n--- 첨부파일 ---\n${info}\n\n위 첨부파일을 Read 도구로 직접 열어서 내용을 확인하고 분석해줘.`
          : `다음 첨부파일을 Read 도구로 직접 열어서 내용을 확인하고 분석해줘:\n\n${info}`;
      }
    }

    addToHistory(channelId, 'user', prompt);

    let finalPrompt = prompt;
    if (!resumeSessionId) {
      const ctx = getRecentHistory(channelId);
      // 과거 대화 참조 키워드 감지 → 전체 기록 검색
      const pastKeywords = ['이전에', '전에', '지난번', '예전에', '며칠전', '저번에', '과거', '기억', '얘기했'];
      const needsSearch = pastKeywords.some(k => prompt.includes(k));
      let searchCtx = '';
      if (needsSearch) {
        // 핵심 키워드 추출 (과거 참조 키워드 제거 후 남은 명사)
        const cleaned = prompt.replace(/이전에|전에|지난번|예전에|며칠전|저번에|과거에?|기억|얘기했\w*/g, '').trim();
        const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
        for (const w of words) {
          const found = searchHistory(channelId, w);
          if (found) { searchCtx += found; break; }
        }
        if (!searchCtx) {
          // 키워드 추출 실패시 전체 기록에서 최근 7일 참조
          searchCtx = getRecentHistory(channelId, 7);
        }
      }
      if (ctx || searchCtx) finalPrompt = `${ctx}${searchCtx}현재 메시지: ${prompt}`;
    }

    const result = await runClaude(finalPrompt, { resumeSessionId });

    const newSession = extractSessionId(result);
    if (newSession) { channelSessions.set(channelId, newSession); saveSessions(channelSessions); }

    const responseText = extractText(result);
    addToHistory(channelId, 'assistant', responseText);
    status.done(responseText);

    try { await client.chat.update({ channel: channelId, ts: startMsg.ts, text: '✅ 작업 완료' }); } catch {}
    await sendLongMessage(say, responseText);

    // 코드 변경이 있으면 자동 Codex 리뷰
    if (hasCodeChanges()) {
      try {
        await say('🔍 Codex 리뷰 실행중...');
        const review = await runCodexReview();
        if (review) await sendLongMessage(say, `📋 *Codex Review*\n${review}`);
        else await say('✅ Codex 리뷰: 이슈 없음');
      } catch {}
    }

  } catch (err) {
    console.error(`[SLACK ERROR] ${err.message}`);
    status.error(err.message);
    try { await client.chat.update({ channel: channelId, ts: startMsg.ts, text: '❌ 작업 실패' }); } catch {}
    await say(`❌ 오류:\n\`\`\`\n${err.message}\n\`\`\``);
  } finally {
    clearInterval(progressTimer);
    activeSessions.delete(sessionKey);
  }
}

// ── 시작/중지 ──
async function start() {
  const cfg = config.load();
  if (!cfg.slack.enabled || !cfg.slack.botToken) {
    console.log('[SLACK] Disabled or token not set');
    return false;
  }

  status = new StatusReporter('slack');

  app = new App({
    token: cfg.slack.botToken,
    signingSecret: cfg.slack.signingSecret,
    socketMode: true,
    appToken: cfg.slack.appToken,
  });

  app.event('message', handleMessage);
  app.event('app_mention', async (args) => {
    args.event.text = args.event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    await handleMessage(args);
  });

  await app.start();
  console.log('[SLACK] Bridge started');
  return true;
}

async function stop() {
  if (app) { await app.stop(); app = null; }
  if (status) { status.destroy(); status = null; }
  console.log('[SLACK] Bridge stopped');
}

module.exports = { start, stop };
