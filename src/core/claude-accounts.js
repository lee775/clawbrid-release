/**
 * Claude 계정 여러 개를 순서대로 쓰기 (config.claude.accounts)
 * - 계정마다 `claude setup-token` 으로 받은 토큰을 ~/.claude-tokens/<이름>.txt 에 둔다
 *   (claude-aro.cmd 같은 계정별 실행 스크립트와 같은 파일)
 * - 앞 계정부터 쓰고, 사용 한도(usage_limit_reached)나 인증 실패가 나면 다음 계정으로 다시 실행한다
 * - 한도에 걸린 계정은 안내된 초기화 시각까지 뒤로 미룬다 (시각을 못 읽으면 30분)
 * - accounts 가 비어 있으면 PC에 로그인된 계정 하나만 쓴다 (이전 동작)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const TOKEN_DIR = path.join(os.homedir(), '.claude-tokens');
const RETRY_AFTER_MS = 30 * 60 * 1000;
const MAX_SKIP_MS = 8 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const skipUntil = new Map(); // 계정 이름 → 다시 앞에 세울 시각(ms)
const warnedMissing = new Set();

function tokenFile(name) {
  return path.join(TOKEN_DIR, `${name}.txt`);
}

function readToken(name) {
  try { return fs.readFileSync(tokenFile(name), 'utf8').trim() || null; } catch { return null; }
}

/**
 * 이번 실행에서 시도할 계정 순서. 항목 { name, env } — name 이 null 이면 PC 로그인 그대로.
 * 쉬는 중인 계정은 뒤로 보낸다 (모두 쉬는 중이면 원래 순서대로 전부 시도).
 */
function candidates(now = Date.now()) {
  const names = (config.load().claude?.accounts || [])
    .filter(n => typeof n === 'string' && n.trim())
    .map(n => n.trim());
  const list = [];
  for (const name of names) {
    const token = readToken(name);
    if (!token) {
      if (!warnedMissing.has(name)) {
        warnedMissing.add(name);
        console.error(`[CLAUDE] 계정 ${name}: 토큰 파일이 없거나 비어 있어 건너뜀 (${tokenFile(name)})`);
      }
      continue;
    }
    list.push({ name, env: { CLAUDE_CODE_OAUTH_TOKEN: token }, resting: (skipUntil.get(name) || 0) > now });
  }
  if (!list.length) return [{ name: null, env: {} }];
  return [...list.filter(a => !a.resting), ...list.filter(a => a.resting)]
    .map(({ name, env }) => ({ name, env }));
}

/** 다음 계정으로 넘어가야 하는 결과면 'limit' | 'auth', 아니면 null */
function unusableReason(result) {
  if (!result || result.is_error !== true) return null;
  const text = String(result.result || '');
  if (result.api_error === 'usage_limit_reached' || /hit your .*limit|usage limit reached/i.test(text)) return 'limit';
  if (result.api_error_status === 401 || /failed to authenticate|oauth token has expired|invalid (api key|bearer token)/i.test(text)) return 'auth';
  return null;
}

/**
 * 한도 안내문의 초기화 시각. PC 시간대 기준으로 읽는다 (CLI도 PC 시간대로 안내함).
 * 예: "resets Oct 24, 11pm (Asia/Seoul)", "resets 3:30am (Asia/Seoul)", 옛 형식 "limit reached|1761314400"
 */
function parseResetTime(text, now = new Date()) {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!m) return null;
  const d = new Date(now.getTime());
  d.setHours((Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0), Number(m[4] || 0), 0, 0);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    d.setMonth(month, Number(m[2]));
    if (d.getTime() < now.getTime() - DAY_MS) d.setFullYear(d.getFullYear() + 1); // 12월 → 1월
  } else if (d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** 계정을 뒤로 미룬다. 다시 앞에 세울 시각(Date)을 돌려준다. */
function markUnavailable(name, result, reason, now = new Date()) {
  const t = now.getTime();
  let until = t + RETRY_AFTER_MS;
  if (reason === 'limit') {
    const reset = parseResetTime(String(result?.result || ''), now);
    if (reset) until = Math.min(Math.max(reset.getTime() + 60 * 1000, t + 60 * 1000), t + MAX_SKIP_MS);
  }
  skipUntil.set(name, until);
  return new Date(until);
}

module.exports = { candidates, unusableReason, parseResetTime, markUnavailable, TOKEN_DIR };
