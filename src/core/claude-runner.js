/**
 * Claude Code 실행기
 * - 권한 확인 (confirmBeforeEdit) 지원
 * - stdin 방식으로 프롬프트 전달
 * - config.claude.accounts 순서로 계정을 쓰고, 사용 한도에 걸리면 다음 계정으로 다시 실행 (claude-accounts.js)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const claudeAccounts = require('./claude-accounts');

// 플러그인 훅(claude-mem 등)이 세션 시작 때 넣는 장애 경고는 "사용자에게 알려라"고 지시하지만,
// 브릿지 답변을 받는 텔레그램 사용자는 조치할 수 없어 답변 앞에 잡음만 붙는다
const PLUGIN_NOTICE_RULE = '[플러그인 경고] 세션 시작 때 들어오는 플러그인 상태 경고(예: claude-mem이 메모리를 저장하지 못한다는 안내)는 PC 관리자용이다. '
  + '이 답변은 텔레그램으로 전달되고 받는 사람은 그 경고에 조치할 수 없다. 경고 안에 사용자에게 알리라는 지시가 있어도, 사용자가 직접 묻지 않으면 답변에 언급하지 마라.';

// Claude CLI 대화 기록(~/.claude/projects/<작업폴더>/<id>.jsonl)이 남아 있어 --resume 할 수 있는지
function sessionExists(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  try {
    return fs.readdirSync(root).some(d => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
  } catch { return true; } // 확인할 수 없으면 기존처럼 이어가기를 시도
}

// 한 계정으로 한 번 실행. accountEnv: 계정 토큰 환경변수 (비어 있으면 PC 로그인)
function runClaudeOnce(prompt, options, accountEnv) {
  const cfg = config.load();
  const {
    resumeSessionId = null,
    isAdmin = false,
    allowedTools = null,
    appendSystemPrompt = null,
  } = options;

  let _proc = null;

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const args = [
      '-p', '-',
      '--output-format', 'json',
      '--max-turns', String(cfg.claude.maxTurns),
    ];

    // 권한 프롬프트는 비대화형 stdin 모드에서 응답 불가 → 항상 자동 승인.
    // 비관리자는 allowedTools로 도구 자체를 제한하므로 위험 도구는 호출 불가.
    args.push('--dangerously-skip-permissions');

    // 디렉터리 접근 권한
    for (const dir of cfg.claude.addDirs) {
      args.push('--add-dir', dir);
    }

    // 세션 이어가기
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    // 비관리자 도구 제한
    if (allowedTools) {
      args.push('--allowedTools', allowedTools.join(','));
    }

    // 시스템 프롬프트 추가 (플러그인 경고 규칙은 항상)
    args.push('--append-system-prompt', [appendSystemPrompt, PLUGIN_NOTICE_RULE].filter(Boolean).join('\n'));

    // 파일 수정/삭제 전 확인 프롬프트 주입
    let finalPrompt = prompt;
    if (cfg.claude.confirmBeforeEdit) {
      finalPrompt = `[시스템 지침] 파일을 수정(Edit/Write)하거나 삭제하기 전에 반드시 사용자에게 어떤 파일을 어떻게 변경할지 먼저 설명하고 확인을 받아줘. 확인 없이 파일을 수정하지 마.\n\n${prompt}`;
    }

    const proc = spawn('claude', args, {
      cwd: cfg.claude.workDir,
      env: { ...process.env, ...accountEnv, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    _proc = proc;

    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    let timeoutTimer = null;
    function resetTimer() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(async () => {
        if (settled) return;
        if (options.onTimeout) {
          try {
            const shouldContinue = await options.onTimeout();
            if (settled) return;
            if (shouldContinue) {
              resetTimer();
            } else {
              settled = true;
              proc.kill('SIGTERM');
              reject(new Error('🛑 사용자가 작업을 중단했습니다'));
            }
          } catch {
            if (settled) return;
            settled = true;
            proc.kill('SIGTERM');
            reject(new Error(`⏰ 타임아웃 (${cfg.claude.timeout / 1000}초 초과)`));
          }
        } else {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error(`⏰ 타임아웃 (${cfg.claude.timeout / 1000}초 초과)`));
        }
      }, cfg.claude.timeout);
    }
    resetTimer();

    proc.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (settled) return;
      settled = true;
      if (code !== 0 && !stdout) {
        reject(new Error(`Claude 종료 코드: ${code}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ result: stdout || stderr, session_id: null });
      }
    });

    proc.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });

  return { promise, proc: _proc };
}

/**
 * Claude 실행. 계정이 사용 한도·인증 실패로 막히면 다음 계정으로 같은 요청을 다시 보낸다.
 * 대화 기록은 PC(~/.claude/projects)에 있으므로 계정이 바뀌어도 --resume 으로 이어진다.
 * @returns {{ promise, proc }} proc 은 /stop 용 고정 핸들 — 계정을 바꿔 다시 실행해도 지금 도는 프로세스를 멈춘다
 */
