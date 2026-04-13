/**
 * ClawBrid 이미지 생성/합성 모듈
 * Local Stable Diffusion WebUI API (Automatic1111) 연동
 * 기본 URL: http://127.0.0.1:7860 (--api 플래그 필요)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTPUT_DIR = path.join(os.homedir(), '.clawbrid', 'temp', 'images');
const DEFAULT_SD_URL = 'http://127.0.0.1:7860';

/**
 * config.json에서 SD WebUI URL 읽기
 */
function getSDUrl() {
  try {
    const cfgPath = path.join(os.homedir(), '.clawbrid', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.stableDiffusion?.url) return cfg.stableDiffusion.url;
    }
  } catch {}
  return DEFAULT_SD_URL;
}

/**
 * SD WebUI HTTP 요청
 */
function sdRequest(endpoint, method = 'GET', body = null, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const baseUrl = getSDUrl();
    const url = new URL(endpoint, baseUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Accept': 'application/json' },
    };

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          return reject(new Error(`SD WebUI 오류 (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`SD WebUI 응답 파싱 실패: ${raw.slice(0, 200)}`));
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SD WebUI 요청 타임아웃 (${Math.round(timeout / 1000)}초)`));
    }, timeout);

    req.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ECONNREFUSED') {
        reject(new Error(
          `Stable Diffusion WebUI에 연결할 수 없습니다 (${baseUrl}).\n` +
          '확인사항:\n' +
          '1. SD WebUI가 실행 중인지 확인\n' +
          '2. --api 플래그로 시작했는지 확인\n' +
          '   (webui-user.bat의 COMMANDLINE_ARGS에 --api 추가)\n' +
          '3. config.json의 stableDiffusion.url이 올바른지 확인'
        ));
      } else {
        reject(e);
      }
    });

    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * base64 이미지를 파일로 저장
 */
function saveImage(base64Data, prefix = 'gen') {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return filePath;
}

/**
 * 파일에서 base64 읽기
 */
function imageToBase64(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error(`이미지 파일을 찾을 수 없습니다: ${imagePath}`);
  return fs.readFileSync(imagePath).toString('base64');
}

/**
 * txt2img - 텍스트로 이미지 생성
 */
async function generate(options = {}) {
  const body = {
    prompt: options.prompt || '',
    negative_prompt: options.negative_prompt || '(worst quality, low quality:1.4), blurry, watermark, text',
    width: options.width || 512,
    height: options.height || 512,
    steps: options.steps || 20,
    cfg_scale: options.cfg_scale || 7,
    sampler_name: options.sampler || 'Euler a',
    seed: options.seed ?? -1,
    batch_size: Math.min(options.batch_size || 1, 4),
  };

  const timeout = (body.steps > 30 ? 600 : 300) * 1000;
  const result = await sdRequest('/sdapi/v1/txt2img', 'POST', body, timeout);

  if (!result.images || !result.images.length) {
    throw new Error('SD WebUI에서 이미지가 반환되지 않았습니다');
  }

  const images = [];
  for (const img of result.images) {
    const filePath = saveImage(img, 'gen');
    images.push({ base64: img, path: filePath });
  }

  return { images, parameters: body };
}

/**
 * img2img - 이미지 기반 수정/합성
 */
async function edit(options = {}) {
  if (!options.image_path) throw new Error('image_path가 필요합니다');
  const initBase64 = imageToBase64(options.image_path);

  const body = {
    init_images: [initBase64],
    prompt: options.prompt || '',
    negative_prompt: options.negative_prompt || '(worst quality, low quality:1.4), blurry, watermark',
    denoising_strength: options.denoising_strength ?? 0.75,
    width: options.width || 512,
    height: options.height || 512,
    steps: options.steps || 20,
    cfg_scale: options.cfg_scale || 7,
    sampler_name: options.sampler || 'Euler a',
    seed: options.seed ?? -1,
  };

  const result = await sdRequest('/sdapi/v1/img2img', 'POST', body, 300000);

  if (!result.images || !result.images.length) {
    throw new Error('SD WebUI에서 이미지가 반환되지 않았습니다');
  }

  const images = [];
  for (const img of result.images) {
    const filePath = saveImage(img, 'edit');
    images.push({ base64: img, path: filePath });
  }

  return { images, parameters: body };
}

/**
 * 이미지 업스케일
 */
async function upscale(options = {}) {
  if (!options.image_path) throw new Error('image_path가 필요합니다');
  const base64 = imageToBase64(options.image_path);

  const body = {
    image: base64,
    upscaler_1: options.upscaler || 'R-ESRGAN 4x+',
    upscaling_resize: options.scale || 2,
  };

  const result = await sdRequest('/sdapi/v1/extra-single-image', 'POST', body, 300000);

  if (!result.image) {
    throw new Error('업스케일 결과가 반환되지 않았습니다');
  }

  const filePath = saveImage(result.image, 'upscale');
  return { base64: result.image, path: filePath };
}

/**
 * 사용 가능한 모델 목록
 */
async function getModels() {
  return await sdRequest('/sdapi/v1/sd-models', 'GET', null, 10000);
}

/**
 * 모델 변경
 */
async function setModel(modelName) {
  await sdRequest('/sdapi/v1/options', 'POST', { sd_model_checkpoint: modelName }, 120000);
}

/**
 * 샘플러 목록
 */
async function getSamplers() {
  return await sdRequest('/sdapi/v1/samplers', 'GET', null, 10000);
}

/**
 * 업스케일러 목록
 */
async function getUpscalers() {
  return await sdRequest('/sdapi/v1/upscalers', 'GET', null, 10000);
}

/**
 * SD WebUI 연결 상태 확인
 */
async function getStatus() {
  try {
    const [options, samplers] = await Promise.all([
      sdRequest('/sdapi/v1/options', 'GET', null, 5000),
      sdRequest('/sdapi/v1/samplers', 'GET', null, 5000),
    ]);
    return {
      connected: true,
      url: getSDUrl(),
      currentModel: options.sd_model_checkpoint || '알 수 없음',
      samplers: samplers.map(s => s.name),
    };
  } catch (e) {
    return {
      connected: false,
      url: getSDUrl(),
      error: e.message,
    };
  }
}

/**
 * 현재 진행 상태 조회
 */
async function getProgress() {
  try {
    const result = await sdRequest('/sdapi/v1/progress', 'GET', null, 5000);
    return {
      progress: Math.round((result.progress || 0) * 100),
      eta: result.eta_relative ? Math.round(result.eta_relative) : null,
      currentStep: result.state?.sampling_step || 0,
      totalSteps: result.state?.sampling_steps || 0,
    };
  } catch {
    return { progress: 0, eta: null };
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
      if (now - stat.mtimeMs > 3600000) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}

module.exports = {
  generate,
  edit,
  upscale,
  getModels,
  setModel,
  getSamplers,
  getUpscalers,
  getStatus,
  getProgress,
  cleanupOldImages,
  saveImage,
  getSDUrl,
  OUTPUT_DIR,
};
