/**
 * ClawBrid 영상 분석기
 * yt-dlp + ffmpeg + faster-whisper로 영상을 다운로드, 프레임 추출, 음성 변환 후 Claude에 전달
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');

const TEMP_BASE = path.join(os.homedir(), '.clawbrid', 'temp', 'video');
const MAX_FRAMES = 20;
const FRAME_INTERVAL = 15; // 초 단위
const MAX_DURATION = 3600; // 1시간 제한

// ffmpeg 경로 자동 탐색
let _ffmpegPath = null;
function getFFmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  try {
    execSync('ffmpeg -version', { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    _ffmpegPath = 'ffmpeg';
    return _ffmpegPath;
  } catch {}
  // winget 설치 경로 탐색
  const wingetBase = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    const dirs = fs.readdirSync(wingetBase).filter(d => d.startsWith('Gyan.FFmpeg'));
    for (const dir of dirs) {
      const binDir = path.join(wingetBase, dir);
      const subdirs = fs.readdirSync(binDir).filter(d => d.startsWith('ffmpeg'));
      for (const sub of subdirs) {
        const ffmpeg = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(ffmpeg)) { _ffmpegPath = ffmpeg; return _ffmpegPath; }
      }
    }
  } catch {}
  throw new Error('ffmpeg를 찾을 수 없습니다. ffmpeg를 설치해주세요.');
}

/**
 * 도구 설치 확인
 */
function checkTools() {
  const missing = [];
  try { execSync('yt-dlp --version', { windowsHide: true, stdio: 'pipe', timeout: 5000 }); } catch { missing.push('yt-dlp'); }
  try { getFFmpegPath(); } catch { missing.push('ffmpeg'); }
  return missing;
}

/**
 * 임시 디렉토리 생성
 */
function createTempDir() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(TEMP_BASE, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 임시 디렉토리 정리
 */
function cleanup(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

/**
 * 오래된 temp 파일 정리 (1시간 이상)
 */
function cleanupOldTemp() {
  try {
    if (!fs.existsSync(TEMP_BASE)) return;
    const now = Date.now();
    for (const dir of fs.readdirSync(TEMP_BASE)) {
      const fullPath = path.join(TEMP_BASE, dir);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 3600000) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch {}
}

/**
 * 영상 메타데이터 가져오기
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-download', url], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('메타데이터 조회 타임아웃')); }, 30000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`메타데이터 조회 실패: ${stderr.slice(0, 200)}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('메타데이터 파싱 실패')); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 영상 다운로드 (720p 이하, mp4)
 */
function downloadVideo(url, outputDir) {
  const ffmpegPath = getFFmpegPath();
  const outputFile = path.join(outputDir, 'video.mp4');
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', path.dirname(ffmpegPath),
      '-o', outputFile,
      '--no-playlist',
      url,
    ];
    const proc = spawn('yt-dlp', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('다운로드 타임아웃 (5분)')); }, 300000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`다운로드 실패: ${stderr.slice(0, 200)}`));
      // yt-dlp가 확장자를 바꿀 수 있으므로 실제 파일 탐색
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith('video.'));
      if (!files.length) return reject(new Error('다운로드된 파일을 찾을 수 없습니다'));
      resolve(path.join(outputDir, files[0]));
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 오디오 추출 (WAV 16kHz mono)
 */
function extractAudio(videoPath, outputDir) {
  const ffmpeg = getFFmpegPath();
  const audioPath = path.join(outputDir, 'audio.wav');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-i', videoPath,
      '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
      '-y', audioPath,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('오디오 추출 타임아웃')); }, 120000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(audioPath)) return reject(new Error(`오디오 추출 실패: ${stderr.slice(0, 200)}`));
      resolve(audioPath);
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 프레임 캡처 (JPEG, 일정 간격)
 */
