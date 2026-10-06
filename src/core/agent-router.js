/**
 * Agent Router
 * - 채팅별 현재 agent (claude/codex)와 agent별 세션 ID 관리
 * - 글로벌 디폴트는 config.agent.default
 * - sessions.json 스키마 (하위 호환):
 *   { telegram: { chatId: "<session>" | { agent, sessions:{claude,codex} } } }
 */
const fs = require('fs');
const config = require('./config');
const claudeRunner = require('./claude-runner');
const codexRunner = require('./codex-runner');

const AGENTS = ['claude', 'codex'];

function isValidAgent(a) {
  return AGENTS.includes(a);
}

function normalizeRecord(raw) {
  // 기존 문자열 형식 → 자동 마이그레이션
  if (typeof raw === 'string') {
    return { agent: 'claude', sessions: { claude: raw } };
  }
  if (!raw || typeof raw !== 'object') {
    return { agent: null, sessions: {} };
  }
  const agent = isValidAgent(raw.agent) ? raw.agent : null;
  const sessions = (raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {};
  return { agent, sessions };
}

function loadAll() {
  try {
    if (fs.existsSync(config.SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(config.SESSIONS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error(`[AGENT] loadAll error: ${err.message}`);
  }
  return {};
}

function saveAll(data) {
  try {
    fs.writeFileSync(config.SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[AGENT] saveAll error: ${err.message}`);
  }
}

function getGlobalDefault() {
  const cfg = config.load();
  const v = cfg.agent?.default;
  return isValidAgent(v) ? v : 'claude';
}

function getRecord(source, chatId) {
  const all = loadAll();
  const bucket = all[source] || {};
  return normalizeRecord(bucket[chatId]);
}

function saveRecord(source, chatId, rec) {
  const all = loadAll();
  if (!all[source]) all[source] = {};
  all[source][chatId] = rec;
  saveAll(all);
}

function getActiveAgent(source, chatId) {
  const rec = getRecord(source, chatId);
  return rec.agent || getGlobalDefault();
}

function setActiveAgent(source, chatId, agent) {
  if (!isValidAgent(agent)) throw new Error(`unknown agent: ${agent}`);
  const rec = getRecord(source, chatId);
  rec.agent = agent;
  saveRecord(source, chatId, rec);
  return rec;
}

function getResumeSessionId(source, chatId, agent) {
  const rec = getRecord(source, chatId);
  return rec.sessions?.[agent] || null;
}

function updateSessionId(source, chatId, agent, sessionId) {
  if (!sessionId) return;
  const rec = getRecord(source, chatId);
  if (!rec.sessions) rec.sessions = {};
  rec.sessions[agent] = sessionId;
  // 현재 active agent도 갱신
  if (!rec.agent) rec.agent = agent;
  saveRecord(source, chatId, rec);
}

function clearSession(source, chatId, agent) {
  const rec = getRecord(source, chatId);
  if (rec.sessions && rec.sessions[agent]) delete rec.sessions[agent];
  saveRecord(source, chatId, rec);
}

function clearAll(source, chatId) {
  const all = loadAll();
  if (all[source]) {
    delete all[source][chatId];
    saveAll(all);
  }
}

function outboxRule(dir) {
  return `[파일 전송] 사용자에게 보낼 파일(이미지·영상·문서·압축파일 등 형식 무관)은 반드시 다음 폴더에 저장하거나 복사하라: ${dir.replace(/\\/g, '/')}\n`
    + '작업이 끝나면 이 폴더의 모든 파일이 사용자에게 자동 전송되고 폴더에서 삭제된다. '
    + 'PC에도 남겨야 하는 파일은 원하는 위치에 저장한 뒤 이 폴더에는 복사본을 넣어라. 파일을 보냈다고 말만 하지 말고 실제로 이 폴더에 넣어라.';
}

/**
 * Agent 별 runner 호출. claude-runner.runClaude와 동형 인터페이스.
 * options.outboxDir: 작업 후 이 폴더의 파일을 사용자에게 보낸다 (에이전트에 저장 규칙 안내)
 * @returns {{ promise: Promise<{result, session_id}>, proc, agent }}
 */
function runAgent(agent, prompt, options = {}) {
  if (!isValidAgent(agent)) throw new Error(`unknown agent: ${agent}`);
  if (options.outboxDir) {
    options = {
      ...options,
      appendSystemPrompt: [options.appendSystemPrompt, outboxRule(options.outboxDir)].filter(Boolean).join('\n'),
    };
  }
  if (agent === 'codex') {
    if (!codexRunner.isCodexReady()) {
      const err = new Error('Codex CLI가 설치되지 않았거나 인증이 필요합니다. (codex login 확인)');
      return { promise: Promise.reject(err), proc: null, agent };
    }
    const { promise, proc } = codexRunner.runCodex(prompt, options);
    return { promise, proc, agent };
  }
  const { promise, proc } = claudeRunner.runClaude(prompt, options);
  return { promise, proc, agent };
}

function extractText(agent, result) {
  if (agent === 'codex') return codexRunner.extractText(result);
  return claudeRunner.extractText(result);
}

function extractSessionId(agent, result) {
  if (agent === 'codex') return codexRunner.extractSessionId(result);
  return claudeRunner.extractSessionId(result);
}

module.exports = {
  AGENTS,
  isValidAgent,
  getGlobalDefault,
  getActiveAgent,
  setActiveAgent,
  getResumeSessionId,
  updateSessionId,
  clearSession,
  clearAll,
  runAgent,
  extractText,
  extractSessionId,
};
