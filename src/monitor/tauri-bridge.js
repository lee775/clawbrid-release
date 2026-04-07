/**
 * ClawBrid Runtime Bridge (Single Source of Truth)
 * Tauri / Electron 런타임 감지 및 모든 플랫폼 추상화를 이 파일 하나에서 관리.
 * HTML에서는 <script src="tauri-bridge.js"></script> 한 줄로 로드.
 */

// ── 런타임 감지 ──
const IS_TAURI = window.__TAURI_INTERNALS__ !== undefined;
const IS_ELECTRON = typeof process !== 'undefined' && process.versions && !!process.versions.electron;

// ── Tauri invoke wrapper ──
function tauriInvoke(cmd, args) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
}

// ── homedir ──
let HOMEDIR = IS_ELECTRON
  ? require('os').homedir()
  : 'C:\\Users\\pc_09'; // Tauri: 초기값, initBridge()에서 갱신

// ── 경로 헬퍼 ──
function joinPath(...parts) {
  return parts.join('\\');
}

let CLAWBRID_DIR, STATUS_DIR, PET_FILE, LOG_PATHS;

function _buildPaths() {
  CLAWBRID_DIR = joinPath(HOMEDIR, '.clawbrid');
  STATUS_DIR = joinPath(CLAWBRID_DIR, 'status');
  PET_FILE = joinPath(CLAWBRID_DIR, '.pet');
  LOG_PATHS = {
    slack: {
      out: joinPath(HOMEDIR, '.pm2', 'logs', 'clawbrid-slack-out.log'),
      err: joinPath(HOMEDIR, '.pm2', 'logs', 'clawbrid-slack-error.log'),
    },
    telegram: {
      out: joinPath(HOMEDIR, '.pm2', 'logs', 'clawbrid-telegram-out.log'),
      err: joinPath(HOMEDIR, '.pm2', 'logs', 'clawbrid-telegram-error.log'),
    },
  };
}
_buildPaths();

// Tauri: Rust에서 실제 homedir 가져와서 경로 갱신
async function initBridge() {
  if (IS_TAURI) {
    try {
      HOMEDIR = await tauriInvoke('get_homedir');
      _buildPaths();
    } catch {}
  }
}
// 즉시 호출 (async)
initBridge();

