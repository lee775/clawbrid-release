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
// Codex CLI 기본 이미지 출력 경로 (~/.codex/generated_images/<session>/ig_*.png)
const CODEX_IMAGE_DIR = path.join(os.homedir(), '.codex', 'generated_images');

// 디렉토리를 재귀적으로 돌며 이미지 파일 경로를 Set으로 반환
function snapshotImages(rootDir) {
  const found = new Set();
  try {
    if (!fs.existsSync(rootDir)) return found;
    const stack = [rootDir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)) found.add(full);
      }
    }
  } catch {}
  return found;
}

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

// codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "prompt"
// bypass 플래그는 비대화형 MCP 환경에서 필수 — 없으면 approval 프롬프트 대기로 hang
function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const cmd = `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${quoteArg(prompt)}`;
    // stdin='ignore' 필수 — pipe로 열어두면 codex가 stdin EOF 대기로 hang
    const proc = spawn(cmd, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
// options.enhance: true(기본) = Claude CLI로 영문 상세 프롬프트 재생성
//                  false = userText를 그대로 사용 (MCP 경로처럼 이미 Claude가 구성한 프롬프트일 때)
async function generate(userText, progressFn, options = {}) {
  const { enhance = true } = options;
  if (!isCodexReady()) {
    throw new Error('Codex CLI가 설치되지 않았습니다. 공식 설치 가이드를 확인해주세요.');
  }

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const beforeLocal = new Set(fs.readdirSync(IMAGE_DIR));
  const beforeCodex = snapshotImages(CODEX_IMAGE_DIR);

  let englishPrompt;
  if (enhance) {
    if (progressFn) await progressFn('🌐 프롬프트 영문 상세화...');
    englishPrompt = await enhancePrompt(userText);
  } else {
    englishPrompt = userText;
  }

  if (progressFn) await progressFn(`🎨 Codex 이미지 생성 중...\n📝 ${englishPrompt.slice(0, 300)}`);

  const saveDir = IMAGE_DIR.replace(/\\/g, '/');
  const codexPrompt = `Generate an image from the following prompt and save it as a PNG file to: ${saveDir}
Use any descriptive filename ending in .png. Do not ask for confirmation — proceed directly and save the file.

Prompt: ${englishPrompt}`;

  await runCodex(codexPrompt);

  // 1. IMAGE_DIR에서 새 파일 탐지
  const afterLocal = fs.readdirSync(IMAGE_DIR);
  const newLocal = afterLocal
    .filter((f) => !beforeLocal.has(f) && /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => path.join(IMAGE_DIR, f));

  // 2. Codex 기본 경로(~/.codex/generated_images)도 함께 스캔 (Codex가 지시를 무시하고 기본 경로에 저장하는 케이스)
  const afterCodex = snapshotImages(CODEX_IMAGE_DIR);
  const newCodex = [...afterCodex].filter((f) => !beforeCodex.has(f));

  const newFiles = [...newLocal, ...newCodex];

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
