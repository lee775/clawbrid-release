/**
 * ClawBrid 플러그인 매니저
 * - ~/.clawbrid/plugins/ 폴더의 JS 파일을 자동 로드
 * - 커스텀 명령어, 프롬프트 전처리, 응답 후처리 훅 지원
 *
 * 플러그인 형식:
 *   module.exports = {
 *     name: 'my-plugin',
 *     description: '설명',
 *     commands: {
 *       '/hello': async (ctx) => '안녕!',     // Telegram 명령어
 *     },
 *     onBeforePrompt: (prompt, ctx) => prompt, // 프롬프트 전처리
 *     onAfterResponse: (response, ctx) => response, // 응답 후처리
 *   };
 *
 * ctx = { userId, chatId, source: 'telegram' }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGINS_DIR = path.join(os.homedir(), '.clawbrid', 'plugins');
const plugins = [];

function ensureDir() {
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

/**
 * 플러그인 폴더를 스캔하여 모든 JS 파일을 로드
 */
function loadAll() {
  ensureDir();
  plugins.length = 0;

  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      // require 캐시 제거 (리로드 지원)
      const fullPath = path.join(PLUGINS_DIR, file);
      delete require.cache[require.resolve(fullPath)];
      const plugin = require(fullPath);

      if (!plugin.name) plugin.name = file.replace('.js', '');
      plugins.push(plugin);
      console.log(`[PLUGIN] Loaded: ${plugin.name} (${file})`);
    } catch (err) {
      console.error(`[PLUGIN] Failed to load ${file}: ${err.message}`);
    }
  }
  return plugins;
}

/**
 * 명령어 텍스트가 플러그인 커맨드와 매칭되는지 확인
 * @returns {{ plugin, handler, cmdName }} | null
 */
function matchCommand(text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  for (const plugin of plugins) {
    if (!plugin.commands) continue;
    for (const [pattern, handler] of Object.entries(plugin.commands)) {
      if (cmd === pattern.toLowerCase()) {
        return { plugin, handler, cmdName: pattern };
      }
    }
  }
  return null;
}

/**
 * 모든 플러그인의 onBeforePrompt 훅을 순서대로 실행
 */
function runBeforePrompt(prompt, ctx) {
  let result = prompt;
  for (const plugin of plugins) {
    if (typeof plugin.onBeforePrompt === 'function') {
      try {
        const modified = plugin.onBeforePrompt(result, ctx);
        if (typeof modified === 'string') result = modified;
      } catch (err) {
        console.error(`[PLUGIN] ${plugin.name}.onBeforePrompt error: ${err.message}`);
      }
    }
  }
  return result;
}

/**
 * 모든 플러그인의 onAfterResponse 훅을 순서대로 실행
 */
function runAfterResponse(response, ctx) {
  let result = response;
  for (const plugin of plugins) {
    if (typeof plugin.onAfterResponse === 'function') {
      try {
        const modified = plugin.onAfterResponse(result, ctx);
        if (typeof modified === 'string') result = modified;
      } catch (err) {
        console.error(`[PLUGIN] ${plugin.name}.onAfterResponse error: ${err.message}`);
      }
    }
  }
  return result;
}

/**
 * 로드된 플러그인 목록 반환
 */
function getList() {
  return plugins.map(p => ({
    name: p.name,
    description: p.description || '',
    commands: p.commands ? Object.keys(p.commands) : [],
    hasBeforePrompt: typeof p.onBeforePrompt === 'function',
    hasAfterResponse: typeof p.onAfterResponse === 'function',
  }));
}

/**
 * 플러그인 리로드
 */
function reload() {
  return loadAll();
}

module.exports = {
  loadAll,
  matchCommand,
  runBeforePrompt,
  runAfterResponse,
  getList,
  reload,
  PLUGINS_DIR,
};
