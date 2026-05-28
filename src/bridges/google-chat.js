/**
 * ClawBrid - Google Chat Bridge (Pub/Sub 기반)
 *
 * 흐름:
 *   사용자 → Google Chat → Chat App config(Pub/Sub topic)
 *     → Pub/Sub topic → pull subscription
 *       → 이 모듈에서 수신 → agent-router.runAgent
 *         → REST POST spaces/{space}/messages 로 응답
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../core/config');
const StatusReporter = require('../core/status-reporter');
const { runCodexReview, hasCodeChanges } = require('../core/claude-runner');
const agentRouter = require('../core/agent-router');
const memory = require('../core/memory-manager');
const plugins = require('../core/plugin-manager');
const knowledgeGraph = require('../core/knowledge-graph');
const promptStructurer = require('../core/prompt-structurer');

let pubsub = null;
let subscription = null;
let auth = null;
let botName = null; // "users/123456789" 형태, 멘션 제거용
let status = null;

const CHAT_API = 'chat.googleapis.com';
const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

const activeSessions = new Map();        // spaceId → child process
const messageQueue = new Map();          // spaceId → 큐
const MAX_QUEUE_SIZE = 5;
const seenMessageIds = new Map();        // 중복 ack 방지 (id → ts)
const SEEN_TTL_MS = 5 * 60 * 1000;

// ── 권한 ──
function isAdmin(userResource) {
  const cfg = config.load();
  return userResource && userResource === cfg.googlechat?.adminUser;
}
function isAllowed(userResource) {
  if (isAdmin(userResource)) return true;
  const cfg = config.load();
  return (cfg.googlechat?.allowedUsers || []).includes(userResource);
}

// ── 대화 기록 (일별 MD) ──
function getHistoryDir(spaceId) {
  const safe = String(spaceId).replace(/[\\/:*?"<>|]/g, '_');
  const dir = path.join(config.HISTORY_DIR, `gchat_${safe}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getTodayPath(spaceId) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getHistoryDir(spaceId), `${date}.md`);
}
function addToHistory(spaceId, role, content, agent) {
  try {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let label;
    if (role === 'user') label = '사용자';
    else if (agent === 'codex') label = 'Codex';
    else label = 'Claude';
    fs.appendFileSync(getTodayPath(spaceId), `### ${label} (${now})\n${content}\n\n`, 'utf-8');
  } catch (err) { console.error(`[GCHAT] addToHistory error: ${err.message}`); }
}
function getRecentHistory(spaceId, days = 3) {
  try {
    const dir = getHistoryDir(spaceId);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
    if (!files.length) return '';
    const recent = files.slice(0, days).reverse();
    let combined = '';
    for (const f of recent) {
      combined += `## ${f.replace('.md', '')}\n`;
      combined += fs.readFileSync(path.join(dir, f), 'utf-8');
    }
    return `--- 최근 ${days}일 대화 기록 ---\n${combined}--- 대화 기록 끝 ---\n\n`;
  } catch { return ''; }
}

// ── Chat REST 호출 ──
async function getAccessToken() {
  if (!auth) throw new Error('GoogleAuth 미초기화');
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  return typeof t === 'string' ? t : t.token;
}

function chatRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    getAccessToken().then((token) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        host: CHAT_API,
        path: pathname,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
          } else {
            reject(new Error(`Chat API ${res.statusCode}: ${buf.slice(0, 500)}`));
          }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    }).catch(reject);
  });
}

async function sendMessage(spaceName, text, threadName) {
  const body = { text };
  if (threadName) body.thread = { name: threadName };
  return chatRequest('POST', `/v1/${spaceName}/messages`, body);
}

async function sendLongMessage(spaceName, text, threadName) {
  const MAX = 3900; // 4096 - 안전마진
  let remaining = String(text || '');
  if (!remaining) return;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { await sendMessage(spaceName, remaining, threadName); break; }
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut === -1 || cut < MAX * 0.5) cut = MAX;
    await sendMessage(spaceName, remaining.slice(0, cut), threadName);
    remaining = remaining.slice(cut);
  }
}

// ── 첨부 다운로드 ──
async function downloadAttachment(att) {
  // attachment.attachmentDataRef.resourceName 또는 driveDataRef.driveFileId
  // Chat 업로드 파일은 media.download 엔드포인트로 다운로드
  try {
    const fileName = att.contentName || `attachment_${Date.now()}`;
    const safe = fileName.replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(config.DOWNLOADS_DIR, `${Date.now()}_${safe}`);
    if (att.attachmentDataRef?.resourceName) {
      const token = await getAccessToken();
      const resourceName = encodeURIComponent(att.attachmentDataRef.resourceName);
      const url = `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`;
      await new Promise((resolve, reject) => {
        https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const ws = fs.createWriteStream(dest);
          res.pipe(ws);
          ws.on('finish', () => { ws.close(); resolve(); });
          ws.on('error', reject);
        }).on('error', reject);
      });
      return { ok: true, path: dest, name: fileName, size: fs.statSync(dest).size };
    }
    return { ok: false, reason: 'unsupported', message: '드라이브 첨부는 v1에서 미지원', name: fileName };
  } catch (err) {
    console.error(`[GCHAT FILE ERROR] ${err.message}`);
    return { ok: false, reason: 'other', message: err.message, name: att.contentName || '' };
  }
}

// ── 멘션 제거 ──
function stripMention(text) {
  if (!text || !botName) return text || '';
  // botName: "users/123456789" → 메시지에서 "@봇이름" 또는 "<users/123456789>" 제거
  // 안전하게: @로 시작하는 첫 단어 제거 (봇 멘션 가정)
  return text.replace(/^@\S+\s*/, '').trim();
}

