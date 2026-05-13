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
    maxTurns: 100,
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
    // MTProto fallback (20MB 초과 파일 다운로드용, https://my.telegram.org/apps 에서 발급)
    apiId: '',
    apiHash: '',
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
  // Agent 라우터 — 채팅별 /agent 명령으로 오버라이드 가능
  agent: {
    default: 'claude',         // 'claude' | 'codex' — 신규 채팅의 기본 agent
    codex: {
      sandbox: 'danger-full-access', // 'read-only' | 'workspace-write' | 'danger-full-access'
      model: null,                    // null이면 codex 기본 모델
    },
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
