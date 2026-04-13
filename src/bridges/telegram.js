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
const memory = require('../core/memory-manager');
const plugins = require('../core/plugin-manager');
const voice = require('../core/voice-transcriber');
const webTools = require('../core/web-tools');
const knowledgeGraph = require('../core/knowledge-graph');
const videoAnalyzer = require('../core/video-analyzer');

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
  } catch (err) { console.error(`[TG] loadSessions error: ${err.message}`); }
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
  } catch (err) { console.error(`[TG] saveSessions error: ${err.message}`); }
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
  } catch (err) { console.error(`[TG] addToHistory error: ${err.message}`); }
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
  } catch (err) { console.error(`[TG] getRecentHistory error: ${err.message}`); }
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
  } catch (err) { console.error(`[TG] searchHistory error: ${err.message}`); }
  return '';
}

// ── 파일 다운로드 ──
async function downloadTelegramFile(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${config.load().telegram.botToken}/${file.file_path}`;
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
const messageQueue = new Map(); // 채팅별 작업 큐 (최대 5개)
const MAX_QUEUE_SIZE = 5;
const chatSessions = loadSessions();

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  let text = msg.text?.trim() || '';
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = !!msg.document;
  const hasVoice = !!(msg.voice || msg.audio);
  console.log(`[TG] 메시지 수신 | user=${userId} | ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);

  // 음성 메시지 처리
  if (hasVoice && !text) {
    if (!voice.isAvailable()) {
      await bot.sendMessage(chatId, '⚠️ faster-whisper 설치 중이거나 실패했습니다. 로그를 확인하세요.');
      return;
    }
    try {
      const fileId = (msg.voice || msg.audio).file_id;
      const dl = await downloadTelegramFile(fileId);
      if (!dl) { await bot.sendMessage(chatId, '❌ 음성 파일 다운로드 실패'); return; }
      await bot.sendMessage(chatId, '🎤 음성 변환 중...');
      text = await voice.transcribe(dl.path);
      if (!text) { await bot.sendMessage(chatId, '❌ 음성에서 텍스트를 인식하지 못했습니다.'); return; }
      await bot.sendMessage(chatId, `📝 인식된 텍스트: "${text}"`);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ 음성 변환 오류: ${err.message}`);
      return;
    }
  }

  if (!text && !hasPhoto && !hasDocument) return;

  // 권한 체크
  if (!isAllowed(userId)) {
    await bot.sendMessage(chatId, '🚫 권한이 없습니다. 관리자에게 요청해주세요.');
    return;
  }

  // 명령어 처리 (handled=true면 return, null이면 Claude로 진행)
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    let browsePassthrough = null; // /browse+질문 시 Claude에 넘길 텍스트
    if (cmd === '/stop') {
      if (activeSessions.has(chatId)) { const p = activeSessions.get(chatId); p.kill('SIGTERM'); activeSessions.delete(chatId); await bot.sendMessage(chatId, '🛑 중단됨'); }
      else await bot.sendMessage(chatId, 'ℹ️ 실행 중인 작업 없음');
      return;
    }
    if (cmd === '/reset') {
      chatSessions.delete(chatId); saveSessions(chatSessions);
      await bot.sendMessage(chatId, '🔄 세션 초기화됨'); return;
    }
    if (cmd === '/help') {
      const pluginCmds = plugins.getList().flatMap(p => p.commands).filter(c => c.startsWith('/'));
      const pluginHelp = pluginCmds.length ? `\n• 플러그인: ${pluginCmds.join(', ')}` : '';
      await bot.sendMessage(chatId, `*ClawBrid 명령어*\n• /stop 작업 중단\n• /reset 세션 초기화\n• /queue 대기열 확인\n• /clear 대기열 비우기\n• /search [검색어] 웹 검색\n• /browse [URL] [질문] 웹페이지 분석\n• /ultraplan [주제] 심층 분석 + 실행 계획\n• /youtube [URL] [질문] 영상 분석 (프레임+음성)\n• /image [프롬프트] AI 이미지 생성 (Stable Diffusion)\n• /graph stats|add|link|find|del|list 지식 그래프\n• /memory list|add|del|search 장기 메모리\n• /plugins 플러그인 목록\n• /cron list|add|del|run|on|off 크론 관리\n• /help 도움말\n• 🎤 음성 메시지 → 자동 텍스트 변환${pluginHelp}`);
      return;
    }
    if (cmd === '/ultraplan') {
      const topic = text.split(/\s+/).slice(1).join(' ');
      if (!topic) { await bot.sendMessage(chatId, '사용법: /ultraplan [분석할 주제/작업]\n예: /ultraplan 서버 성능 최적화 방안'); return; }
      text = `[ULTRAPLAN 모드] 아래 주제에 대해 심층 분석하고 구조화된 실행 계획을 작성해줘.

## 분석 주제
${topic}

## 출력 형식 (반드시 아래 구조를 따를 것)

### 1. 현황 분석
- 현재 상태와 문제점 파악
- 관련 기술/시스템 분석

### 2. 접근 방식 비교
- 최소 2가지 이상의 방안 제시
- 각 방안의 장단점, 난이도, 소요 시간

### 3. 추천안 + 근거
- 최적의 방안 선택 이유

### 4. 실행 계획 (단계별)
- 각 단계의 구체적 작업 내용
- 수정할 파일/코드/설정 명시
- 예상 소요 시간

### 5. 리스크 및 대응
- 예상 위험 요소
- 롤백/대응 방안

### 6. 검증 방법
- 완료 확인 기준
- 테스트 전략`;
      chatSessions.delete(chatId);
      saveSessions(chatSessions);
      await bot.sendMessage(chatId, '🧠 *UltraPlan* 심층 분석을 시작합니다...', { parse_mode: 'Markdown' });
      // fall through — browsePassthrough is null, so goes to Claude execution
    }
    // ── 영상 분석 명령어 ──
    if (cmd === '/youtube' || cmd === '/video') {
      const args = text.split(/\s+/).slice(1).join(' ');
      const urlMatch = args.match(/(https?:\/\/\S+)/);
      if (!urlMatch) { await bot.sendMessage(chatId, '사용법: /youtube [URL] [질문]\n예: /youtube https://youtube.com/watch?v=xxx 핵심 내용 요약해줘'); return; }
      const videoUrl = urlMatch[1];
      const question = args.replace(videoUrl, '').trim();

      try {
        const sendProgress = async (msg) => {
          try { await bot.sendMessage(chatId, msg); } catch {}
        };

        await sendProgress('🎬 영상 분석을 시작합니다...');
        const result = await videoAnalyzer.analyzeVideo(videoUrl, question, sendProgress);
        await bot.sendMessage(chatId, `📹 *${result.title}* 분석 완료! Claude에게 전달 중...`, { parse_mode: 'Markdown' });

        chatSessions.delete(chatId);
        saveSessions(chatSessions);
        text = result.prompt;
        setTimeout(() => videoAnalyzer.cleanup(result.tempDir), 600000);
        // fall through to Claude execution
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 영상 분석 실패: ${e.message}`);
        return;
      }
    }
    // ── 이미지 생성 명령어 ──
    if (cmd === '/image') {
      const prompt = text.split(/\s+/).slice(1).join(' ');
      if (!prompt) { await bot.sendMessage(chatId, '사용법: /image [프롬프트]\n예: /image a beautiful sunset over mountains, digital art'); return; }

      try {
        await bot.sendMessage(chatId, '🎨 이미지 생성 중... (Stable Diffusion)');
        const imageGen = require('../core/image-generator');
        const result = await imageGen.generate({ prompt });
        const img = result.images[0];
        await bot.sendPhoto(chatId, img.path, { caption: `🎨 프롬프트: ${prompt.slice(0, 200)}` });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 이미지 생성 실패: ${e.message}`);
      }
      return;
    }
    if (cmd === '/memory') {
      const parts = text.split(/\s+/).slice(1);
      const sub = (parts[0] || 'list').toLowerCase();

      if (sub === 'list') {
        const all = memory.getAll();
        if (!all.length) { await bot.sendMessage(chatId, 'ℹ️ 저장된 메모리가 없습니다.'); return; }
        const list = all.map(m => `• *${m.key}*: ${m.value} _(${m.source})_`).join('\n');
        await bot.sendMessage(chatId, `🧠 메모리 (${all.length}개)\n${list}`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'add') {
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        if (!key || !value) { await bot.sendMessage(chatId, '사용법: /memory add [키] [값]'); return; }
        memory.add(key, value, 'telegram');
        await bot.sendMessage(chatId, `✅ 메모리 저장: *${key}* = ${value}`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'del' || sub === 'delete') {
        const key = parts.slice(1).join(' ');
        if (!key) { await bot.sendMessage(chatId, '사용법: /memory del [키]'); return; }
        if (memory.remove(key)) await bot.sendMessage(chatId, `🗑️ 메모리 삭제: *${key}*`, { parse_mode: 'Markdown' });
        else await bot.sendMessage(chatId, `❌ "${key}" 메모리를 찾을 수 없습니다.`);
        return;
      }
      if (sub === 'search') {
        const keyword = parts.slice(1).join(' ');
        if (!keyword) { await bot.sendMessage(chatId, '사용법: /memory search [키워드]'); return; }
        const found = memory.search(keyword);
        if (!found.length) { await bot.sendMessage(chatId, `ℹ️ "${keyword}" 관련 메모리 없음`); return; }
        const list = found.map(m => `• *${m.key}*: ${m.value}`).join('\n');
        await bot.sendMessage(chatId, `🔍 검색 결과 (${found.length}건)\n${list}`, { parse_mode: 'Markdown' }); return;
      }
      await bot.sendMessage(chatId, '사용법: /memory list|add|del|search'); return;
    }
    if (cmd === '/queue') {
      const queue = messageQueue.get(chatId) || [];
      if (!queue.length) { await bot.sendMessage(chatId, 'ℹ️ 대기열이 비어 있습니다.'); return; }
      const list = queue.map((q, i) => `${i + 1}. ${(q.text || '[파일]').slice(0, 50)}`).join('\n');
      await bot.sendMessage(chatId, `📋 대기열 (${queue.length}/${MAX_QUEUE_SIZE})\n${list}`); return;
    }
    if (cmd === '/clear') {
      messageQueue.delete(chatId);
      await bot.sendMessage(chatId, '🗑️ 대기열 비워짐'); return;
    }
    if (cmd === '/plugins') {
      const list = plugins.getList();
      if (!list.length) { await bot.sendMessage(chatId, 'ℹ️ 로드된 플러그인이 없습니다.'); return; }
      const info = list.map(p => `• *${p.name}*: ${p.description || '-'} | 명령: ${p.commands.join(', ') || '없음'}`).join('\n');
      await bot.sendMessage(chatId, `🧩 플러그인 (${list.length}개)\n${info}`, { parse_mode: 'Markdown' }); return;
    }
    if (cmd === '/reload-plugins') {
      plugins.reload();
      const list = plugins.getList();
      await bot.sendMessage(chatId, `🔄 플러그인 리로드 완료 (${list.length}개)`); return;
    }
    // 플러그인 커스텀 명령어 매칭
    const pluginMatch = plugins.matchCommand(text);
    if (pluginMatch) {
      try {
        const ctx = { userId, chatId, source: 'telegram', args: text.split(/\s+/).slice(1).join(' ') };
        const result = await pluginMatch.handler(ctx);
        if (result) await bot.sendMessage(chatId, String(result));
      } catch (err) {
        await bot.sendMessage(chatId, `❌ 플러그인 오류 (${pluginMatch.plugin.name}): ${err.message}`);
      }
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
          return `${st} *${c.name}* | ${c.type} | ${c.schedule} | 마지막: ${last}`;
        }).join('\n');
        await bot.sendMessage(chatId, `⏰ 크론 작업 목록\n${list}`, { parse_mode: 'Markdown' }); return;
      }
      if (sub === 'add') {
        const name = parts[1]; const interval = parseInt(parts[2]); const command = parts.slice(3).join(' ');
        if (!name || !interval || !command) { await bot.sendMessage(chatId, '사용법: /cron add [이름] [간격(분)] [명령]'); return; }
        const isShell = command.startsWith('!');
        if (isShell && !isAdmin(userId)) {
          await bot.sendMessage(chatId, '🚫 쉘 명령 크론은 관리자만 등록할 수 있습니다.'); return;
        }
        const cron = cronManager.addCron({ name, type: isShell ? 'shell' : 'claude', command: isShell ? command.slice(1) : command, schedule: `*/${interval} * * * *`, target: 'telegram' });
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
    // ── 웹 검색 ──
    if (cmd === '/search') {
      const query = text.split(/\s+/).slice(1).join(' ');
      if (!query) { await bot.sendMessage(chatId, '사용법: /search [검색어]'); return; }
      try {
        await bot.sendMessage(chatId, `🔍 "${query}" 검색 중...`);
        const results = await webTools.search(query);
        await sendLongMessage(chatId, webTools.formatSearchResults(results, query));
      } catch (err) {
        await bot.sendMessage(chatId, `❌ 검색 오류: ${err.message}`);
      }
      return;
    }
    // ── 브라우저 자동화 ──
    if (cmd === '/browse') {
      const parts = text.split(/\s+/).slice(1);
      const browseUrl = parts[0];
      if (!browseUrl) { await bot.sendMessage(chatId, '사용법: /browse [URL] [질문(선택)]'); return; }
      const question = parts.slice(1).join(' ');
      try {
        await bot.sendMessage(chatId, `🌐 ${browseUrl} 불러오는 중...`);
        const result = await webTools.browse(browseUrl);
        if (question) {
          // 질문이 있으면 페이지 내용 + 질문을 Claude에게 전달
          browsePassthrough = `다음 웹페이지 내용을 기반으로 질문에 답해줘.\n\n--- 웹페이지: ${result.title} (${result.url}) ---\n${result.text}\n--- 페이지 끝 ---\n\n질문: ${question}`;
        } else {
          await sendLongMessage(chatId, webTools.formatBrowseResult(result));
          return;
        }
      } catch (err) {
        await bot.sendMessage(chatId, `❌ 브라우즈 오류: ${err.message}`);
        return;
      }
    }
    // ── Knowledge Graph ──
    if (!browsePassthrough && cmd === '/graph') {
      const parts = text.split(/\s+/).slice(1);
      const sub = (parts[0] || 'stats').toLowerCase();

      if (sub === 'stats') {
        const stats = knowledgeGraph.getStats();
        const typeStr = Object.entries(stats.types).map(([t, c]) => `${t}: ${c}`).join(', ');
        await bot.sendMessage(chatId, `📊 Knowledge Graph\n• 노드: ${stats.nodeCount}개\n• 엣지: ${stats.edgeCount}개\n• 타입: ${typeStr || '없음'}`);
        return;
      }
      if (sub === 'add') {
        const label = parts[1];
        const type = parts[2] || 'concept';
        const context = parts.slice(3).join(' ');
        if (!label) { await bot.sendMessage(chatId, '사용법: /graph add [이름] [타입] [설명]'); return; }
        knowledgeGraph.addNode(label, type, context);
        await bot.sendMessage(chatId, `✅ 노드 추가: ${label} (${type})`);
        return;
      }
      if (sub === 'link') {
        const from = parts[1];
        const relation = parts[2];
        const to = parts[3];
        if (!from || !relation || !to) { await bot.sendMessage(chatId, '사용법: /graph link [노드1] [관계] [노드2]'); return; }
        knowledgeGraph.addNode(from); knowledgeGraph.addNode(to);
        knowledgeGraph.addEdge(from, to, relation);
        await bot.sendMessage(chatId, `✅ 관계 추가: ${from} -[${relation}]-> ${to}`);
        return;
      }
      if (sub === 'find') {
        const keyword = parts.slice(1).join(' ');
        if (!keyword) { await bot.sendMessage(chatId, '사용법: /graph find [키워드]'); return; }
        const info = knowledgeGraph.getNeighbors(keyword);
        if (!info) { await bot.sendMessage(chatId, `ℹ️ "${keyword}" 노드를 찾을 수 없습니다.`); return; }
        let msg2 = `🔗 ${info.node.label} (${info.node.type})\n언급: ${info.node.mentions}회`;
        if (info.neighbors.length) {
          msg2 += '\n\n연결된 노드:\n' + info.neighbors.map(n =>
            `• ${n.direction === 'out' ? '→' : '←'} [${n.relation}] ${n.node.label} (${n.node.type})`
          ).join('\n');
        }
        await bot.sendMessage(chatId, msg2);
        return;
      }
      if (sub === 'del') {
        const label = parts.slice(1).join(' ');
        if (!label) { await bot.sendMessage(chatId, '사용법: /graph del [노드이름]'); return; }
        if (knowledgeGraph.removeNode(label)) await bot.sendMessage(chatId, `🗑️ 노드 삭제: ${label}`);
        else await bot.sendMessage(chatId, `❌ "${label}" 노드를 찾을 수 없습니다.`);
        return;
      }
      if (sub === 'list') {
        const nodes = knowledgeGraph.getAllNodes();
        if (!nodes.length) { await bot.sendMessage(chatId, 'ℹ️ 그래프가 비어 있습니다.'); return; }
        const list = nodes.slice(0, 20).map(n => `• [${n.type}] ${n.label} (${n.mentions}회)`).join('\n');
        const more = nodes.length > 20 ? `\n... 외 ${nodes.length - 20}개` : '';
        await bot.sendMessage(chatId, `📊 노드 목록 (${nodes.length}개)\n${list}${more}`);
        return;
      }
      await bot.sendMessage(chatId, '사용법: /graph stats|add|link|find|del|list');
      return;
    }
    if (!browsePassthrough && cmd === '/adduser' && isAdmin(userId)) {
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
    if (!browsePassthrough && cmd === '/removeuser' && isAdmin(userId)) {
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

    // /browse+질문 → text 교체 후 Claude 호출로 진행
    if (browsePassthrough) {
      text = browsePassthrough;
    }
  }

  if (activeSessions.has(chatId)) {
    // 큐에 추가
    const queue = messageQueue.get(chatId) || [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      await bot.sendMessage(chatId, `❌ 대기열이 가득 찼습니다 (${MAX_QUEUE_SIZE}개). /clear로 비우거나 /stop으로 현재 작업을 중단하세요.`);
      return;
    }
    queue.push(msg);
    messageQueue.set(chatId, queue);
    await bot.sendMessage(chatId, `📋 대기열에 추가됨 (${queue.length}번째). /queue로 확인`);
    return;
  }

  const startMsg = await bot.sendMessage(chatId, '⏳ 작업 진행중...');
  const resumeSessionId = chatSessions.get(chatId) || null;

  try {
    if (status) status.start(text || '[파일 첨부]', userId, chatId);

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

    // 메모리 + 지식 그래프 컨텍스트 주입
    const memoryCtx = memory.getRelevantContext(prompt);
    if (memoryCtx) finalPrompt = `${memoryCtx}${finalPrompt}`;
    const graphCtx = knowledgeGraph.getRelevantContext(prompt);
    if (graphCtx) finalPrompt = `${graphCtx}${finalPrompt}`;

    // 플러그인 전처리 훅
    finalPrompt = plugins.runBeforePrompt(finalPrompt, { userId, chatId, source: 'telegram' });

    // 관리자/비관리자 권한 분리
    const claudeOptions = { resumeSessionId };
    if (isAdmin(userId)) {
      claudeOptions.isAdmin = true;
      claudeOptions.appendSystemPrompt = `${memory.MEMORY_SYSTEM_PROMPT}\n${knowledgeGraph.GRAPH_SYSTEM_PROMPT}`;
    } else {
      claudeOptions.allowedTools = ['WebSearch', 'WebFetch'];
      claudeOptions.appendSystemPrompt = '너는 일반 사용자의 질문에 답변하는 AI입니다. 파일 시스템 접근, 코드 실행, 시스템 명령은 사용하지 마세요.';
    }

    const { promise, proc } = runClaude(finalPrompt, claudeOptions);
    activeSessions.set(chatId, proc);
    const result = await promise;

    const newSession = extractSessionId(result);
    if (newSession) { chatSessions.set(chatId, newSession); saveSessions(chatSessions); }

    let responseText = extractText(result);

    // 응답에서 메모리 자동 추출
    const { cleaned, saved } = memory.extractAndSave(responseText, 'telegram-auto');
    if (saved.length > 0) {
      responseText = cleaned;
      // 메모리를 그래프에도 인덱싱
      for (const s of saved) knowledgeGraph.indexMemory(s.key, s.value);
    }

    // 응답에서 그래프 엔티티 자동 추출
    const graphResult = knowledgeGraph.extractAndIndex(responseText);
    if (graphResult.indexed.length > 0) responseText = graphResult.cleaned;

    // 플러그인 후처리 훅
    responseText = plugins.runAfterResponse(responseText, { userId, chatId, source: 'telegram' });

    addToHistory(chatId, 'assistant', responseText);
    if (status) status.done(responseText);
    console.log(`[TG] 응답 완료 | user=${userId} | ${responseText.slice(0, 100)}${responseText.length > 100 ? '...' : ''}`);

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
    console.error(`[TG] 에러 | user=${userId} | ${err.message}`);
    if (status) status.error(err.message);
    if (err.message.includes('session') || err.message.includes('resume')) {
      chatSessions.delete(chatId); saveSessions(chatSessions);
    }
    try { await bot.editMessageText('❌ 작업 실패', { chat_id: chatId, message_id: startMsg.message_id }); } catch {}
    await bot.sendMessage(chatId, `❌ 오류:\n${err.message}`);
  } finally {
    activeSessions.delete(chatId);

    // 큐에 다음 작업이 있으면 자동 실행
    const queue = messageQueue.get(chatId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) messageQueue.delete(chatId);
      else messageQueue.set(chatId, queue);
      setImmediate(() => handleMessage(next));
    }
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
  plugins.loadAll();
  voice.ensureInstalled();

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
