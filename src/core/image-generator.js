/**
 * ClawBrid 이미지 생성/합성 모듈
 * Python diffusers 라이브러리 기반 Stable Diffusion
 * 모델은 Python 워커 프로세스에 상주 (최초 로드 후 메모리 유지)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTPUT_DIR = path.join(os.homedir(), '.clawbrid', 'temp', 'images');
const WORKER_SCRIPT = path.join(__dirname, 'sd-worker.py');

// ── 워커 프로세스 관리 ──
let worker = null;
let workerReady = false;
let pendingRequests = new Map();
let requestIdCounter = 0;
let stdoutBuffer = '';

/**
 * 워커 프로세스 시작/재사용
 */
function ensureWorker() {
  if (worker && !worker.killed && worker.exitCode === null) return;

  workerReady = false;
  stdoutBuffer = '';

  worker = spawn('python', [WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // stdout: JSON 응답 파싱
  worker.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // 미완성 라인 보관

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // ready/loading 등 상태 메시지
        if (msg.status === 'ready') {
          workerReady = true;
        }

        // ID가 있는 요청 응답
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const { resolve, reject, timer } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        }
      } catch {}
    }
  });

  // stderr: Python 로그 (모델 다운로드 진행률 등)
  worker.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[SD-Worker] ${text}`);
  });

  worker.on('exit', (code) => {
    worker = null;
    workerReady = false;
    // 대기 중인 요청들 실패 처리
    for (const [id, { reject, timer }] of pendingRequests) {
      clearTimeout(timer);
      reject(new Error(`SD 워커 프로세스 종료 (code=${code})`));
    }
    pendingRequests.clear();
  });

  worker.on('error', (err) => {
    console.error(`[SD-Worker] 프로세스 시작 실패: ${err.message}`);
  });
}

/**
 * 워커에 요청 전송 (Promise)
 */
function sendRequest(action, params = {}, timeout = 600000) {
  return new Promise((resolve, reject) => {
    ensureWorker();

    const id = ++requestIdCounter;
    const req = JSON.stringify({ id, action, ...params }) + '\n';

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`이미지 생성 타임아웃 (${Math.round(timeout / 1000)}초)`));
    }, timeout);

    pendingRequests.set(id, { resolve, reject, timer });

    try {
      worker.stdin.write(req);
    } catch (e) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(new Error(`워커 통신 실패: ${e.message}`));
    }
  });
}

/**
 * 도구 설치 확인
 */
function checkTools() {
  const missing = [];
  try {
    execSync('python -c "import diffusers"', { stdio: 'pipe', windowsHide: true, timeout: 10000 });
  } catch { missing.push('diffusers'); }
  try {
    execSync('python -c "import torch"', { stdio: 'pipe', windowsHide: true, timeout: 10000 });
  } catch { missing.push('torch'); }
  return missing;
}

// ── 공개 API (MCP/브릿지에서 호출) ──

/**
 * txt2img - 텍스트로 이미지 생성
 */
async function generate(options = {}) {
  cleanupOldImages();
  const result = await sendRequest('generate', {
    prompt: options.prompt || '',
    negative_prompt: options.negative_prompt,
    width: options.width || 512,
    height: options.height || 512,
    steps: options.steps || 20,
    cfg_scale: options.cfg_scale || 7,
    seed: options.seed ?? -1,
    batch_size: options.batch_size || 1,
    model: options.model,
  });
  return { images: result.images, parameters: options };
}

/**
 * img2img - 이미지 기반 수정/합성
 */
async function edit(options = {}) {
  if (!options.image_path) throw new Error('image_path가 필요합니다');
  if (!fs.existsSync(options.image_path)) throw new Error(`이미지 파일을 찾을 수 없습니다: ${options.image_path}`);

  const result = await sendRequest('edit', {
    image_path: options.image_path.replace(/\\/g, '/'),
    prompt: options.prompt || '',
    negative_prompt: options.negative_prompt,
    denoising_strength: options.denoising_strength ?? 0.75,
    width: options.width || 512,
    height: options.height || 512,
    steps: options.steps || 20,
    cfg_scale: options.cfg_scale || 7,
    seed: options.seed ?? -1,
    model: options.model,
  });
  return { images: result.images, parameters: options };
}

/**
 * 이미지 업스케일
 */
async function upscale(options = {}) {
  if (!options.image_path) throw new Error('image_path가 필요합니다');
  if (!fs.existsSync(options.image_path)) throw new Error(`이미지 파일을 찾을 수 없습니다: ${options.image_path}`);

  const result = await sendRequest('upscale', {
    image_path: options.image_path.replace(/\\/g, '/'),
    scale: options.scale || 2,
  });
  return { base64: result.base64, path: result.path };
}

/**
 * 상태 확인 (GPU/CPU, 모델 로드 여부 등)
 */
async function getStatus() {
  const missing = checkTools();
  if (missing.length) {
    return {
      connected: false,
      error: `필요한 패키지가 없습니다: ${missing.join(', ')}\n설치: pip install diffusers transformers accelerate torch`,
    };
  }
  try {
    const result = await sendRequest('status', {}, 15000);
    return {
      connected: true,
      device: result.device,
      gpu: result.gpu,
      vram_gb: result.vram_gb,
      model_loaded: result.model_loaded,
      current_model: result.current_model,
      diffusers_version: result.diffusers_version,
      torch_version: result.torch_version,
    };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

/**
 * 오래된 임시 이미지 정리 (1시간 이상)
 */
function cleanupOldImages() {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      const fp = path.join(OUTPUT_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 3600000) fs.unlinkSync(fp);
    }
  } catch {}
}

/**
 * 워커 종료
 */
function shutdown() {
  if (worker && worker.exitCode === null) {
    try { worker.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n'); } catch {}
    setTimeout(() => { if (worker) { try { worker.kill(); } catch {} } }, 3000);
  }
}

module.exports = {
  generate,
  edit,
  upscale,
  getStatus,
  checkTools,
  cleanupOldImages,
  shutdown,
  OUTPUT_DIR,
};