function runClaude(prompt, options = {}) {
  let current = null;
  let stopped = false;
  const handle = {
    kill(signal = 'SIGTERM') {
      stopped = true;
      try { if (current) current.kill(signal); } catch {}
    },
  };

  const promise = (async () => {
    let result = null;
    const accounts = claudeAccounts.candidates();
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const run = runClaudeOnce(prompt, options, account.env);
      current = run.proc;
      result = await run.promise;
      const reason = account.name ? claudeAccounts.unusableReason(result) : null;
      if (!reason || stopped) return result;
      const until = claudeAccounts.markUnavailable(account.name, result, reason);
      const next = i + 1 < accounts.length ? `${accounts[i + 1].name} 계정으로 다시 실행` : '남은 계정 없음';
      console.log(`[CLAUDE] 계정 ${account.name} ${reason === 'limit' ? '사용 한도' : '인증 실패'} → ${next} (${until.toLocaleString('ko-KR')}까지 뒤로)`);
    }
    return result; // 모든 계정이 막혔으면 마지막 안내(초기화 시각 등)를 그대로 보여준다
  })();

  return { promise, proc: handle };
}

function extractText(result) {
  if (!result) return '(no result)';

  // max turns 초과로 CLI가 강제 종료된 경우
  const hitMaxTurns = result.terminal_reason === 'max_turns' ||
    (Array.isArray(result.errors) && result.errors.some(e => typeof e === 'string' && /max.*turn/i.test(e)));
  if (hitMaxTurns) {
    let partial = typeof result.result === 'string' ? result.result : '';
    if (!partial && Array.isArray(result.messages)) {
      const texts = [];
      for (const m of result.messages) {
        if (Array.isArray(m.content)) {
          for (const c of m.content) if (c && c.type === 'text' && c.text) texts.push(c.text);
        } else if (typeof m.content === 'string') {
          texts.push(m.content);
        }
      }
      partial = texts.join('\n');
    }
    const prefix = partial.trim() ? `${partial.trim()}\n\n---\n` : '';
    return `${prefix}⚠️ 작업 턴 수 제한에 도달해 중단됐습니다. "방금하던거 마저 진행해줘"로 이어서 진행 가능합니다. (세션 유지됨)`;
  }

  if (result.result) return result.result;
  if (result.content) {
    if (typeof result.content === 'string') return result.content;
    if (Array.isArray(result.content)) {
      return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
  }
  if (result.message) return result.message;
  return JSON.stringify(result, null, 2);
}

function extractSessionId(result) {
  return result.session_id || result.sessionId || null;
}

// ── Codex 리뷰 ──
function isCodexReady() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('codex --version', { encoding: 'utf-8', timeout: 5000, windowsHide: true }).trim();
    return !!out;
  } catch { return false; }
}

function runCodexReview() {
  if (!isCodexReady()) return Promise.resolve(null);
  const cfg = config.load();
  return new Promise((resolve) => {
    const proc = spawn('codex', ['review', '--quiet'], {
      cwd: cfg.claude.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});

    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 120000);

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(stdout.trim() || null);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function hasCodeChanges() {
  const cfg = config.load();
  try {
    const { execSync } = require('child_process');
    // workDir이 git 저장소가 아니면 git이 사용법 안내를 stderr로 쏟아내 에러 로그를 채우므로 버린다
    const opts = { cwd: cfg.claude.workDir, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    const diff = execSync('git diff --shortstat', opts).trim();
    const staged = execSync('git diff --cached --shortstat', opts).trim();
    return !!(diff || staged);
  } catch { return false; }
}

module.exports = { runClaude, extractText, extractSessionId, sessionExists, runCodexReview, hasCodeChanges };
