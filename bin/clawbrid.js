#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
// 첫 실행(config 없음) → setup, 그 외 기본 dashboard
const isFirstRun = !fs.existsSync(path.join(os.homedir(), '.clawbrid', 'config.json'));
const command = args[0] || (isFirstRun ? 'setup' : 'dashboard');

const CONFIG_DIR = path.join(os.homedir(), '.clawbrid');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CLAWBRID_ROOT = path.join(__dirname, '..');

const MONITOR_EXE = 'clawbrid-monitor.exe';
const RELEASE_TAG = 'v1.0.0-tauri';
const RELEASE_URL = `https://github.com/lee775/clawbrid-release/releases/download/${RELEASE_TAG}/${MONITOR_EXE}`;

// ── Tauri 모니터 exe 찾기 ──
function findMonitorExe() {
  const paths = [
    path.join(CONFIG_DIR, MONITOR_EXE),                                          // ~/.clawbrid/
    path.join(CLAWBRID_ROOT, 'dist', MONITOR_EXE),                              // dist/
    path.join(CLAWBRID_ROOT, 'src-tauri', 'target', 'release', MONITOR_EXE),    // dev release
    path.join(CLAWBRID_ROOT, 'src-tauri', 'target', 'debug', MONITOR_EXE),      // dev debug (fallback)
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── GitHub Releases에서 exe 다운로드 ──
function downloadMonitorExe() {
  return new Promise((resolve, reject) => {
    const dest = path.join(CONFIG_DIR, MONITOR_EXE);
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

    console.log('  Downloading ClawBrid Monitor...');
    function follow(url, redirects) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = url.startsWith('https') ? https : require('http');
      mod.get(url, { headers: { 'User-Agent': 'clawbrid' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
          console.log(`  Downloaded (${mb}MB)`);
          resolve(dest);
        });
        file.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
      }).on('error', reject);
    }
    follow(RELEASE_URL, 0);
  });
}

// ── exe 찾거나 없으면 다운로드 ──
async function ensureMonitorExe() {
  const found = findMonitorExe();
  if (found) return found;
  return await downloadMonitorExe();
}

// ── 바탕화면 바로가기 (Windows) ──
function ensureDesktopShortcut(exePath) {
  if (process.platform !== 'win32') return;
  const shortcut = path.join(os.homedir(), 'Desktop', 'ClawBrid Monitor.lnk');
  if (fs.existsSync(shortcut)) return;
  try {
    const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcut.replace(/\\/g, '\\\\')}');$s.TargetPath='${exePath.replace(/\\/g, '\\\\')}';$s.WorkingDirectory='${path.dirname(exePath).replace(/\\/g, '\\\\')}';$s.IconLocation='${exePath.replace(/\\/g, '\\\\')}';$s.Description='ClawBrid Monitor';$s.Save()`;
    execSync(`powershell -Command "${ps}"`, { windowsHide: true, stdio: 'ignore' });
    console.log('  Desktop shortcut created.');
  } catch {}
}

// ── 중복 실행 방지 ──
function isMonitorRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq clawbrid-monitor.exe" /NH', { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    return out.includes('clawbrid-monitor.exe');
  } catch { return false; }
}

