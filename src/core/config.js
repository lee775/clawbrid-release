/**
 * ClawBrid 설정 관리
 * 설정 파일: ~/.clawbrid/config.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.clawbrid');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATUS_DIR = path.join(CONFIG_DIR, 'status');
const HISTORY_DIR = path.join(CONFIG_DIR, 'history');
const DOWNLOADS_DIR = path.join(CONFIG_DIR, 'downloads');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

const DEFAULT_CONFIG = {
  // Claude Code 설정
  claude: {
    workDir: 'C:/',
    addDirs: ['C:/', 'D:/'],
    maxTurns: 50,
    timeout: 600000, // 10분
    confirmBeforeEdit: true, // 파일 수정/삭제 전 확인
  },
  // Slack 설정
  slack: {
    enabled: false,
    botToken: '',
    signingSecret: '',
    appToken: '',
  },
  // Telegram 설정
  telegram: {
    enabled: false,
    botToken: '',
    adminUser: '',
    allowedUsers: [],
  },
  // 모니터 설정
  monitor: {
    autoStart: true,
    minimizeToTray: true,
  },
  // 다운로드 정리
  cleanup: {
    maxAgeDays: 7,
    intervalHours: 24,
  },
};

function ensureDirs() {
  for (const dir of [CONFIG_DIR, STATUS_DIR, HISTORY_DIR, DOWNLOADS_DIR, LOGS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return deepMerge(DEFAULT_CONFIG, saved);
    }
  } catch (err) {
    console.error(`[CONFIG] Load failed: ${err.message}`);
  }
  return { ...DEFAULT_CONFIG };
}

function save(config) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function isFirstRun() {
  return !fs.existsSync(CONFIG_FILE);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  STATUS_DIR,
  HISTORY_DIR,
  DOWNLOADS_DIR,
  LOGS_DIR,
  SESSIONS_FILE,
  DEFAULT_CONFIG,
  load,
  save,
  isFirstRun,
  ensureDirs,
};
