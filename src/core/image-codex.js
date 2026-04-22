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

// codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-i <file>] "prompt"
// bypass 플래그는 비대화형 MCP 환경에서 필수 — 없으면 approval 프롬프트 대기로 hang
// sourceImage 전달 시 -i 옵션으로 원본 이미지 첨부 (수정/편집 모드)
function runCodex(prompt, sourceImage = null) {
  return new Promise((resolve, reject) => {
    // -i <FILE>... 는 multi-value 옵션이라 뒤 인자를 모두 이미지로 먹음.
    // prompt를 positional로 분리하려면 `--` 구분자 필수.
    const imgArg = sourceImage ? `-i ${quoteArg(sourceImage)} -- ` : '';
    const cmd = `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${imgArg}${quoteArg(prompt)}`;
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
// options.sourceImage: 원본 이미지 경로 — 전달되면 codex -i 로 첨부 (수정/편집 모드)
async function generate(userText, progressFn, options = {}) {
  const { enhance = true, sourceImage = null } = options;
  if (!isCodexReady()) {
    throw new Error('Codex CLI가 설치되지 않았습니다. 공식 설치 가이드를 확인해주세요.');
  }

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  // 1시간 이상 남아있는 orphan 파일 먼저 청소
  cleanupStale();
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
  const verb = sourceImage ? 'Edit the attached image according to the following instructions, then save the result' : 'Generate an image from the following prompt and save it';
  const codexPrompt = `${verb} as a PNG file to: ${saveDir}
Use any descriptive filename ending in .png. Do not ask for confirmation — proceed directly and save the file.

Prompt: ${englishPrompt}`;

  await runCodex(codexPrompt, sourceImage);

  // 1. IMAGE_DIR에서 새 파일 탐지
  const afterLocal = fs.readdirSync(IMAGE_DIR);
  const newLocal = afterLocal
    .filter((f) => !beforeLocal.has(f) && /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => path.join(IMAGE_DIR, f));

  // 2. Codex 기본 경로(~/.codex/generated_images)도 스캔 (Codex가 지시를 무시하고 기본 경로에 저장하는 케이스,
  //    특히 편집 모드에서 자주 발생). 감지된 파일은 IMAGE_DIR로 이동시켜 브릿지가 단일 경로만 감시하도록 함.
  const afterCodex = snapshotImages(CODEX_IMAGE_DIR);
  const newCodex = [...afterCodex].filter((f) => !beforeCodex.has(f));
  const movedFromCodex = [];
  for (const src of newCodex) {
    const base = path.basename(src);
    let dest = path.join(IMAGE_DIR, base);
    // 파일명 충돌 방지
    if (fs.existsSync(dest)) {
      dest = path.join(IMAGE_DIR, `${Date.now()}_${base}`);
    }
    try {
      fs.renameSync(src, dest);
      movedFromCodex.push(dest);
    } catch (e) {
      // 크로스 디바이스 등 rename 실패 시 copy + unlink fallback
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        movedFromCodex.push(dest);
      } catch { movedFromCodex.push(src); } // 이동 실패 시 원본 경로라도 반환
    }
  }

  const newFiles = [...newLocal, ...movedFromCodex];

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

// 두 이미지 경로의 오래된 파일(기본 1시간 이상) 제거. 전송 실패·브릿지 크래시로 남은 orphan 처리용.
// 빈 codex 세션 디렉토리도 함께 제거.
function cleanupStale(maxAgeMs = 3600000) {
  const now = Date.now();
  const removeOld = (file) => {
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(file);
    } catch {}
  };

  try {
    if (fs.existsSync(IMAGE_DIR)) {
      for (const name of fs.readdirSync(IMAGE_DIR)) {
        if (/\.(png|jpe?g|webp)$/i.test(name)) removeOld(path.join(IMAGE_DIR, name));
      }
    }
  } catch {}

  try {
    if (fs.existsSync(CODEX_IMAGE_DIR)) {
      for (const session of fs.readdirSync(CODEX_IMAGE_DIR)) {
        const sdir = path.join(CODEX_IMAGE_DIR, session);
        let stat;
        try { stat = fs.statSync(sdir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        let entries = [];
        try { entries = fs.readdirSync(sdir); } catch {}
        for (const name of entries) {
          if (/\.(png|jpe?g|webp)$/i.test(name)) removeOld(path.join(sdir, name));
        }
        // 세션 디렉토리가 비었으면 제거
        try {
          if (!fs.readdirSync(sdir).length) fs.rmdirSync(sdir);
        } catch {}
      }
    }
  } catch {}
}

module.exports = { isImageRequest, isCodexReady, generate, cleanup, cleanupStale, IMAGE_DIR, CODEX_IMAGE_DIR };
