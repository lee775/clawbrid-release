/**
 * ClawBrid - 메인 엔트리
 * Electron 모니터 + PM2로 각 Bridge를 별도 프로세스로 관리
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./core/config');

let mainWindow = null;
let petWindow = null;
let tray = null;

function getIconPath() {
  return path.join(__dirname, 'monitor', 'icon.ico');
}

function createWindow() {
  const isSetup = config.isFirstRun();

  mainWindow = new BrowserWindow({
    width: isSetup ? 700 : 900,
    height: isSetup ? 600 : 700,
    minWidth: 600,
    minHeight: 500,
    title: 'ClawBrid Monitor',
    icon: getIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // 복사/붙여넣기 단축키 활성화 (메뉴바 숨김 시 필요)
  const menu = Menu.buildFromTemplate([
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
  ]);
  Menu.setApplicationMenu(menu);

  if (isSetup) {
    mainWindow.loadFile(path.join(__dirname, 'monitor', 'setup.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'monitor', 'index.html'));
    startBridges();
  }

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
    if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
  });

  mainWindow.on('move', syncPetPosition);
  mainWindow.on('resize', syncPetPosition);

  // 첫 실행 시 바탕화면 바로가기 생성
  createDesktopShortcut();
}

function createTray() {
  const iconPath = getIconPath();
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('ClawBrid Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: () => { mainWindow.show(); if (petWindow && !petWindow.isDestroyed()) petWindow.show(); } },
    { type: 'separator' },
    { label: '종료', click: () => { stopBridges(); mainWindow.destroy(); app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow.show(); if (petWindow && !petWindow.isDestroyed()) petWindow.show(); });
}

// ── PM2로 Bridge 관리 ──
function startBridges() {
  const cfg = config.load();

  if (cfg.slack.enabled) {
    const slackScript = path.join(__dirname, 'bridges', 'slack-standalone.js');
    try {
      execSync(`pm2 describe clawbrid-slack`, { windowsHide: true, stdio: 'ignore' });
      execSync(`pm2 restart clawbrid-slack`, { windowsHide: true, stdio: 'ignore' });
    } catch {
      exec(`pm2 start "${slackScript}" --name clawbrid-slack`, { windowsHide: true });
    }
    console.log('[ClawBrid] Slack Bridge -> PM2 started');
  }

  if (cfg.telegram.enabled) {
    const tgScript = path.join(__dirname, 'bridges', 'telegram-standalone.js');
    try {
      execSync(`pm2 describe clawbrid-telegram`, { windowsHide: true, stdio: 'ignore' });
      execSync(`pm2 restart clawbrid-telegram`, { windowsHide: true, stdio: 'ignore' });
    } catch {
      exec(`pm2 start "${tgScript}" --name clawbrid-telegram`, { windowsHide: true });
    }
    console.log('[ClawBrid] Telegram Bridge -> PM2 started');
  }

  // 크론 워커 PM2 등록
  const cronScript = path.join(__dirname, 'cron-worker.js');
  try {
    execSync(`pm2 describe clawbrid-cron`, { windowsHide: true, stdio: 'ignore' });
    execSync(`pm2 restart clawbrid-cron`, { windowsHide: true, stdio: 'ignore' });
  } catch {
    exec(`pm2 start "${cronScript}" --name clawbrid-cron`, { windowsHide: true });
  }
  console.log('[ClawBrid] Cron Worker -> PM2 started');

  // PM2 상태 저장 (부팅 시 자동 복구용)
  exec('pm2 save', { windowsHide: true });

  // 다운로드 정리
  cleanupDownloads();
  setInterval(cleanupDownloads, cfg.cleanup.intervalHours * 60 * 60 * 1000);
}

function stopBridges() {
  try { execSync('pm2 stop clawbrid-slack', { windowsHide: true, stdio: 'ignore' }); } catch {}
  try { execSync('pm2 stop clawbrid-telegram', { windowsHide: true, stdio: 'ignore' }); } catch {}
}

function cleanupDownloads() {
  try {
    const cfg = config.load();
    const maxAge = cfg.cleanup.maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const dir = config.DOWNLOADS_DIR;
    if (!fs.existsSync(dir)) return;
    let deleted = 0;
    for (const file of fs.readdirSync(dir)) {
      const fp = path.join(dir, file);
      if (now - fs.statSync(fp).mtimeMs > maxAge) { fs.unlinkSync(fp); deleted++; }
    }
    if (deleted) console.log(`[CLEANUP] ${deleted} files deleted`);
  } catch {}
}

// ── 바탕화면 바로가기 (Windows) ──
function createDesktopShortcut() {
  if (process.platform !== 'win32') return;
  const shortcutPath = path.join(os.homedir(), 'Desktop', 'ClawBrid Monitor.lnk');
  if (fs.existsSync(shortcutPath)) return; // 이미 있으면 스킵

  try {
    const electronExe = process.execPath; // 현재 실행 중인 electron.exe
    const indexJs = path.join(__dirname, 'index.js');
    const iconPath = path.join(__dirname, 'monitor', 'icon.ico');
    // PowerShell로 바로가기 생성
    const ps = `
      $WshShell = New-Object -ComObject WScript.Shell;
      $Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');
      $Shortcut.TargetPath = '${electronExe.replace(/'/g, "''")}';
      $Shortcut.Arguments = '"${indexJs.replace(/'/g, "''")}"';
      $Shortcut.WorkingDirectory = '${__dirname.replace(/'/g, "''")}';
      $Shortcut.IconLocation = '${iconPath.replace(/'/g, "''")}';
      $Shortcut.Description = 'ClawBrid Monitor';
      $Shortcut.Save();
    `;
    execSync(`powershell -Command "${ps.replace(/\n/g, ' ')}"`, { windowsHide: true });
    console.log('[ClawBrid] Desktop shortcut created');
  } catch (err) {
    console.error(`[ClawBrid] Shortcut creation failed: ${err.message}`);
  }
}

// ── IPC ──
ipcMain.on('setup-complete', (event, newConfig) => {
  config.save(newConfig);
  mainWindow.loadFile(path.join(__dirname, 'monitor', 'index.html'));
  mainWindow.setSize(900, 700);
  startBridges();
});

ipcMain.on('save-config', (event, newConfig) => {
  config.save(newConfig);
});

ipcMain.on('open-settings', () => {
  mainWindow.loadFile(path.join(__dirname, 'monitor', 'setup.html'));
  mainWindow.setSize(700, 750);
});

ipcMain.on('go-dashboard', () => {
  mainWindow.loadFile(path.join(__dirname, 'monitor', 'index.html'));
  mainWindow.setSize(900, 700);
});

ipcMain.on('restart-bridges', () => {
  stopBridges();
  setTimeout(startBridges, 1000);
});

ipcMain.on('open-pet-window', () => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    return;
  }
  const mainBounds = mainWindow.getBounds();
  petWindow = new BrowserWindow({
    width: 180,
    height: 220,
    x: mainBounds.x + mainBounds.width + 4,
    y: mainBounds.y + mainBounds.height - 220,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    icon: getIconPath(),
    parent: mainWindow,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  petWindow.loadFile(path.join(__dirname, 'monitor', 'pet.html'));
  petWindow.on('closed', () => { petWindow = null; });
});

// 메인 창 이동/리사이즈 시 펫 창 동기화 (한 번만 등록)
function syncPetPosition() {
  if (petWindow && !petWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    petWindow.setPosition(b.x + b.width + 4, b.y + b.height - 220);
  }
}

// ── Electron 시작 ──
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* 트레이에 유지 */ });
