#!/usr/bin/env node
/**
 * ClawBrid postinstall
 * npm install 후 자동 실행: 선택적 도구 설치 + MCP 서버 등록
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MCP_BASE = path.join(ROOT, 'src', 'mcp');

// ── 1. 선택적 Python 도구 설치 (실패해도 계속) ──
function installOptionalTools() {
  // faster-whisper (음성 인식)
  try {
    execSync('python -c "import faster_whisper"', { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch {
    try {
      console.log('  Installing faster-whisper...');
      execSync('pip install faster-whisper', { stdio: 'inherit', windowsHide: true, timeout: 120000 });
    } catch { console.log('  faster-whisper 설치 실패 (음성 인식 기능 비활성화)'); }
  }

  // yt-dlp (영상 다운로드)
  try {
    execSync('yt-dlp --version', { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } catch {
    try {
      console.log('  Installing yt-dlp...');
      execSync('pip install yt-dlp', { stdio: 'inherit', windowsHide: true, timeout: 120000 });
    } catch { console.log('  yt-dlp 설치 실패 (영상 분석 기능 비활성화)'); }
  }
}

// ── 2. MCP 서버 자동 등록 ──
function registerMCPServers() {
  try {
    execSync('claude --version', { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } catch {
    // claude CLI 없으면 스킵
    return;
  }

  let existing = '';
  try {
    existing = execSync('claude mcp list', { encoding: 'utf-8', windowsHide: true, timeout: 10000 });
  } catch {
    return;
  }

  const servers = [
    { name: 'clawbrid-cron', file: 'cron-mcp-server.js' },
    { name: 'clawbrid-video', file: 'video-mcp-server.js' },
    { name: 'clawbrid-image', file: 'image-mcp-server.js' },
  ];

  for (const srv of servers) {
    if (!existing.includes(srv.name)) {
      const srvPath = path.join(MCP_BASE, srv.file).replace(/\\/g, '/');
      try {
        console.log(`  Registering MCP: ${srv.name}...`);
        execSync(`claude mcp add --scope user ${srv.name} -- node "${srvPath}"`, { stdio: 'inherit', windowsHide: true, timeout: 15000 });
      } catch {
        console.log(`  ${srv.name} MCP 등록 실패 (수동 등록: claude mcp add --scope user ${srv.name} -- node "${srvPath}")`);
      }
    }
  }
}

// ── 실행 ──
console.log('ClawBrid postinstall...');
installOptionalTools();
registerMCPServers();
console.log('ClawBrid postinstall complete.');
