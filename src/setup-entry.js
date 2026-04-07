/**
 * ClawBrid Setup - 설정 UI만 실행
 * 저장 안 하고 닫으면 기존 설정 유지
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const config = require('./core/config');

let win = null;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    title: 'ClawBrid Setup',
    icon: path.join(__dirname, 'monitor', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile(path.join(__dirname, 'monitor', 'setup.html'));

  win.on('closed', () => { app.quit(); });
});

// 설정 저장 후 종료
ipcMain.on('setup-complete', (event, newConfig) => {
  config.save(newConfig);
  console.log('[ClawBrid] Config saved successfully');
  win.destroy();
  app.quit();
});

app.on('window-all-closed', () => { app.quit(); });
