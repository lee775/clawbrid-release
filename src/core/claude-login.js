/**
 * 텔레그램에서 Claude 다시 로그인하기 (/login)
 * - claude-login-pty.py 가 CLI 로그인을 가상 터미널에서 띄워, 브라우저를 열지 않고 로그인 링크만 받아 온다
 * - 링크에서 승인하면 나오는 코드를 submit() 으로 넘기면 CLI 에 대신 입력한다
 * - 계정 이름을 주면 setup-token 으로 1년짜리 토큰을 받아 ~/.claude-tokens/<이름>.txt 에 저장하고,
 *   없으면 PC 로그인(claude auth login)을 새로 한다. 토큰은 파일에만 쓰고 출력 · 로그에 남기지 않는다
 * - Windows 전용 (Python pywinpty 사용, 없으면 설치)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const claudeAccounts = require('./claude-accounts');

const HELPER = path.join(__dirname, 'claude-login-pty.py');
const URL_TIMEOUT_MS = 90 * 1000;
const FINISH_TIMEOUT_MS = 3 * 60 * 1000;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CODE_RE = /^[A-Za-z0-9_-]{10,}#[A-Za-z0-9_-]{10,}$/;

function looksLikeCode(text) {
  return CODE_RE.test(String(text || '').trim());
}

// 명령을 조용히 실행하고 { code, stdout } 를 돌려준다
function run(cmd, args, { env = process.env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const proc = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', () => {});
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout }); };
    proc.on('close', finish);
    proc.on('error', () => finish(-1));
  });
}

async function ensurePywinpty() {
  if ((await run('python', ['-c', 'import winpty'], { timeout: 15000 })).code === 0) return true;
  console.log('[LOGIN] pywinpty 설치 중...');
  return (await run('python', ['-m', 'pip', 'install', 'pywinpty'], { timeout: 300000 })).code === 0;
}

// 이 인증으로 Claude 가 실제로 답하는지 (브릿지와 같은 작업 폴더)
async function canAnswer(accountEnv) {
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  Object.assign(env, accountEnv);
  const { stdout } = await run('claude', ['-p', '1+1 결과 숫자만', '--output-format', 'json', '--max-turns', '1'],
    { env, cwd: config.load().claude.workDir, timeout: 120000 });
  try { return JSON.parse(stdout).is_error === false; } catch { return false; }
}

async function loginEmail() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const { stdout } = await run('claude', ['auth', 'status'], { env, timeout: 30000 });
  try { return JSON.parse(stdout).email || null; } catch { return null; }
}

/**
 * 로그인 시작. 링크를 받을 때까지 기다린다.
 * @param {{ account?: string|null }} opts account 가 있으면 그 계정 토큰, 없으면 PC 로그인
 * @returns {Promise<{ url, mode, account, submit(code): Promise<object>, cancel() }>}
 */
async function start({ account = null } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows 에서만 쓸 수 있습니다');
  if (account && !ACCOUNT_RE.test(account)) throw new Error('계정 이름은 영문 · 숫자 · _ · - 만 쓸 수 있습니다');
  if (!(await ensurePywinpty())) throw new Error('pywinpty 를 설치하지 못했습니다 (python -m pip install pywinpty)');

  const mode = account ? 'token' : 'login';
  const outFile = account ? path.join(claudeAccounts.TOKEN_DIR, `${account}.new`) : null;
  if (outFile) fs.mkdirSync(claudeAccounts.TOKEN_DIR, { recursive: true });
  const args = ['-u', HELPER, '--mode', mode];
  if (outFile) args.push('--out', outFile);
  const proc = spawn('python', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const queue = [];
  let wake = null;
  const deliver = (ev) => { queue.push(ev); if (wake) { const w = wake; wake = null; w(); } };
  async function nextEvent(ms) {
    const deadline = Date.now() + ms;
    while (!queue.length) {
      const left = deadline - Date.now();
      if (left <= 0) return { event: 'error', message: '시간이 지났습니다' };
      await new Promise((r) => { wake = r; setTimeout(r, left); });
    }
    return queue.shift();
  }

  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try { if (line) deliver(JSON.parse(line)); } catch {}
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
  proc.on('close', () => deliver({ event: 'error', message: stderr.trim().split('\n').pop() || '로그인 도우미가 끝났습니다' }));
  proc.on('error', (err) => deliver({ event: 'error', message: err.message }));

  // 입력을 닫으면 도우미가 CLI 를 정리하고 끝난다. 그래도 남아 있으면 3초 뒤 강제 종료
  const kill = () => {
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { if (proc.exitCode === null) try { proc.kill(); } catch {} }, 3000).unref();
  };
  const dropNew = () => { if (outFile) fs.rmSync(outFile, { force: true }); };

  const first = await nextEvent(URL_TIMEOUT_MS);
  if (first.event !== 'url') { kill(); dropNew(); throw new Error(first.message || '로그인 링크를 받지 못했습니다'); }

  let settled = false;
  return {
    url: first.url,
    mode,
    account,
    /** @returns {Promise<{ ok: true, mode, account, email, addedToAccounts } | { ok: false, message }>} */
    async submit(code) {
      if (settled) return { ok: false, message: '이미 끝난 로그인입니다' };
      settled = true;
      proc.stdin.write(`${String(code).trim()}\n`);
      const ev = await nextEvent(FINISH_TIMEOUT_MS);
      kill();
      if (ev.event !== 'done') { dropNew(); return { ok: false, message: ev.message || '로그인에 실패했습니다' }; }

      if (mode === 'login') {
        if (!(await canAnswer({}))) return { ok: false, message: '로그인은 됐지만 Claude 가 답하지 않습니다' };
        return { ok: true, mode, account: null, email: await loginEmail(), addedToAccounts: false };
      }

      const token = fs.readFileSync(outFile, 'utf8').trim();
      if (!(await canAnswer({ CLAUDE_CODE_OAUTH_TOKEN: token }))) {
        dropNew();
        return { ok: false, message: '받은 토큰으로 Claude 가 답하지 않습니다' };
      }
      fs.renameSync(outFile, path.join(claudeAccounts.TOKEN_DIR, `${account}.txt`));
      claudeAccounts.markAvailable(account);
      const cfg = config.load();
      const accounts = Array.isArray(cfg.claude.accounts) ? cfg.claude.accounts : [];
      const addedToAccounts = !accounts.includes(account);
      if (addedToAccounts) {
        cfg.claude.accounts = [account, ...accounts];
        config.save(cfg);
      }
      return { ok: true, mode, account, email: null, addedToAccounts };
    },
    cancel() {
      if (settled) return;
      settled = true;
      kill();
      dropNew();
    },
  };
}

module.exports = { start, looksLikeCode };
