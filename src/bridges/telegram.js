/**
 * ClawBrid - Telegram Bridge
 */
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const path = require('path');
const fs = require('fs');
const config = require('../core/config');
const StatusReporter = require('../core/status-reporter');
const { runClaude, extractText, extractSessionId, runCodexReview, hasCodeChanges } = require('../core/claude-runner');

let bot = null;
let status = null;

// ── 권한 ──
function isAdmin(userId) {
  const cfg = config.load();
  return String(userId) === String(cfg.telegram.adminUser);
}

function isAllowed(userId) {
  if (isAdmin(userId)) return true;
  const cfg = config.load();
  return cfg.telegram.allowedUsers.map(id => String(id)).includes(String(userId));
}

// ── 세션 관리 ──
function loadSessions() {
  try {
    if (fs.existsSync(config.SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.SESSIONS_FILE, 'utf-8'));
      return new Map(Object.entries(data.telegram || {}));
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
    data.telegram = Object.fromEntries(sessions);
    fs.writeFileSync(config.SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}

// ── 대화 기록 (일별 MD) ──
function getHistoryDir(chatId) {
  const dir = path.join(config.HISTORY_DIR, `tg_${chatId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getTodayPath(chatId) {
  const date = new Date().toISOString().slice(0, 10);
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
async function downloadTelegramFile(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${config.load().telegram.botToken}/${file.file_path}`;
    const ext = path.extname(file.file_path) || '.bin';
    const destPath = path.join(config.DOWNLOADS_DIR, `${Date.now()}_${path.basename(file.file_path)}`);
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const ws = fs.createWriteStream(destPath);
        res.pipe(ws);
        ws.on('finish', () => { ws.close(); resolve({ path: destPath, name: path.basename(file.file_path), size: fs.statSync(destPath).size }); });
        ws.on('error', reject);
      }).on('error', reject);
    });
  } catch (err) {
    console.error(`[TG FILE ERROR] ${err.message}`);
    return null;
  }
}

// ── 메시지 분할 ──
async function sendLongMessage(chatId, text) {
  const MAX = 4000;
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { await bot.sendMessage(chatId, remaining); break; }
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut === -1 || cut < MAX * 0.5) cut = MAX;
    await bot.sendMessage(chatId, remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
}