// ── 파일 I/O ──
const bridge = {
  readFileSync(filePath) {
    if (IS_ELECTRON) return require('fs').readFileSync(filePath, 'utf-8');
    return null;
  },

  fileExistsSync(filePath) {
    if (IS_ELECTRON) return require('fs').existsSync(filePath);
    return false;
  },

  async readFile(filePath) {
    if (IS_TAURI) return tauriInvoke('read_file', { path: filePath });
    return require('fs').readFileSync(filePath, 'utf-8');
  },

  async writeFile(filePath, content) {
    if (IS_TAURI) return tauriInvoke('write_file', { path: filePath, content });
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  },

  async fileExists(filePath) {
    if (IS_TAURI) {
      try { await tauriInvoke('read_file', { path: filePath }); return true; }
      catch { return false; }
    }
    return require('fs').existsSync(filePath);
  },

  // ── 명령 실행 ──
  execSync(cmd, opts) {
    if (IS_ELECTRON) {
      return require('child_process').execSync(cmd, {
        encoding: 'utf-8', windowsHide: true, timeout: 5000, ...opts,
      });
    }
    return null;
  },

  exec(cmd, callback) {
    if (IS_ELECTRON) {
      require('child_process').exec(cmd, { windowsHide: true }, callback);
    } else if (IS_TAURI && callback) {
      callback();
    }
  },

  // ── PM2 ──
  async getPM2List() {
    if (IS_TAURI) return tauriInvoke('get_pm2_status');
    const raw = this.execSync('pm2 jlist');
    return JSON.parse(raw);
  },

  pm2Action(action, name) {
    if (IS_TAURI) {
      return tauriInvoke('get_pm2_status'); // TODO: Tauri shell plugin
    }
    return new Promise(resolve => {
      this.exec(`pm2 ${action} ${name}`, resolve);
    });
  },

  // ── IPC / 네비게이션 ──
  restartBridges() {
    if (IS_TAURI) return tauriInvoke('restart_bridges');
    require('electron').ipcRenderer.send('restart-bridges');
    this.exec('pm2 restart all');
  },

  openSettings() {
    if (IS_TAURI) { window.location.href = 'setup.html'; return; }
    require('electron').ipcRenderer.send('open-settings');
  },

  goBack() {
    if (IS_TAURI) { window.location.href = 'index.html'; return; }
    require('electron').ipcRenderer.send('go-dashboard');
  },

  openPetWindow() {
    if (IS_TAURI) return tauriInvoke('open_pet_window').catch(() => {});
    require('electron').ipcRenderer.send('open-pet-window');
  },

  setupComplete(cfg) {
    if (IS_TAURI) {
      return tauriInvoke('save_config', { config: cfg }).then(() => {
        window.location.href = 'index.html';
      });
    }
    require('electron').ipcRenderer.send('setup-complete', cfg);
  },

  // ── 크론 ──
  async loadCrons() {
    if (IS_TAURI) return tauriInvoke('load_crons');
    return require('../core/cron-manager').loadCrons();
  },

  async saveCrons(crons) {
    if (IS_TAURI) return tauriInvoke('save_crons', { crons });
    require('../core/cron-manager').saveCrons(crons);
  },

  async addCron(entry) {
    if (IS_ELECTRON) {
      const cm = require('../core/cron-manager');
      const result = cm.addCron(entry);
      cm.startCron(result);
      return result;
    }
    // Tauri: JSON 직접 조작
    const crons = await this.loadCrons();
    const id = Date.now().toString(36);
    const newEntry = { id, ...entry, enabled: true, lastRun: null, lastResult: null, createdAt: new Date().toISOString() };
    crons.push(newEntry);
    await this.saveCrons(crons);
    return newEntry;
  },

  async toggleCron(id) {
    if (IS_ELECTRON) {
      require('../core/cron-manager').toggleCron(id);
      return;
    }
    const crons = await this.loadCrons();
    const entry = crons.find(c => c.id === id);
    if (entry) entry.enabled = !entry.enabled;
    await this.saveCrons(crons);
  },

  async removeCron(id) {
    if (IS_ELECTRON) {
      require('../core/cron-manager').removeCron(id);
      return;
    }
    let crons = await this.loadCrons();
    crons = crons.filter(c => c.id !== id);
    await this.saveCrons(crons);
  },

  async executeCron(cron) {
    if (IS_ELECTRON) return require('../core/cron-manager').executeCron(cron);
  },

  // ── 설정 ──
  async loadConfig() {
    if (IS_TAURI) return tauriInvoke('load_config');
    const fs = require('fs');
    const cfgFile = joinPath(CLAWBRID_DIR, 'config.json');
    if (!fs.existsSync(cfgFile)) return {};
    return JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
  },

  async saveConfig(cfg) {
    if (IS_TAURI) return tauriInvoke('save_config', { config: cfg });
    const fs = require('fs');
    fs.writeFileSync(joinPath(CLAWBRID_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
  },

  // ── 상태 (비동기 캐시) ──
  _statusCache: {},

  readStatusSync(name) {
    if (IS_ELECTRON) {
      try {
        const fp = joinPath(STATUS_DIR, name + '.json');
        if (require('fs').existsSync(fp)) {
          return JSON.parse(require('fs').readFileSync(fp, 'utf-8'));
        }
      } catch {}
    }
    return this._statusCache[name] || null;
  },

  async refreshStatusCache() {
    if (!IS_TAURI) return;
    for (const name of ['slack', 'telegram']) {
      try {
        const content = await this.readFile(joinPath(STATUS_DIR, name + '.json'));
        this._statusCache[name] = JSON.parse(content);
      } catch { this._statusCache[name] = null; }
    }
  },

  // ── 로그 ──
  async readLogContent(name) {
    const paths = LOG_PATHS[name];
    let content = '';
    if (IS_TAURI) {
      try { content += await this.readFile(paths.out); } catch {}
      try { content += await this.readFile(paths.err); } catch {}
    } else {
      const fs = require('fs');
      if (fs.existsSync(paths.out)) content += fs.readFileSync(paths.out, 'utf-8');
      if (fs.existsSync(paths.err)) content += fs.readFileSync(paths.err, 'utf-8');
    }
    return content;
  },

  // ── 펫 ──
  async loadPet() {
    try {
      const content = await this.readFile(PET_FILE);
      const data = JSON.parse(content);
      if (IS_TAURI) return data.pet || null;
      // Electron: token 검증
      const { getPetToken } = require('../pet/pet-generator');
      if (data.token && data.token === getPetToken() && data.pet) return data.pet;
    } catch {}
    return null;
  },

  async savePet(pet) {
    const token = IS_ELECTRON ? require('../pet/pet-generator').getPetToken() : 'tauri-default';
    const content = JSON.stringify({ token, pet, savedAt: new Date().toISOString() }, null, 2);
    await this.writeFile(PET_FILE, content);
  },

  generatePet() {
    if (IS_ELECTRON) return require('../pet/pet-generator').generatePet();
    // Tauri fallback: 인라인 펫 풀
    const pool = [
      { emoji: '🐱', name: '미묘', grade: { name: 'Common', stars: '⭐', color: '#8b949e' } },
      { emoji: '🐶', name: '멍멍이', grade: { name: 'Common', stars: '⭐', color: '#8b949e' } },
      { emoji: '🐰', name: '토끼', grade: { name: 'Rare', stars: '⭐⭐', color: '#58a6ff' } },
      { emoji: '🦊', name: '여우', grade: { name: 'Rare', stars: '⭐⭐', color: '#58a6ff' } },
      { emoji: '🐲', name: '용용이', grade: { name: 'Epic', stars: '⭐⭐⭐', color: '#d2a8ff' } },
      { emoji: '🦄', name: '유니콘', grade: { name: 'Legendary', stars: '⭐⭐⭐⭐', color: '#f0883e' } },
      { emoji: '🐉', name: '드래곤', grade: { name: 'Legendary', stars: '⭐⭐⭐⭐', color: '#f0883e' } },
      { emoji: '👻', name: '팬텀', grade: { name: 'Mythic', stars: '⭐⭐⭐⭐⭐', color: '#f85149' } },
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  },
};

// 전역 노출
window.IS_TAURI = IS_TAURI;
window.IS_ELECTRON = IS_ELECTRON;
window.HOMEDIR = HOMEDIR;
window.STATUS_DIR = STATUS_DIR;
window.LOG_PATHS = LOG_PATHS;
window.PET_FILE = PET_FILE;
window.bridge = bridge;