// ── 메인 핸들러 ──
async function handleMessage(event) {
  const msg = event?.message;
  if (!msg) return;
  const messageId = msg.name; // "spaces/AAA/messages/BBB"
  if (!messageId) return;

  // 중복 처리 방지
  const now = Date.now();
  for (const [k, t] of seenMessageIds) if (now - t > SEEN_TTL_MS) seenMessageIds.delete(k);
  if (seenMessageIds.has(messageId)) return;
  seenMessageIds.set(messageId, now);

  const space = msg.space?.name; // "spaces/AAA"
  const spaceId = space || messageId.split('/').slice(0, 2).join('/');
  const sender = msg.sender?.name; // "users/123"
  const threadName = msg.thread?.name;
  let text = stripMention(msg.text || msg.argumentText || '');
  const attachments = msg.attachment || msg.attachments || [];

  console.log(`[GCHAT] 메시지 수신 | user=${sender} | ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}${attachments.length ? ` | 첨부${attachments.length}` : ''}`);

  if (!text && attachments.length === 0) return;

  if (!isAllowed(sender)) {
    await sendMessage(space, '🚫 권한이 없습니다. 관리자에게 요청해주세요.', threadName).catch(() => {});
    return;
  }

  // 명령어
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/stop') {
      const proc = activeSessions.get(spaceId);
      if (proc) { proc.kill('SIGTERM'); activeSessions.delete(spaceId); await sendMessage(space, '🛑 중단됨', threadName); }
      else await sendMessage(space, 'ℹ️ 실행 중인 작업 없음', threadName);
      return;
    }
    if (cmd === '/reset') {
      agentRouter.clearAll('gchat', spaceId);
      await sendMessage(space, '🔄 세션 초기화됨', threadName); return;
    }
    if (cmd === '/agent') {
      const target = (text.split(/\s+/)[1] || '').toLowerCase();
      const current = agentRouter.getActiveAgent('gchat', spaceId);
      const globalDefault = agentRouter.getGlobalDefault();
      if (!target) {
        await sendMessage(space, `🤖 현재 Agent: *${current}*\n🌐 글로벌 기본: *${globalDefault}*\n전환: /agent claude  또는  /agent codex`, threadName);
        return;
      }
      if (!isAdmin(sender)) {
        await sendMessage(space, '🚫 Agent 전환은 관리자만 가능합니다.', threadName); return;
      }
      if (!agentRouter.isValidAgent(target)) {
        await sendMessage(space, `❌ 알 수 없는 agent: ${target}`, threadName); return;
      }
      if (target === 'codex') {
        const codexRunner = require('../core/codex-runner');
        if (!codexRunner.isCodexReady()) {
          await sendMessage(space, '❌ Codex CLI가 설치되지 않았거나 인증이 필요합니다 (codex login)', threadName); return;
        }
      }
      agentRouter.setActiveAgent('gchat', spaceId, target);
      const resumeId = agentRouter.getResumeSessionId('gchat', spaceId, target);
      await sendMessage(space, `✅ 이 채팅의 Agent → *${target}* ${resumeId ? '(이전 세션 이어감)' : '(새 세션 시작)'}`, threadName);
      return;
    }
    if (cmd === '/help') {
      await sendMessage(space, `*ClawBrid (Google Chat)*\n• /agent [claude|codex] 이 채팅의 AI 전환\n• /stop 작업 중단\n• /reset 세션 초기화\n• /help 도움말`, threadName);
      return;
    }
  }

  if (activeSessions.has(spaceId)) {
    const queue = messageQueue.get(spaceId) || [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      await sendMessage(space, `❌ 대기열이 가득 찼습니다 (${MAX_QUEUE_SIZE}개)`, threadName); return;
    }
    queue.push(event);
    messageQueue.set(spaceId, queue);
    await sendMessage(space, `📋 대기열에 추가됨 (${queue.length}번째)`, threadName);
    return;
  }

  const activeAgent = agentRouter.getActiveAgent('gchat', spaceId);
  await sendMessage(space, `⏳ 작업 진행중 (${activeAgent})`, threadName);
  const resumeSessionId = agentRouter.getResumeSessionId('gchat', spaceId, activeAgent);

  try {
    if (status) status.start(text || '[파일 첨부]', sender, spaceId);

    let prompt = text;
    if (promptStructurer.shouldStructure(text)) {
      try {
        const structured = await promptStructurer.structurePrompt(text);
        if (structured && structured !== text) prompt = structured;
      } catch {}
    }

    // 첨부
    if (attachments.length) {
      const dls = await Promise.all(attachments.map(downloadAttachment));
      const valid = dls.filter((d) => d.ok);
      const failed = dls.filter((d) => !d.ok);
      for (const f of failed) {
        try { await sendMessage(space, `⚠️ 첨부 다운로드 실패: ${f.message || f.reason}`, threadName); } catch {}
      }
      if (valid.length) {
        const lines = valid.map((dl, i) => {
          const label = valid.length > 1 ? `[첨부파일 ${i + 1}/${valid.length}]` : '[첨부파일]';
          return `${label} ${dl.name} (${(dl.size / 1024).toFixed(1)}KB)\n경로: ${dl.path}`;
        });
        const info = lines.join('\n\n');
        prompt = prompt
          ? `${prompt}\n\n--- 첨부파일 ---\n${info}\n\n위 첨부파일을 Read 도구로 직접 읽어줘.`
          : `첨부파일을 분석해줘:\n\n${info}`;
      }
    }

    addToHistory(spaceId, 'user', prompt, activeAgent);

    let finalPrompt = prompt;
    if (!resumeSessionId) {
      const ctx = getRecentHistory(spaceId);
      if (ctx) finalPrompt = `${ctx}현재 메시지: ${prompt}`;
    }

    const memoryCtx = memory.getRelevantContext(prompt);
    if (memoryCtx) finalPrompt = `${memoryCtx}${finalPrompt}`;
    const graphCtx = knowledgeGraph.getRelevantContext(prompt);
    if (graphCtx) finalPrompt = `${graphCtx}${finalPrompt}`;
    finalPrompt = plugins.runBeforePrompt(finalPrompt, { userId: sender, chatId: spaceId, source: 'gchat' });

    const runOptions = { resumeSessionId };
    if (activeAgent === 'claude') {
      if (isAdmin(sender)) {
        runOptions.isAdmin = true;
        runOptions.appendSystemPrompt = `${memory.MEMORY_SYSTEM_PROMPT}\n${knowledgeGraph.GRAPH_SYSTEM_PROMPT}`;
      } else {
        runOptions.allowedTools = ['WebSearch', 'WebFetch', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'mcp__clawbrid-image__image_generate'];
        runOptions.appendSystemPrompt = '너는 일반 사용자의 질문에 답변하는 AI입니다. 코드 실행과 시스템 명령은 사용하지 마세요. 첨부파일이 있으면 Read 도구로 해당 경로만 읽어 답변하세요.';
      }
    } else {
      runOptions.appendSystemPrompt = `${memory.MEMORY_SYSTEM_PROMPT}\n${knowledgeGraph.GRAPH_SYSTEM_PROMPT}`;
    }

    const { promise, proc } = agentRouter.runAgent(activeAgent, finalPrompt, runOptions);
    activeSessions.set(spaceId, proc);
    const result = await promise;

    const newSession = agentRouter.extractSessionId(activeAgent, result);
    if (newSession) agentRouter.updateSessionId('gchat', spaceId, activeAgent, newSession);

    let responseText = agentRouter.extractText(activeAgent, result);

    const { cleaned, saved } = memory.extractAndSave(responseText, 'gchat-auto');
    if (saved.length > 0) {
      responseText = cleaned;
      for (const s of saved) knowledgeGraph.indexMemory(s.key, s.value);
    }
    const graphResult = knowledgeGraph.extractAndIndex(responseText);
    if (graphResult.indexed.length > 0) responseText = graphResult.cleaned;
    responseText = plugins.runAfterResponse(responseText, { userId: sender, chatId: spaceId, source: 'gchat' });

    addToHistory(spaceId, 'assistant', responseText, activeAgent);
    if (status) status.done(responseText);
    console.log(`[GCHAT] 응답 완료 | agent=${activeAgent} | user=${sender} | ${responseText.slice(0, 100)}`);

    await sendLongMessage(space, responseText, threadName);

    if (hasCodeChanges()) {
      try {
        await sendMessage(space, '🔍 Codex 리뷰 실행중...', threadName);
        const review = await runCodexReview();
        if (review) await sendLongMessage(space, `📋 Codex Review\n${review}`, threadName);
        else await sendMessage(space, '✅ Codex 리뷰: 이슈 없음', threadName);
      } catch {}
    }
  } catch (err) {
    console.error(`[GCHAT] 에러 | agent=${activeAgent} | user=${sender} | ${err.message}`);
    if (status) status.error(err.message);
    if (err.message.includes('session') || err.message.includes('resume')) {
      agentRouter.clearSession('gchat', spaceId, activeAgent);
    }
    try { await sendMessage(space, `❌ 오류: ${err.message}`, threadName); } catch {}
  } finally {
    activeSessions.delete(spaceId);
    const queue = messageQueue.get(spaceId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) messageQueue.delete(spaceId);
      else messageQueue.set(spaceId, queue);
      setImmediate(() => handleMessage(next));
    }
  }
}