// ── 메인 핸들러 ──
const activeSessions = new Map();
const chatSessions = loadSessions();

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const text = msg.text?.trim() || '';
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = !!msg.document;

  if (!text && !hasPhoto && !hasDocument) return;

  // 권한 체크
  if (!isAllowed(userId)) {
    await bot.sendMessage(chatId, '🚫 권한이 없습니다. 관리자에게 요청해주세요.');
    return;
  }

  // 명령어
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/stop') {
      if (activeSessions.has(chatId)) { activeSessions.delete(chatId); await bot.sendMessage(chatId, '🛑 중단됨'); }
      else await bot.sendMessage(chatId, 'ℹ️ 실행 중인 작업 없음');
      return;
    }
    if (cmd === '/reset') {
      chatSessions.delete(chatId); saveSessions(chatSessions);
      await bot.sendMessage(chatId, '🔄 세션 초기화됨'); return;
    }
    if (cmd === '/help') {
      await bot.sendMessage(chatId, '*ClawBrid 명령어*\n• /stop 작업 중단\n• /reset 세션 초기화\n• /cron list|add|del|run|on|off 크론 관리\n• /help 도움말');
      return;
    }
    if (cmd === '/cron') {
      const cronManager = require('../core/cron-manager');
      const parts = text.split(/\s+/).slice(1);
      const sub = (parts[0] || 'list').toLowerCase();

      if (sub === 'list') {
        const crons = cronManager.loadCrons();
        if (!crons.length) { await bot.sendMessage(chatId, '등록된 크론 작업이 없습니다.'); return; }
        const list = crons.map(c => {
          const st = c.enabled ? '🟢' : '⚪';
          const last = c.lastRun ? new Date(c.lastRun).toLocaleTimeString('ko-KR') : '-';
          return `${st} *${c.name}* | ${c.type} | ${c.intervalMin}분 | 마지막: ${last}`;
        }).join('\n');
        await bot.sendMessage(chatId, `⏰ 크론 작업 목록\n${list}`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'add') {
        const name = parts[1]; const interval = parseInt(parts[2]); const command = parts.slice(3).join(' ');
        if (!name || !interval || !command) { await bot.sendMessage(chatId, '사용법: /cron add [이름] [간격(분)] [명령]'); return; }
        const isShell = command.startsWith('!');
        const cron = cronManager.addCron({ name, type: isShell ? 'shell' : 'claude', command: isShell ? command.slice(1) : command, intervalMin: interval, target: 'telegram' });
        cronManager.startCron(cron);
        await bot.sendMessage(chatId, `✅ 크론 추가: *${name}* (${interval}분 간격)`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'del' || sub === 'rm') {
        const name = parts.slice(1).join(' ');
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === name);
        if (!found) { await bot.sendMessage(chatId, `❌ "${name}" 없음`); return; }
        cronManager.removeCron(found.id);
        await bot.sendMessage(chatId, `🗑️ 삭제: *${name}*`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'run') {
        const name = parts.slice(1).join(' ');
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === name);
        if (!found) { await bot.sendMessage(chatId, `❌ "${name}" 없음`); return; }
        await bot.sendMessage(chatId, `⏳ 실행 중: *${name}*`, { parse_mode: 'Markdown' });
        await cronManager.executeCron(found);
        const updated = cronManager.loadCrons().find(c => c.id === found.id);
        await bot.sendMessage(chatId, `✅ 완료: ${updated?.lastResult || '(결과 없음)'}`); return;
      }
      if (sub === 'on' || sub === 'off') {
        const name = parts.slice(1).join(' ');
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === name);
        if (!found) { await bot.sendMessage(chatId, `❌ "${name}" 없음`); return; }
        cronManager.toggleCron(found.id);
        await bot.sendMessage(chatId, `${sub === 'on' ? '🟢 활성화' : '⚪ 비활성화'}: *${name}*`, { parse_mode: 'Markdown' }); return;
      }
      await bot.sendMessage(chatId, '사용법: /cron list|add|del|run|on|off'); return;
    }
    if (cmd === '/adduser' && isAdmin(userId)) {
      const targetId = text.split(' ')[1];
      if (targetId) {
        const cfg = config.load();
        if (!cfg.telegram.allowedUsers.includes(targetId)) {
          cfg.telegram.allowedUsers.push(targetId);
          config.save(cfg);
        }
        await bot.sendMessage(chatId, `✅ 사용자 ${targetId} 추가됨`);
      }
      return;
    }
    if (cmd === '/removeuser' && isAdmin(userId)) {
      const targetId = text.split(' ')[1];
      if (targetId) {
        const cfg = config.load();
        cfg.telegram.allowedUsers = cfg.telegram.allowedUsers.filter(id => String(id) !== targetId);
        config.save(cfg);
        await bot.sendMessage(chatId, `✅ 사용자 ${targetId} 제거됨`);
      }
      return;
    }
    if (cmd === '/start') return; // Telegram 기본 명령
  }

  if (activeSessions.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ 이전 작업 진행 중. /stop으로 중단 가능');
    return;
  }

  const startMsg = await bot.sendMessage(chatId, '⏳ 작업 진행중...');
  const resumeSessionId = chatSessions.get(chatId) || null;

  try {
    activeSessions.set(chatId, true);
    status.start(text || '[파일 첨부]', userId, chatId);

    let prompt = text;

    if (hasDocument) {
      const dl = await downloadTelegramFile(msg.document.file_id);
      if (dl) {
        const info = `[첨부파일] ${msg.document.file_name || dl.name} (${(dl.size/1024).toFixed(1)}KB)\n경로: ${dl.path}`;
        prompt = prompt ? `${prompt}\n\n--- 첨부파일 ---\n${info}\n\n위 첨부파일을 Read 도구로 직접 읽어줘.` : `첨부파일을 분석해줘:\n\n${info}`;
      }
    }
    if (hasPhoto) {
      const photo = msg.photo[msg.photo.length - 1];
      const dl = await downloadTelegramFile(photo.file_id);
      if (dl) {
        const info = `[이미지] ${dl.name} (${(dl.size/1024).toFixed(1)}KB)\n경로: ${dl.path}`;
        prompt = prompt ? `${prompt}\n\n--- 이미지 ---\n${info}\n\n이미지를 Read 도구로 확인해줘.` : `이미지를 분석해줘:\n\n${info}`;
      }
    }

    addToHistory(chatId, 'user', prompt);

    let finalPrompt = prompt;
    if (!resumeSessionId) {
      const ctx = getRecentHistory(chatId);
      const pastKeywords = ['이전에', '전에', '지난번', '예전에', '며칠전', '저번에', '과거', '기억', '얘기했'];
      const needsSearch = pastKeywords.some(k => prompt.includes(k));
      let searchCtx = '';
      if (needsSearch) {
        const cleaned = prompt.replace(/이전에|전에|지난번|예전에|며칠전|저번에|과거에?|기억|얘기했\w*/g, '').trim();
        const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
        for (const w of words) {
          const found = searchHistory(chatId, w);
          if (found) { searchCtx += found; break; }
        }
        if (!searchCtx) searchCtx = getRecentHistory(chatId, 7);
      }
      if (ctx || searchCtx) finalPrompt = `${ctx}${searchCtx}현재 메시지: ${prompt}`;
    }

    // 비관리자 제한
    const claudeOptions = { resumeSessionId };
    if (!isAdmin(userId)) {
      claudeOptions.allowedTools = ['WebSearch', 'WebFetch'];
      claudeOptions.appendSystemPrompt = '너는 일반 사용자의 질문에 답변하는 AI입니다. 파일 시스템 접근, 코드 실행, 시스템 명령은 사용하지 마세요.';
    }

    const result = await runClaude(finalPrompt, claudeOptions);

    const newSession = extractSessionId(result);
    if (newSession) { chatSessions.set(chatId, newSession); saveSessions(chatSessions); }

    const responseText = extractText(result);
    addToHistory(chatId, 'assistant', responseText);
    status.done(responseText);

    try { await bot.editMessageText('✅ 작업 완료', { chat_id: chatId, message_id: startMsg.message_id }); } catch {}
    await sendLongMessage(chatId, responseText);

    // 코드 변경이 있으면 자동 Codex 리뷰
    if (hasCodeChanges()) {
      try {
        await bot.sendMessage(chatId, '🔍 Codex 리뷰 실행중...');
        const review = await runCodexReview();
        if (review) await sendLongMessage(chatId, `📋 Codex Review\n${review}`);
        else await bot.sendMessage(chatId, '✅ Codex 리뷰: 이슈 없음');
      } catch {}
    }

  } catch (err) {
    console.error(`[TG ERROR] ${err.message}`);
    status.error(err.message);
    if (err.message.includes('session') || err.message.includes('resume')) {
      chatSessions.delete(chatId); saveSessions(chatSessions);
    }
    try { await bot.editMessageText('❌ 작업 실패', { chat_id: chatId, message_id: startMsg.message_id }); } catch {}
    await bot.sendMessage(chatId, `❌ 오류:\n${err.message}`);
  } finally {
    activeSessions.delete(chatId);
  }
}

// ── 시작/중지 ──
async function start() {
  const cfg = config.load();
  if (!cfg.telegram.enabled || !cfg.telegram.botToken) {
    console.log('[TELEGRAM] Disabled or token not set');
    return false;
  }

  status = new StatusReporter('telegram');

  bot = new TelegramBot(cfg.telegram.botToken, { polling: true });
  bot.on('message', handleMessage);

  console.log('[TELEGRAM] Bridge started');
  return true;
}

async function stop() {
  if (bot) { bot.stopPolling(); bot = null; }
  if (status) { status.destroy(); status = null; }
  console.log('[TELEGRAM] Bridge stopped');
}

module.exports = { start, stop };
