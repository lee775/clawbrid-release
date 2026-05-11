/**
 * Telegram MTProto 다운로더 (gramjs 기반)
 *
 * Bot API의 getFile은 20MB까지만 지원함. 그 이상은 MTProto로 직접 다운로드.
 * 봇 토큰 인증, 세션은 ~/.clawbrid/.telegram-mtproto-session에 저장.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SESSION_FILE = path.join(config.CONFIG_DIR, '.telegram-mtproto-session');

let _client = null;
let _connecting = null;

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, 'utf-8').trim();
  } catch {}
  return '';
}

function saveSession(str) {
  try {
    fs.writeFileSync(SESSION_FILE, str, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error(`[TG MTPROTO] saveSession failed: ${err.message}`);
  }
}

function isConfigured() {
  const cfg = config.load();
  return !!(cfg.telegram.apiId && cfg.telegram.apiHash && cfg.telegram.botToken);
}

async function getClient() {
  if (_client && _client.connected) return _client;
  if (_connecting) return _connecting;

  if (!isConfigured()) {
    throw new Error('apiId/apiHash 미설정 (https://my.telegram.org/apps 에서 발급 후 setup에 입력)');
  }

  _connecting = (async () => {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const cfg = config.load();
    const apiId = parseInt(cfg.telegram.apiId, 10);
    const apiHash = String(cfg.telegram.apiHash);
    const session = new StringSession(loadSession());
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      useWSS: false,
    });
    // gramjs는 기본적으로 자체 logger가 verbose함 → 에러만 표시
    if (client.setLogLevel) client.setLogLevel('error');
    await client.start({ botAuthToken: cfg.telegram.botToken });
    saveSession(client.session.save());
    _client = client;
    return client;
  })();

  try {
    return await _connecting;
  } finally {
    _connecting = null;
  }
}

/**
 * 큰 파일을 message ID로 다운로드.
 * @param {number} messageId  bot이 받은 메시지의 message_id
 * @param {string} destPath   저장할 절대 경로
 * @param {(downloaded:number,total:number)=>void} [onProgress]
 * @returns {Promise<{path:string,size:number}>}
 */
async function downloadByMessageId(messageId, destPath, onProgress) {
  const { Api } = require('telegram');
  const client = await getClient();

  // 봇 자신의 dialog 컨텍스트에서 message ID로 직접 조회
  // (1:1/일반 그룹은 messages.GetMessages, 슈퍼그룹/채널은 별도 처리 필요하지만
  //  bot이 텔레그램에서 직접 받는 시나리오는 1:1 위주이므로 1차 구현은 이걸로 커버)
  const result = await client.invoke(new Api.messages.GetMessages({
    id: [new Api.InputMessageID({ id: messageId })],
  }));

  const message = (result.messages || []).find((m) => m && m.media);
  if (!message) {
    throw new Error('MTProto: 메시지 또는 미디어를 찾을 수 없음');
  }

  // outputFile에 WriteStream을 넘기면 메모리에 전체 버퍼를 올리지 않음
  const ws = fs.createWriteStream(destPath);
  try {
    await client.downloadMedia(message, {
      outputFile: ws,
      progressCallback: (downloaded, total) => {
        if (onProgress) {
          try { onProgress(Number(downloaded), Number(total)); } catch {}
        }
      },
    });
  } finally {
    try { ws.end(); } catch {}
  }

  // 파일 크기 확정 대기 (스트림 close까지)
  await new Promise((resolve) => {
    if (ws.closed) return resolve();
    ws.once('close', resolve);
    ws.once('finish', resolve);
  });

  const size = fs.statSync(destPath).size;
  return { path: destPath, size };
}

async function disconnect() {
  if (_client) {
    try { await _client.disconnect(); } catch {}
    _client = null;
  }
}

module.exports = {
  isConfigured,
  downloadByMessageId,
  disconnect,
  SESSION_FILE,
};
