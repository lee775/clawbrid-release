/**
 * Codex CLI 실행기 (claude-runner.js와 동형 API)
 * - codex exec --json --output-last-message <tmpfile> ...
 * - resume 시 codex exec resume <session_id> [prompt]
 * - 비대화형 stdin으로 prompt 전달
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCodexReady() {
  try {
    execSync('codex --version', { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

function extractSessionIdFromJsonl(stdout) {
  if (!stdout) return null;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || !s.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    // 후보 키 순회 — Codex CLI 버전에 따라 키가 다를 수 있어 관대하게
    const candidates = [
      obj.session_id, obj.sessionId,
      obj.conversation_id, obj.conversationId,
      obj.thread_id, obj.threadId,
      obj.id,
      obj?.session?.id,
      obj?.conversation?.id,
    ];
    for (const v of candidates) {
      if (typeof v === 'string' && UUID_RE.test(v)) return v;
    }
  }
  return null;
}

function runCodex(prompt, options = {}) {
  const cfg = config.load();
  const {
    resumeSessionId = null,
    appendSystemPrompt = null,
    onTimeout = null,
  } = options;

  // 시스템 프롬프트는 codex CLI에 직접 옵션 없음 → prompt 앞에 합성
  let finalPrompt = prompt;
  if (appendSystemPrompt) {
    finalPrompt = `[시스템 지침]\n${appendSystemPrompt}\n\n[사용자 메시지]\n${prompt}`;
  }
  if (cfg.claude.confirmBeforeEdit) {
    finalPrompt = `[시스템 지침] 파일을 수정(Edit/Write)하거나 삭제하기 전에 반드시 사용자에게 어떤 파일을 어떻게 변경할지 먼저 설명하고 확인을 받아줘. 확인 없이 파일을 수정하지 마.\n\n${finalPrompt}`;
  }

  const tmpOut = path.join(os.tmpdir(), `clawbrid-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  const sandbox = cfg.agent?.codex?.sandbox || 'danger-full-access';
  const model = cfg.agent?.codex?.model || null;

  const args = [];
  if (resumeSessionId) {
    args.push('exec', 'resume', resumeSessionId);
  } else {
    args.push('exec');
  }

  // 공통 옵션
  args.push('--json');
  args.push('--output-last-message', tmpOut);
  args.push('--skip-git-repo-check');
  // danger-full-access 외의 모드도 지원하되, 항상 bypass 플래그로 비대화형 보장
  if (sandbox === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', sandbox);
  }
  if (model) args.push('--model', model);
  args.push('-C', cfg.claude.workDir);
  for (const d of (cfg.claude.addDirs || [])) {
    args.push('--add-dir', d);
  }
  // prompt는 stdin으로
  args.push('-');

  let _proc = null;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn('codex', args, {
      cwd: cfg.claude.workDir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    _proc = proc;

    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let timeoutTimer = null;
    function resetTimer() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(async () => {
        if (settled) return;
        if (onTimeout) {
          try {
            const cont = await onTimeout();
            if (settled) return;
            if (cont) { resetTimer(); }
            else {
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

      let result = '';
      try {
        if (fs.existsSync(tmpOut)) {
          result = fs.readFileSync(tmpOut, 'utf-8').trim();
        }
      } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}

      const sessionId = extractSessionIdFromJsonl(stdout);
      if (!sessionId) {
        console.log('[CODEX] session_id 추출 실패 — 다음 턴은 --last로 fallback');
      }

      if (code !== 0 && !result) {
        const errMsg = stderr.trim().slice(0, 1500) || `종료 코드 ${code}`;
        reject(new Error(`Codex 오류: ${errMsg}`));
        return;
      }
      resolve({ result, session_id: sessionId });
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
  if (typeof result.result === 'string' && result.result.trim()) return result.result;
  return '(빈 응답)';
}

function extractSessionId(result) {
  return result?.session_id || null;
}

module.exports = { runCodex, extractText, extractSessionId, isCodexReady };