// ── 시작/중지 ──
async function start() {
  const cfg = config.load();
  const gc = cfg.googlechat || {};
  if (!gc.enabled || !gc.projectId || !gc.subscriptionName || !gc.serviceAccountKeyPath) {
    console.log('[GCHAT] Disabled or required config missing (projectId/subscriptionName/serviceAccountKeyPath)');
    return false;
  }
  if (!fs.existsSync(gc.serviceAccountKeyPath)) {
    console.error(`[GCHAT] Service account key not found: ${gc.serviceAccountKeyPath}`);
    return false;
  }

  status = new StatusReporter('googlechat');
  plugins.loadAll();

  const { PubSub } = require('@google-cloud/pubsub');
  const { GoogleAuth } = require('google-auth-library');

  pubsub = new PubSub({ projectId: gc.projectId, keyFilename: gc.serviceAccountKeyPath });
  auth = new GoogleAuth({ keyFilename: gc.serviceAccountKeyPath, scopes: [CHAT_SCOPE] });

  // 봇 식별자 (인증 정보의 client_email 또는 service account를 통해 봇 이름 추정 — 선택)
  try {
    const keyJson = JSON.parse(fs.readFileSync(gc.serviceAccountKeyPath, 'utf-8'));
    botName = keyJson.client_email || null;
  } catch {}

  subscription = pubsub.subscription(gc.subscriptionName);
  subscription.on('message', async (message) => {
    try {
      const data = JSON.parse(message.data.toString('utf-8'));
      // Chat App Pub/Sub 이벤트는 data 자체가 event payload
      await handleMessage(data);
      message.ack();
    } catch (err) {
      console.error(`[GCHAT] message handling error: ${err.message}`);
      // nack — Pub/Sub가 재시도. dead-letter는 GCP 측에서 설정
      message.nack();
    }
  });
  subscription.on('error', (err) => {
    console.error(`[GCHAT] subscription error: ${err.message}`);
  });

  console.log(`[GCHAT] Bridge started (subscription: ${gc.subscriptionName}, project: ${gc.projectId})`);
  return true;
}

async function stop() {
  if (subscription) {
    try { await subscription.close(); } catch {}
    subscription = null;
  }
  if (pubsub) {
    try { await pubsub.close(); } catch {}
    pubsub = null;
  }
  if (status) { status.destroy(); status = null; }
  console.log('[GCHAT] Bridge stopped');
}

module.exports = { start, stop };