// ── 명령어 ──
const commands = {

  async dashboard() {
    ensureMCP();
    if (isMonitorRunning()) {
      console.log('  ClawBrid Monitor is already running.');
      return;
    }
    const exe = await ensureMonitorExe();
    ensureDesktopShortcut(exe);
    const proc = spawn(exe, [], { stdio: 'ignore', windowsHide: true, detached: true });
    proc.unref();
    console.log('  ClawBrid Monitor started.');
  },

  start() {
    ensureMCP();
    const target = args[1]; // slack, telegram, or undefined (=all)
    if (!target || target === 'all') {
      tryPM2('clawbrid-slack', path.join(CLAWBRID_ROOT, 'src', 'bridges', 'slack-standalone.js'));
      tryPM2('clawbrid-telegram', path.join(CLAWBRID_ROOT, 'src', 'bridges', 'telegram-standalone.js'));
      tryPM2('clawbrid-cron', path.join(CLAWBRID_ROOT, 'src', 'cron-worker.js'));
    } else if (target === 'slack') {
      tryPM2('clawbrid-slack', path.join(CLAWBRID_ROOT, 'src', 'bridges', 'slack-standalone.js'));
    } else if (target === 'telegram') {
      tryPM2('clawbrid-telegram', path.join(CLAWBRID_ROOT, 'src', 'bridges', 'telegram-standalone.js'));
    } else {
      console.log(`Unknown target: ${target}. Use: slack, telegram, or all`);
    }
  },

  stop() {
    const target = args[1];
    if (!target || target === 'all') {
      pm2Cmd('stop', 'clawbrid-slack');
      pm2Cmd('stop', 'clawbrid-telegram');
      pm2Cmd('stop', 'clawbrid-cron');
    } else {
      pm2Cmd('stop', `clawbrid-${target}`);
    }
  },

  restart() {
    const target = args[1];
    if (!target || target === 'all') {
      pm2Cmd('restart', 'clawbrid-slack');
      pm2Cmd('restart', 'clawbrid-telegram');
      pm2Cmd('restart', 'clawbrid-cron');
    } else {
      pm2Cmd('restart', `clawbrid-${target}`);
    }
  },

  status() {
    try {
      execSync('pm2 list', { stdio: 'inherit', windowsHide: true });
    } catch {
      console.log('PM2 not available');
    }
    console.log(`\nConfig: ${CONFIG_FILE}`);
    console.log(`Data:   ${CONFIG_DIR}`);
  },

  logs() {
    const target = args[1] || 'all';
    if (target === 'all') {
      try { execSync('pm2 logs --nostream --lines 50', { stdio: 'inherit', windowsHide: true }); } catch {}
    } else {
      try { execSync(`pm2 logs clawbrid-${target} --nostream --lines 50`, { stdio: 'inherit', windowsHide: true }); } catch {}
    }
  },

  config() {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log('No config found. Run "clawbrid setup" to configure.');
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const mask = (s) => s ? s.slice(0, 8) + '****' : '(not set)';
    console.log(`
  ClawBrid Configuration
  ──────────────────────────────────────
  Claude Code
    Work Dir     : ${cfg.claude?.workDir || '-'}
    Add Dirs     : ${cfg.claude?.addDirs?.join(', ') || '-'}
    Max Turns    : ${cfg.claude?.maxTurns || 50}
    Timeout      : ${(cfg.claude?.timeout || 600000) / 1000}s
    Confirm Edit : ${cfg.claude?.confirmBeforeEdit ? 'Yes' : 'No'}

  Slack          : ${cfg.slack?.enabled ? 'Enabled' : 'Disabled'}
    Bot Token    : ${mask(cfg.slack?.botToken)}
    App Token    : ${mask(cfg.slack?.appToken)}

  Telegram       : ${cfg.telegram?.enabled ? 'Enabled' : 'Disabled'}
    Bot Token    : ${mask(cfg.telegram?.botToken)}
    Admin User   : ${cfg.telegram?.adminUser || '(not set)'}
    Allowed Users: ${cfg.telegram?.allowedUsers?.length ? cfg.telegram.allowedUsers.join(', ') : '(none)'}

  Cleanup        : ${cfg.cleanup?.maxAgeDays || 7} days
  Config File    : ${CONFIG_FILE}
  Data Dir       : ${CONFIG_DIR}
  ──────────────────────────────────────
`);
  },

  update() {
    const pkg = require(path.join(CLAWBRID_ROOT, 'package.json'));
    console.log(`  Current version: ${pkg.version}`);

    // 개발자 모드 감지: 소스 디렉토리에서 실행 중인지 확인
    const isDevMode = fs.existsSync(path.join(CLAWBRID_ROOT, '.git'));

    // 1. 프로세스 중지 + 파일 잠금 해제
    console.log('  Stopping processes...');
    try { execSync('taskkill /f /im clawbrid-monitor.exe', { stdio: 'ignore', windowsHide: true }); } catch {}
    try { execSync('taskkill /f /im electron.exe', { stdio: 'ignore', windowsHide: true }); } catch {}
    try { execSync('pm2 delete clawbrid-slack clawbrid-telegram clawbrid-cron', { stdio: 'ignore', windowsHide: true }); } catch {}
    execSync('ping 127.0.0.1 -n 3 >nul', { stdio: 'ignore', windowsHide: true });

    // 2. 업데이트 (개발자 모드 vs 일반 사용자 구분)
    if (isDevMode) {
      // 개발자: 소스에서 git pull 후 로컬 경로로 재설치 (심링크 유지)
      console.log('  [DEV] Source directory detected. Pulling latest...\n');
      try {
        execSync('git pull', { stdio: 'inherit', windowsHide: true, cwd: CLAWBRID_ROOT });
        execSync(`npm install -g "${CLAWBRID_ROOT}" --force`, { stdio: 'inherit', windowsHide: true });
        const newPkg = JSON.parse(fs.readFileSync(path.join(CLAWBRID_ROOT, 'package.json'), 'utf-8'));
        console.log(`\n  Updated to: ${newPkg.version}`);
      } catch (err) {
        console.error(`\n  Update failed: ${err.message}`);
      }
    } else {
      // 일반 사용자: GitHub release에서 설치
      console.log('  Checking for updates...\n');
      try {
        execSync('npm install -g lee775/clawbrid-release --force', { stdio: 'inherit', windowsHide: true });
        const newPkg = JSON.parse(fs.readFileSync(path.join(CLAWBRID_ROOT, 'package.json'), 'utf-8'));
        console.log(`\n  Updated to: ${newPkg.version}`);
      } catch (err) {
        console.error(`\n  Update failed: ${err.message}`);
      }
    }

    // 3. 모니터 exe 갱신 (Tauri에 HTML이 번들링되므로 재다운로드 필요)
    const cachedExe = path.join(CONFIG_DIR, MONITOR_EXE);
    if (fs.existsSync(cachedExe)) {
      try { fs.unlinkSync(cachedExe); console.log('  Monitor exe removed (will re-download on next dashboard).'); } catch {}
    }

    // 4. PM2 다시 등록
    try { execSync(`pm2 start "${path.join(CLAWBRID_ROOT, 'src', 'bridges', 'slack-standalone.js')}" --name clawbrid-slack`, { stdio: 'ignore', windowsHide: true }); } catch {}
    try { execSync(`pm2 start "${path.join(CLAWBRID_ROOT, 'src', 'bridges', 'telegram-standalone.js')}" --name clawbrid-telegram`, { stdio: 'ignore', windowsHide: true }); } catch {}
    try { execSync(`pm2 start "${path.join(CLAWBRID_ROOT, 'src', 'cron-worker.js')}" --name clawbrid-cron`, { stdio: 'ignore', windowsHide: true }); } catch {}
    try { execSync('pm2 save', { stdio: 'ignore', windowsHide: true }); } catch {}
    console.log('  PM2 processes restarted.');

    // 5. MCP 서버 자동 등록/갱신
    ensureMCP();
  },

  version() {
    const pkg = require(path.join(CLAWBRID_ROOT, 'package.json'));
    console.log(`  ClawBrid v${pkg.version}`);
  },

  async setup() {
    const exe = await ensureMonitorExe();
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    const proc = spawn(exe, [], { stdio: 'ignore', windowsHide: true, detached: true });
    proc.unref();
    console.log('  ClawBrid Setup started.');
  },

  help() {
    console.log(`
  ClawBrid - Claude Code Bridge for Slack & Telegram

  Usage: clawbrid <command> [options]

  Commands:
    dashboard              Open monitor dashboard
    setup                  Open setup wizard (reconfigure Slack/Telegram)
    start [slack|telegram]  Start bridge server (default: all)
    stop [slack|telegram]   Stop bridge server (default: all)
    restart [slack|telegram] Restart bridge server (default: all)
    status                  Show PM2 process status
    logs [slack|telegram]   Show recent logs (default: all)
    config                  Show current config
    update                  Update to latest version
    version                 Show current version
    help                    Show this help

  Examples:
    clawbrid dashboard      # Open monitoring UI
    clawbrid setup          # Reconfigure Slack/Telegram tokens
    clawbrid update         # Update to latest version
    clawbrid start          # Start all bridges
    clawbrid start slack    # Start Slack bridge only
    clawbrid stop telegram  # Stop Telegram bridge only
    clawbrid restart slack  # Restart Slack bridge
    clawbrid logs telegram  # Show Telegram logs
    clawbrid status         # Show all process status
`);
  },
};

