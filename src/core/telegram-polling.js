/**
 * 텔레그램 getUpdates 폴링 — 단일 루프
 *
 * node-telegram-bot-api 내장 폴링(polling: true)은 쓰지 않는다.
 * 내장 startPolling() 재시작은 기존 루프를 멈추지 못하고 루프를 하나 더 만들고,
 * stopPolling({ cancel: true })는 루프를 멈추지 못한다 (Bluebird 취소 시 finally가 다음 폴링을 예약).
 * 루프가 겹치면 같은 메시지가 여러 번 처리된다.
 */

const LONG_POLL_SEC = 30;             // 새 메시지가 없으면 텔레그램이 30초 뒤 빈 응답
const REQUEST_TIMEOUT_MS = 90 * 1000; // 이보다 오래 무응답이면 끊긴 연결로 보고 요청 폐기
const ERROR_DELAY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (typeof promise.cancel === 'function') promise.cancel(); // 걸린 HTTP 요청 중단
      reject(new Error(`getUpdates ${ms / 1000}초 무응답`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startPolling(bot, { requestTimeoutMs = REQUEST_TIMEOUT_MS, errorDelayMs = ERROR_DELAY_MS } = {}) {
  let running = true;
  let offset = 0;

  (async () => {
    while (running) {
      let updates;
      try {
        updates = await withTimeout(bot.getUpdates({ offset, timeout: LONG_POLL_SEC }), requestTimeoutMs);
      } catch (err) {
        if (!running) break;
        console.error(`[TELEGRAM] polling_error: ${err.code || ''} ${err.message}`);
        if (err.response?.statusCode === 409 && /webhook/i.test(err.message)) {
          await bot.deleteWebHook().catch(() => {});
          continue;
        }
        // 429면 텔레그램이 알려준 시간만큼 대기 — 일찍 재요청하면 제한이 늘어난다
        const retryAfter = err.response?.body?.parameters?.retry_after;
        await sleep(retryAfter ? (retryAfter + 1) * 1000 : errorDelayMs);
        continue;
      }
      if (!running) break;
      for (const update of updates) {
        if (update.update_id < offset) continue;
        offset = update.update_id + 1;
        try { bot.processUpdate(update); }
        catch (err) { console.error(`[TELEGRAM] update 처리 실패: ${err.message}`); }
      }
    }
  })();

  return { stop() { running = false; } };
}

module.exports = { startPolling };
