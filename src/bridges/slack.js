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
const memory = require('../core/memory-manager');
const plugins = require('../core/plugin-manager');
const webTools = require('../core/web-tools');
const knowledgeGraph = require('../core/knowledge-graph');
const videoAnalyzer = require('../core/video-analyzer');
const imageGen = require('../core/image-generator');

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
  } catch (err) { console.error(`[SLACK] loadSessions error: ${err.message}`); }
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
  } catch (err) { console.error(`[SLACK] saveSessions error: ${err.message}`); }
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
  } catch (err) { console.error(`[SLACK] addToHistory error: ${err.message}`); }
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
  } catch (err) { console.error(`[SLACK] getRecentHistory error: ${err.message}`); }
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
  } catch (err) { console.error(`[SLACK] searchHistory error: ${err.message}`); }
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

// ── Slack 이미지 업로드 (uploadV2 → 수동 fallback) ──
async function slackUploadImage(client, channelId, filePath, comment) {
  const fileData = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  // 방법 1: uploadV2
  try {
    await client.files.uploadV2({
      channel_id: channelId,
      file: fileData,
      filename,
      initial_comment: comment,
    });
    return;
  } catch (e) {
    console.log(`[SLACK] uploadV2 실패, 수동 업로드 시도: ${e.message}`);
  }

  // 방법 2: 수동 (getUploadURLExternal → PUT → completeUploadExternal)
  const urlRes = await client.files.getUploadURLExternal({
    filename,
    length: fileData.length,
  });
  const uploadUrl = urlRes.upload_url;
  const fileId = urlRes.file_id;

  // HTTP PUT으로 파일 전송
  const { URL } = require('url');
  const parsedUrl = new URL(uploadUrl);
  const httpModule = parsedUrl.protocol === 'https:' ? require('https') : require('http');
  await new Promise((resolve, reject) => {
    const req = httpModule.request(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': fileData.length } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });

  await client.files.completeUploadExternal({
    files: [{ id: fileId, title: filename }],
    channel_id: channelId,
    initial_comment: comment,
  });
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
const messageQueue = new Map(); // 채널별 작업 큐 (최대 5개)
const MAX_QUEUE_SIZE = 5;
const channelSessions = loadSessions();

async function handleMessage({ event, say, client }) {
  if (event.bot_id) return;
  if (event.subtype && event.subtype !== 'file_share') return;

  const cfg = config.load();
  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  let text = event.text?.trim() || '';
  const hasFiles = event.files && event.files.length > 0;
  console.log(`[SLACK] 메시지 수신 | user=${userId} | ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);

  if (!text && !hasFiles) return;

  // 특수 명령어
  if (text.toLowerCase() === '!stop') {
    // 같은 채널의 모든 활성 세션 검색 (스레드 안/밖 모두 매칭)
    let found = false;
    for (const [key, proc] of activeSessions) {
      if (key.startsWith(`${channelId}:`)) {
        proc.kill('SIGTERM');
        activeSessions.delete(key);
        found = true;
      }
    }
    if (found) await say('🛑 중단됨');
    else await say('ℹ️ 실행 중인 작업 없음');
    return;
  }
  if (text.toLowerCase() === '!reset') {
    channelSessions.delete(channelId); saveSessions(channelSessions);
    await say('🔄 세션 초기화됨'); return;
  }
  if (text.toLowerCase() === '!help') {
    const pluginCmds = plugins.getList().flatMap(p => p.commands).filter(c => c.startsWith('!'));
    const pluginHelp = pluginCmds.length ? `\n• 플러그인: ${pluginCmds.join(', ')}` : '';
    await say(`*ClawBrid 명령어*\n• \`!stop\` 작업 중단\n• \`!reset\` 세션 초기화\n• \`!queue\` 대기열 확인\n• \`!clear\` 대기열 비우기\n• \`!search [검색어]\` 웹 검색\n• \`!browse [URL] [질문]\` 웹페이지 분석\n• \`!ultraplan [주제]\` 심층 분석 + 실행 계획\n• \`!youtube [URL] [질문]\` 영상 분석 (프레임+음성)\n• \`!image [프롬프트]\` AI 이미지 생성 (Stable Diffusion)\n• \`!graph stats|add|link|find|del|list\` 지식 그래프\n• \`!memory list|add|del|search\` 장기 메모리\n• \`!plugins\` 플러그인 목록\n• \`!cron list|add|del|run|on|off\` 크론 관리\n• \`!help\` 도움말${pluginHelp}`); return;
  }
  if (text.toLowerCase() === '!queue') {
    const queue = messageQueue.get(channelId) || [];
    if (!queue.length) { await say('ℹ️ 대기열이 비어 있습니다.'); return; }
    const list = queue.map((q, i) => `${i + 1}. ${(q.text || '[파일]').slice(0, 50)}`).join('\n');
    await say(`*📋 대기열 (${queue.length}/${MAX_QUEUE_SIZE})*\n${list}`); return;
  }
  if (text.toLowerCase() === '!clear') {
    messageQueue.delete(channelId);
    await say('🗑️ 대기열 비워짐'); return;
  }

  // ── ultraplan 명령어 ──
  if (text.toLowerCase().startsWith('!ultraplan')) {
    const topic = text.slice(10).trim();
    if (!topic) { await say('사용법: `!ultraplan [분석할 주제/작업]`\n예: `!ultraplan 서버 성능 최적화 방안`'); return; }
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
    // ultraplan은 새 세션으로 (깊은 분석이므로)
    channelSessions.delete(channelId);
    saveSessions(channelSessions);
    await say('🧠 *UltraPlan* 심층 분석을 시작합니다...');
    // fall through to Claude execution below
  }

  // ── 영상 분석 명령어 ──
  if (text.toLowerCase().startsWith('!youtube') || text.toLowerCase().startsWith('!video')) {
    const cmdLen = text.toLowerCase().startsWith('!youtube') ? 8 : 6;
    const args = text.slice(cmdLen).trim();
    const urlMatch = args.match(/(https?:\/\/\S+)/);
    if (!urlMatch) { await say('사용법: `!youtube [URL] [질문]`\n예: `!youtube https://youtube.com/watch?v=xxx 핵심 내용 요약해줘`'); return; }
    const videoUrl = urlMatch[1];
    const question = args.replace(videoUrl, '').trim();

    let progressMsg = null;
    try {
      const sendProgress = async (msg) => {
        try {
          if (progressMsg) { await say(msg); }
          else { progressMsg = msg; await say(msg); }
        } catch {}
      };

      await sendProgress('🎬 영상 분석을 시작합니다...');
      const result = await videoAnalyzer.analyzeVideo(videoUrl, question, sendProgress);
      await say(`📹 *${result.title}* 분석 완료! Claude에게 전달 중...`);

      // 새 세션으로 (영상 분석은 독립적)
      channelSessions.delete(channelId);
      saveSessions(channelSessions);
      text = result.prompt;
      // cleanup은 Claude 응답 후 처리
      const _tempDir = result.tempDir;
      const origAfter = null;
      setTimeout(() => videoAnalyzer.cleanup(_tempDir), 600000); // 10분 후 정리
      // fall through to Claude execution
    } catch (e) {
      await say(`❌ 영상 분석 실패: ${e.message}`);
      return;
    }
  }

  // ── 이미지 생성 명령어 ──
  if (text.toLowerCase().startsWith('!image')) {
    const prompt = text.slice(6).trim();
    if (!prompt) { await say('사용법: `!image [프롬프트]`\n예: `!image a beautiful sunset over mountains, digital art`'); return; }

    try {
      await say('🎨 이미지 생성 중... (Stable Diffusion)');
      const result = await imageGen.generate({ prompt });
      const img = result.images[0];
      // Slack에 이미지 업로드
      try {
        await slackUploadImage(client, channelId, img.path, `🎨 *이미지 생성 완료*\n프롬프트: ${prompt}`);
      } catch (uploadErr) {
        console.error(`[SLACK] 이미지 업로드 실패: ${uploadErr.message}`);
        await say(`🎨 이미지 생성 완료!\n파일: ${img.path}\n(Slack 앱 설정에서 \`files:write\` 권한을 추가하세요)`);
      }
    } catch (e) {
      await say(`❌ 이미지 생성 실패: ${e.message}`);
    }
    return;
  }

  // ── 메모리 명령어 ──
  if (text.toLowerCase().startsWith('!memory')) {
    const parts = text.slice(7).trim().split(/\s+/);
    const sub = (parts[0] || 'list').toLowerCase();

    if (sub === 'list') {
      const all = memory.getAll();
      if (!all.length) { await say('ℹ️ 저장된 메모리가 없습니다.'); return; }
      const list = all.map(m => `• *${m.key}*: ${m.value} _(${m.source})_`).join('\n');
      await say(`*🧠 메모리 (${all.length}개)*\n${list}`); return;
    }
    if (sub === 'add') {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) { await say('사용법: `!memory add [키] [값]`'); return; }
      memory.add(key, value, 'slack');
      await say(`✅ 메모리 저장: *${key}* = ${value}`); return;
    }
    if (sub === 'del' || sub === 'delete') {
      const key = parts.slice(1).join(' ');
      if (!key) { await say('사용법: `!memory del [키]`'); return; }
      if (memory.remove(key)) await say(`🗑️ 메모리 삭제: *${key}*`);
      else await say(`❌ "${key}" 메모리를 찾을 수 없습니다.`);
      return;
    }
    if (sub === 'search') {
      const keyword = parts.slice(1).join(' ');
      if (!keyword) { await say('사용법: `!memory search [키워드]`'); return; }
      const found = memory.search(keyword);
      if (!found.length) { await say(`ℹ️ "${keyword}" 관련 메모리 없음`); return; }
      const list = found.map(m => `• *${m.key}*: ${m.value}`).join('\n');
      await say(`*🔍 검색 결과 (${found.length}건)*\n${list}`); return;
    }
    await say('사용법: `!memory list|add|del|search`'); return;
  }

  // ── 플러그인 명령어 ──
  if (text.toLowerCase() === '!plugins') {
    const list = plugins.getList();
    if (!list.length) { await say('ℹ️ 로드된 플러그인이 없습니다.'); return; }
    const info = list.map(p => `• *${p.name}*: ${p.description || '-'} | 명령: ${p.commands.join(', ') || '없음'}`).join('\n');
    await say(`*🧩 플러그인 (${list.length}개)*\n${info}`); return;
  }
  if (text.toLowerCase() === '!reload-plugins') {
    plugins.reload();
    const list = plugins.getList();
    await say(`🔄 플러그인 리로드 완료 (${list.length}개)`); return;
  }
  // 플러그인 커스텀 명령어 매칭
  const pluginMatch = plugins.matchCommand(text);
  if (pluginMatch) {
    try {
      const ctx = { userId, chatId: channelId, source: 'slack', args: text.split(/\s+/).slice(1).join(' ') };
      const result = await pluginMatch.handler(ctx);
      if (result) await say(String(result));
    } catch (err) {
      await say(`❌ 플러그인 오류 (${pluginMatch.plugin.name}): ${err.message}`);
    }
    return;
  }

  // ── 웹 검색 ──
  if (text.toLowerCase().startsWith('!search')) {
    const query = text.slice(7).trim();
    if (!query) { await say('사용법: `!search [검색어]`'); return; }
    try {
      await say(`🔍 "${query}" 검색 중...`);
      const results = await webTools.search(query);
      await sendLongMessage(say, webTools.formatSearchResults(results, query));
    } catch (err) {
      await say(`❌ 검색 오류: ${err.message}`);
    }
    return;
  }
  // ── 브라우저 자동화 ──
  if (text.toLowerCase().startsWith('!browse')) {
    const parts = text.slice(7).trim().split(/\s+/);
    const browseUrl = parts[0];
    if (!browseUrl) { await say('사용법: `!browse [URL] [질문(선택)]`'); return; }
    const question = parts.slice(1).join(' ');
    try {
      await say(`🌐 ${browseUrl} 불러오는 중...`);
      const result = await webTools.browse(browseUrl);
      if (question) {
        // 질문이 있으면 text를 교체하여 Claude에게 전달
        text = `다음 웹페이지 내용을 기반으로 질문에 답해줘.\n\n--- 웹페이지: ${result.title} (${result.url}) ---\n${result.text}\n--- 페이지 끝 ---\n\n질문: ${question}`;
        // return하지 않음 → 아래 Claude 호출로 진행
      } else {
        await sendLongMessage(say, webTools.formatBrowseResult(result));
        return;
      }
    } catch (err) {
      await say(`❌ 브라우즈 오류: ${err.message}`);
      return;
    }
  }
  // ── Knowledge Graph ──
  if (text.toLowerCase().startsWith('!graph')) {
    const parts = text.slice(6).trim().split(/\s+/);
    const sub = (parts[0] || 'stats').toLowerCase();

    if (sub === 'stats') {
      const stats = knowledgeGraph.getStats();
      const typeStr = Object.entries(stats.types).map(([t, c]) => `${t}: ${c}`).join(', ');
      await say(`*📊 Knowledge Graph*\n• 노드: ${stats.nodeCount}개\n• 엣지: ${stats.edgeCount}개\n• 타입: ${typeStr || '없음'}`);
      return;
    }
    if (sub === 'add') {
      const label = parts[1]; const type = parts[2] || 'concept'; const context = parts.slice(3).join(' ');
      if (!label) { await say('사용법: `!graph add [이름] [타입] [설명]`'); return; }
      knowledgeGraph.addNode(label, type, context);
      await say(`✅ 노드 추가: ${label} (${type})`); return;
    }
    if (sub === 'link') {
      const from = parts[1]; const relation = parts[2]; const to = parts[3];
      if (!from || !relation || !to) { await say('사용법: `!graph link [노드1] [관계] [노드2]`'); return; }
      knowledgeGraph.addNode(from); knowledgeGraph.addNode(to);
      knowledgeGraph.addEdge(from, to, relation);
      await say(`✅ 관계 추가: ${from} -[${relation}]-> ${to}`); return;
    }
    if (sub === 'find') {
      const keyword = parts.slice(1).join(' ');
      if (!keyword) { await say('사용법: `!graph find [키워드]`'); return; }
      const info = knowledgeGraph.getNeighbors(keyword);
      if (!info) { await say(`ℹ️ "${keyword}" 노드를 찾을 수 없습니다.`); return; }
      let msg = `*🔗 ${info.node.label}* (${info.node.type})\n언급: ${info.node.mentions}회`;
      if (info.neighbors.length) {
        msg += '\n\n연결된 노드:\n' + info.neighbors.map(n =>
          `• ${n.direction === 'out' ? '→' : '←'} [${n.relation}] ${n.node.label} (${n.node.type})`
        ).join('\n');
      }
      await say(msg); return;
    }
    if (sub === 'del') {
      const label = parts.slice(1).join(' ');
      if (!label) { await say('사용법: `!graph del [노드이름]`'); return; }
      if (knowledgeGraph.removeNode(label)) await say(`🗑️ 노드 삭제: ${label}`);
      else await say(`❌ "${label}" 노드를 찾을 수 없습니다.`);
      return;
    }
    if (sub === 'list') {
      const nodes = knowledgeGraph.getAllNodes();
      if (!nodes.length) { await say('ℹ️ 그래프가 비어 있습니다.'); return; }
      const list = nodes.slice(0, 20).map(n => `• [${n.type}] ${n.label} (${n.mentions}회)`).join('\n');
      const more = nodes.length > 20 ? `\n... 외 ${nodes.length - 20}개` : '';
      await say(`*📊 노드 목록 (${nodes.length}개)*\n${list}${more}`); return;
    }
    await say('사용법: `!graph stats|add|link|find|del|list`'); return;
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
        return `${status} *${c.name}* | ${c.type} | ${c.schedule} | 마지막: ${last}`;
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
        schedule: `*/${interval} * * * *`,
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
    // 큐에 추가
    const queue = messageQueue.get(channelId) || [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      await say(`❌ 대기열이 가득 찼습니다 (${MAX_QUEUE_SIZE}개). \`!clear\`로 비우거나 \`!stop\`으로 현재 작업을 중단하세요.`); return;
    }
    queue.push({ event, say, client });
    messageQueue.set(channelId, queue);
    await say(`📋 대기열에 추가됨 (${queue.length}번째). \`!queue\`로 확인`); return;
  }

  const startMsg = await say('⏳ 작업 진행중');
  let dotCount = 0;
  let progressTimer = null;

  const resumeSessionId = channelSessions.get(channelId) || null;

  try {
    progressTimer = setInterval(async () => {
      dotCount = (dotCount + 1) % 4;
      try {
        await client.chat.update({ channel: channelId, ts: startMsg.ts, text: `⏳ 작업 진행중${'.'.repeat(dotCount || 1)}` });
      } catch {}
    }, 5000);

    if (status) status.start(text || '[파일 첨부]', userId, channelId);

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

    // 메모리 + 지식 그래프 컨텍스트 주입
    const memoryCtx = memory.getRelevantContext(prompt);
    if (memoryCtx) finalPrompt = `${memoryCtx}${finalPrompt}`;
    const graphCtx = knowledgeGraph.getRelevantContext(prompt);
    if (graphCtx) finalPrompt = `${graphCtx}${finalPrompt}`;

    // 플러그인 전처리 훅
    finalPrompt = plugins.runBeforePrompt(finalPrompt, { userId, chatId: channelId, source: 'slack' });

    // 타임아웃 시 사용자에게 계속 진행 여부 확인
    const onTimeout = () => new Promise((resolve) => {
      const ts = Date.now();
      say({
        text: '⏰ 작업이 10분을 초과했습니다. 계속 진행할까요?',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '⏰ 작업이 10분을 초과했습니다. 계속 진행할까요?' } },
          { type: 'actions', block_id: `timeout_${ts}`, elements: [
            { type: 'button', text: { type: 'plain_text', text: '✅ 계속 진행' }, action_id: `timeout_continue_${ts}`, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: '🛑 중단' }, action_id: `timeout_stop_${ts}`, style: 'danger' },
          ] },
        ],
      }).then(() => {
        let resolved = false;
        const contHandler = async ({ ack, respond }) => {
          if (resolved) return;
          resolved = true;
          await ack();
          await respond({ text: '⏰ 계속 진행 중...', replace_original: true });
          app.action(`timeout_continue_${ts}`, () => {});
          app.action(`timeout_stop_${ts}`, () => {});
          resolve(true);
        };
        const stopHandler = async ({ ack, respond }) => {
          if (resolved) return;
          resolved = true;
          await ack();
          await respond({ text: '🛑 사용자가 중단함', replace_original: true });
          app.action(`timeout_continue_${ts}`, () => {});
          app.action(`timeout_stop_${ts}`, () => {});
          resolve(false);
        };
        app.action(`timeout_continue_${ts}`, contHandler);
        app.action(`timeout_stop_${ts}`, stopHandler);
        // 2분 응답 없으면 자동 계속
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          app.action(`timeout_continue_${ts}`, () => {});
          app.action(`timeout_stop_${ts}`, () => {});
          resolve(true);
        }, 120000);
      }).catch(() => resolve(true));
    });

    const { promise, proc } = runClaude(finalPrompt, {
      resumeSessionId,
      isAdmin: true,
      appendSystemPrompt: `${memory.MEMORY_SYSTEM_PROMPT}\n${knowledgeGraph.GRAPH_SYSTEM_PROMPT}`,
      onTimeout,
    });
    activeSessions.set(sessionKey, proc);
    const result = await promise;

    const newSession = extractSessionId(result);
    if (newSession) { channelSessions.set(channelId, newSession); saveSessions(channelSessions); }

    let responseText = extractText(result);

    // 응답에서 메모리 자동 추출
    const { cleaned, saved } = memory.extractAndSave(responseText, 'slack-auto');
    if (saved.length > 0) {
      responseText = cleaned;
      for (const s of saved) knowledgeGraph.indexMemory(s.key, s.value);
    }

    // 응답에서 그래프 엔티티 자동 추출
    const graphResult = knowledgeGraph.extractAndIndex(responseText);
    if (graphResult.indexed.length > 0) responseText = graphResult.cleaned;

    // 플러그인 후처리 훅
    responseText = plugins.runAfterResponse(responseText, { userId, chatId: channelId, source: 'slack' });

    addToHistory(channelId, 'assistant', responseText);
    if (status) status.done(responseText);
    console.log(`[SLACK] 응답 완료 | user=${userId} | ${responseText.slice(0, 100)}${responseText.length > 100 ? '...' : ''}`);

    try { await client.chat.update({ channel: channelId, ts: startMsg.ts, text: '✅ 작업 완료' }); } catch {}

    // Claude 응답에서 생성된 이미지 파일 자동 감지 및 전송
    const imgRegex = /[^\s"'<>]*\.clawbrid[\\\/]temp[\\\/]images[\\\/]\S+\.png/gi;
    const imgPaths = [...new Set((responseText.match(imgRegex) || []).map(p => p.replace(/\\/g, '/')))];
    for (const imgPath of imgPaths) {
      if (fs.existsSync(imgPath)) {
        try {
          await slackUploadImage(client, channelId, imgPath);
        } catch (e) {
          console.error(`[SLACK] 이미지 업로드 실패: ${e.message}`);
        }
      }
    }

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
    console.error(`[SLACK] 에러 | user=${userId} | ${err.message}`);
    if (status) status.error(err.message);
    try { await client.chat.update({ channel: channelId, ts: startMsg.ts, text: '❌ 작업 실패' }); } catch {}
    await say(`❌ 오류:\n\`\`\`\n${err.message}\n\`\`\``);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    activeSessions.delete(sessionKey);

    // 큐에 다음 작업이 있으면 자동 실행
    const queue = messageQueue.get(channelId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) messageQueue.delete(channelId);
      else messageQueue.set(channelId, queue);
      setImmediate(() => handleMessage(next));
    }
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
  plugins.loadAll();

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
