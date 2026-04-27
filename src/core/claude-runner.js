/**
 * Claude Code 실행기
 * - 권한 확인 (confirmBeforeEdit) 지원
 * - stdin 방식으로 프롬프트 전달
 */
const { spawn } = require('child_process');
const config = require('./config');

function runClaude(prompt, options = {}) {
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

    // 시스템 프롬프트 추가
    if (appendSystemPrompt) {
      args.push('--append-system-prompt', appendSystemPrompt);
    }

    // 파일 수정/삭제 전 확인 프롬프트 주입
    let finalPrompt = prompt;
    if (cfg.claude.confirmBeforeEdit) {
      finalPrompt = `[시스템 지침] 파일을 수정(Edit/Write)하거나 삭제하기 전에 반드시 사용자에게 어떤 파일을 어떻게 변경할지 먼저 설명하고 확인을 받아줘. 확인 없이 파일을 수정하지 마.\n\n${prompt}`;
    }

    const proc = spawn('claude', args, {
      cwd: cfg.claude.workDir,
      env: { ...process.env, FORCE_COLOR: '0' },
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
    const diff = execSync('git diff --shortstat', { cwd: cfg.claude.workDir, encoding: 'utf-8', windowsHide: true }).trim();
    const staged = execSync('git diff --cached --shortstat', { cwd: cfg.claude.workDir, encoding: 'utf-8', windowsHide: true }).trim();
    return !!(diff || staged);
  } catch { return false; }
}

module.exports = { runClaude, extractText, extractSessionId, runCodexReview, hasCodeChanges };