// ── PM2 헬퍼 ──
function ensureMCP() {
  try {
    execSync('claude --version', { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } catch {
    return; // claude CLI 없으면 스킵
  }

  const mcpBase = path.join(__dirname, '..', 'src', 'mcp');
  const servers = [
    { name: 'clawbrid-cron', file: 'cron-mcp-server.js' },
    { name: 'clawbrid-video', file: 'video-mcp-server.js' },
    { name: 'clawbrid-image', file: 'image-mcp-server.js' },
  ];

  let existing = '';
  try {
    existing = execSync('claude mcp list', { encoding: 'utf-8', windowsHide: true, timeout: 30000 });
  } catch { return; }

  for (const srv of servers) {
    if (existing.includes(srv.name)) continue; // 이미 등록됨 → 스킵
    const srvPath = path.join(mcpBase, srv.file).replace(/\\/g, '/');
    try {
      console.log(`  MCP 등록: ${srv.name}`);
      execSync(`claude mcp add --scope user ${srv.name} -- node "${srvPath}"`, { stdio: 'inherit', windowsHide: true, timeout: 15000 });
    } catch (e) {
      console.log(`  ${srv.name} MCP 등록 실패: ${e.message}`);
    }
  }
}

function ensurePM2() {
  try {
    execSync('pm2 --version', { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log('  PM2 not found. Installing...');
    try {
      execSync('npm install -g pm2', { stdio: 'inherit', windowsHide: true });
      console.log('  PM2 installed successfully.');
    } catch {
      console.error('  PM2 install failed. Run manually: npm install -g pm2');
      process.exit(1);
    }
  }
}

function tryPM2(name, script) {
  ensurePM2();
  try {
    execSync(`pm2 describe ${name}`, { windowsHide: true, stdio: 'ignore' });
    execSync(`pm2 restart ${name}`, { stdio: 'inherit', windowsHide: true });
  } catch {
    try {
      execSync(`pm2 start "${script}" --name ${name}`, { stdio: 'inherit', windowsHide: true });
    } catch (err) {
      console.error(`Failed to start ${name}: ${err.message}`);
    }
  }
}

function pm2Cmd(action, name) {
  try {
    execSync(`pm2 ${action} ${name}`, { stdio: 'inherit', windowsHide: true });
  } catch {}
}

// ── 실행 ──
if (commands[command]) {
  Promise.resolve(commands[command]()).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.log(`Unknown command: ${command}`);
  commands.help();
}
