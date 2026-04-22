/**
 * Codex 기반 이미지 생성
 * - 사용자 요청 → Claude로 영문 상세 프롬프트 변환 → codex exec 실행
 * - ~/.clawbrid/temp/images 에 생성된 파일 목록 반환 (전송 후 호출부가 cleanup)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMAGE_DIR = path.join(os.homedir(), '.clawbrid', 'temp', 'images');

function isCodexReady() {
  try {
    execSync('codex --version', { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

// 자연어에서 "이미지 생성 요청"을 감지 (과거형/부정형은 제외되도록 단순 패턴)
function isImageRequest(text) {
  if (!text) return false;
  const s = text.trim();
  return (
    /그려\s*줘/.test(s) ||
    /그려\s*주세요/.test(s) ||
    /그림\s*그려/.test(s) ||
    /이미지[을를]?\s*(만들|생성|그려)/.test(s) ||
    /그림[을를]?\s*(만들|생성)/.test(s) ||
    /사진[을를]?\s*(만들|생성|그려)/.test(s) ||
    /\b(draw|generate|create|make)\s+(me\s+)?(an?\s+)?(image|picture|drawing|art|illustration)\b/i.test(s)
  );
}

// cmd.exe / sh 공통 안전 인자 quote
function quoteArg(s) {
  const cleaned = String(s).replace(/\r?\n/g, ' ');
  if (process.platform === 'win32') {
    return '"' + cleaned.replace(/"/g, '\\"') + '"';
  }
  return "'" + cleaned.replace(/'/g, "'\\''") + "'";
}

// Claude에 짧은 1-turn 요청으로 영문 상세 프롬프트 생성
function enhancePrompt(userText) {
  return new Promise((resolve) => {
    const instruction = `Rewrite the following user request as a single detailed English image-generation prompt (40-80 words). Add style, lighting, composition, color palette, quality hints (e.g., "cinematic", "4k", "intricate details"). Output ONLY the prompt text — no quotes, no markdown, no explanation, no prefix.

User request: ${userText}`;

    const proc = spawn('claude', [
      '-p', '-',
      '--output-format', 'json',
      '--max-turns', '1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve(userText); // 변환 실패 시 원문 사용
    }, 60000);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        const txt = (parsed.result || '').trim();
        if (txt) return resolve(txt);
      } catch {}
      resolve(userText);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(userText); });

    try {
      proc.stdin.write(instruction);
      proc.stdin.end();
    } catch {}
  });
}

// codex exec --skip-git-repo-check "prompt"
function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const cmd = `codex exec --skip-git-repo-check ${quoteArg(prompt)}`;
    const proc = spawn(cmd, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error('Codex 실행 타임아웃 (5분)'));
    }, 300000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).trim().slice(-500);
        reject(new Error(`Codex 종료 코드 ${code}: ${tail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// 메인 진입점
async function generate(userText, progressFn) {
  if (!isCodexReady()) {
    throw new Error('Codex CLI가 설치되지 않았습니다. 공식 설치 가이드를 확인해주세요.');
  }

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const before = new Set(fs.readdirSync(IMAGE_DIR));

  if (progressFn) await progressFn('🌐 프롬프트 영문 상세화...');
  const englishPrompt = await enhancePrompt(userText);

  if (progressFn) await progressFn(`🎨 Codex 이미지 생성 중...\n📝 ${englishPrompt.slice(0, 300)}`);

  const saveDir = IMAGE_DIR.replace(/\\/g, '/');
  const codexPrompt = `Generate an image from the following prompt and save it as a PNG file to: ${saveDir}
Use any descriptive filename ending in .png. Do not ask for confirmation — proceed directly and save the file.

Prompt: ${englishPrompt}`;

  await runCodex(codexPrompt);

  const after = fs.readdirSync(IMAGE_DIR);
  const newFiles = after
    .filter((f) => !before.has(f) && /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => path.join(IMAGE_DIR, f));

  if (!newFiles.length) {
    throw new Error('Codex가 이미지를 생성하지 않았습니다. (저장 경로 확인 필요)');
  }

  return { englishPrompt, files: newFiles };
}

function cleanup(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

module.exports = { isImageRequest, isCodexReady, generate, cleanup, IMAGE_DIR };