function extractFrames(videoPath, outputDir, duration) {
  const ffmpeg = getFFmpegPath();
  const frameDir = path.join(outputDir, 'frames');
  fs.mkdirSync(frameDir, { recursive: true });

  // 영상 길이에 따라 간격 조정 (최대 MAX_FRAMES장)
  let interval = FRAME_INTERVAL;
  if (duration > 0) {
    const estimatedFrames = Math.ceil(duration / interval);
    if (estimatedFrames > MAX_FRAMES) {
      interval = Math.ceil(duration / MAX_FRAMES);
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-i', videoPath,
      '-vf', `fps=1/${interval},scale=640:-1`,
      '-q:v', '3',
      '-y',
      path.join(frameDir, 'frame_%03d.jpg'),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('프레임 추출 타임아웃')); }, 120000);

    proc.on('close', code => {
      clearTimeout(timer);
      const frames = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort();
      if (!frames.length) return reject(new Error('프레임 추출 실패'));
      resolve({
        paths: frames.map(f => path.join(frameDir, f)),
        interval,
        count: frames.length,
      });
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 음성 변환 (faster-whisper)
 */
function transcribeAudio(audioPath) {
  const absPath = audioPath.replace(/\\/g, '/');
  const pyCode = `
from faster_whisper import WhisperModel
model = WhisperModel("base", device="cpu", compute_type="int8")
segments, info = model.transcribe("${absPath}", beam_size=5)
for s in segments:
    print(f"[{int(s.start//60):02d}:{int(s.start%60):02d}] {s.text.strip()}")
`.trim();

  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-c', pyCode], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('음성 변환 타임아웃 (5분)')); }, 300000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`음성 변환 실패: ${stderr.slice(0, 300)}`));
      resolve(stdout.trim());
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 시간 포맷
 */
function formatDuration(seconds) {
  if (!seconds) return '알 수 없음';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

/**
 * 메인: 영상 분석
 * @param {string} url - 영상 URL
 * @param {string} question - 분석 질문 (선택)
 * @param {function} onProgress - 진행 상태 콜백
 * @returns {{ prompt: string, framePaths: string[], tempDir: string }}
 */
async function analyzeVideo(url, question, onProgress = () => {}) {
  // 도구 체크
  const missing = checkTools();
  if (missing.length) throw new Error(`필요한 도구가 없습니다: ${missing.join(', ')}\npip install yt-dlp && winget install ffmpeg`);

  cleanupOldTemp();
  const tempDir = createTempDir();

  try {
    // 1. 메타데이터
    onProgress('📋 영상 정보 조회 중...');
    const info = await getVideoInfo(url);
    const duration = info.duration || 0;
    const title = info.title || '제목 없음';
    const uploader = info.uploader || info.channel || '알 수 없음';

    if (duration > MAX_DURATION) {
      throw new Error(`영상이 너무 깁니다 (${formatDuration(duration)}). 최대 1시간까지 지원합니다.`);
    }

    // 2. 다운로드
    onProgress(`⬇️ 영상 다운로드 중... (${formatDuration(duration)})`);
    const videoPath = await downloadVideo(url, tempDir);

    // 3. 프레임 추출 + 오디오 추출 (병렬)
    onProgress('📸 프레임 추출 + 🎤 음성 변환 중...');
    const [frameResult, audioPath] = await Promise.all([
      extractFrames(videoPath, tempDir, duration),
      extractAudio(videoPath, tempDir),
    ]);

    // 4. 음성 변환
    onProgress('🎤 음성 텍스트 변환 중...');
    let transcript = '';
    try {
      transcript = await transcribeAudio(audioPath);
    } catch (e) {
      transcript = `(음성 변환 실패: ${e.message})`;
    }

    // 5. 프롬프트 구성
    const frameList = frameResult.paths.map((p, i) => {
      const timeSec = i * frameResult.interval;
      const mm = String(Math.floor(timeSec / 60)).padStart(2, '0');
      const ss = String(timeSec % 60).padStart(2, '0');
      return `- ${p.replace(/\\/g, '/')} (${mm}:${ss})`;
    }).join('\n');

    const userQ = question || '이 영상의 내용을 종합적으로 분석하고 핵심 내용을 정리해주세요.';

    const prompt = `[영상 분석 요청]
제목: ${title}
채널: ${uploader}
길이: ${formatDuration(duration)}
URL: ${url}

[음성 텍스트 (자동 변환)]
${transcript || '(음성 없음)'}

[영상 프레임 캡처 (${frameResult.count}장, ${frameResult.interval}초 간격)]
아래 이미지 파일들을 Read 도구로 열어서 영상의 시각적 내용을 함께 분석해주세요:
${frameList}

[분석 요청]
${userQ}

위 음성 텍스트와 영상 프레임 이미지를 모두 종합하여 분석해주세요.
시각적 정보(화면에 보이는 텍스트, 차트, 인물, 장면 등)와 음성 내용을 함께 고려해주세요.`;

    // 비디오 원본 삭제 (용량 절약, 프레임+오디오만 유지)
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}

    return { prompt, framePaths: frameResult.paths, tempDir, title, duration };
  } catch (e) {
    cleanup(tempDir);
    throw e;
  }
}

/**
 * YouTube/영상 URL 감지
 */
function isVideoUrl(text) {
  return /(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/|vimeo\.com\/|dailymotion\.com|twitch\.tv\/videos)/.test(text);
}

module.exports = { analyzeVideo, cleanup, checkTools, isVideoUrl };
