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

/**
 * Agent 별 runner 호출. claude-runner.runClaude와 동형 인터페이스.
 * @returns {{ promise: Promise<{result, session_id}>, proc, agent }}
 */
function runAgent(agent, prompt, options = {}) {
  if (!isValidAgent(agent)) throw new Error(`unknown agent: ${agent}`);
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
