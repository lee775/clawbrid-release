#!/usr/bin/env node
/**
 * ClawBrid Video MCP Server
 * Claude Code에서 영상 URL을 분석할 때 자동으로 호출됨
 * yt-dlp + ffmpeg + faster-whisper로 영상 다운로드/프레임 캡처/음성 변환
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const fs = require('fs');
const path = require('path');
const videoAnalyzer = require('../core/video-analyzer');

const server = new Server(
  { name: 'clawbrid-video', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'video_analyze',
      description: '영상 URL(YouTube 등)을 분석합니다. 영상을 다운로드하고 프레임 캡처 + 음성 텍스트 변환을 수행하여 시각적/청각적 내용을 종합 분석할 수 있는 데이터를 반환합니다. 사용자가 영상 링크를 보내거나 영상 내용 분석을 요청할 때 사용하세요.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '분석할 영상 URL (YouTube, Vimeo 등)' },
          question: { type: 'string', description: '영상에 대한 구체적 질문 (선택). 없으면 전체 내용 분석' },
          max_frames: { type: 'number', description: '최대 프레임 수 (기본: 15, 최대: 20)', default: 15 },
        },
        required: ['url'],
      },
    },
    {
      name: 'video_info',
      description: '영상 URL의 메타데이터(제목, 길이, 채널 등)만 빠르게 조회합니다. 전체 분석이 필요 없고 영상 정보만 확인할 때 사용하세요.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '조회할 영상 URL' },
        },
        required: ['url'],
      },
    },
    {
      name: 'video_check_tools',
      description: '영상 분석에 필요한 도구(yt-dlp, ffmpeg, faster-whisper) 설치 상태를 확인합니다.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'video_analyze': {
        const url = args.url;
        if (!url) return { content: [{ type: 'text', text: 'URL이 필요합니다.' }] };

        // 도구 체크
        const missing = videoAnalyzer.checkTools();
        if (missing.length) {
          return { content: [{ type: 'text', text: `필요한 도구가 없습니다: ${missing.join(', ')}\n설치: pip install yt-dlp && winget install ffmpeg` }] };
        }

        // 분석 실행
        const result = await videoAnalyzer.analyzeVideo(url, args.question || '', () => {});

        // 프레임 이미지를 base64로 변환하여 MCP 응답에 포함
        const content = [];

        // 1. 텍스트 정보 (메타데이터 + 자막)
        content.push({ type: 'text', text: result.prompt });

        // 2. 프레임 이미지들 (base64)
        const maxFrames = Math.min(args.max_frames || 15, 20);
        const framesToSend = result.framePaths.slice(0, maxFrames);

        for (let i = 0; i < framesToSend.length; i++) {
          const framePath = framesToSend[i];
          try {
            const imgData = fs.readFileSync(framePath);
            const base64 = imgData.toString('base64');
            const timeSec = i * 15; // approximate
            const mm = String(Math.floor(timeSec / 60)).padStart(2, '0');
            const ss = String(timeSec % 60).padStart(2, '0');
            content.push({
              type: 'image',
              data: base64,
              mimeType: 'image/jpeg',
            });
          } catch {}
        }

        // 정리 예약 (5분 후)
        setTimeout(() => videoAnalyzer.cleanup(result.tempDir), 300000);

        return { content };
      }

      case 'video_info': {
        const url = args.url;
        if (!url) return { content: [{ type: 'text', text: 'URL이 필요합니다.' }] };

        const missing = videoAnalyzer.checkTools();
        if (missing.length) {
          return { content: [{ type: 'text', text: `yt-dlp가 필요합니다: pip install yt-dlp` }] };
        }

        // getVideoInfo는 내부 함수이므로 직접 호출
        const { execSync } = require('child_process');
        const raw = execSync(`yt-dlp --dump-json --no-download "${url}"`, {
          windowsHide: true,
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        });
        const info = JSON.parse(raw);

        const duration = info.duration || 0;
        const h = Math.floor(duration / 3600);
        const m = Math.floor((duration % 3600) / 60);
        const s = Math.floor(duration % 60);
        const durationStr = h > 0 ? `${h}시간 ${m}분 ${s}초` : m > 0 ? `${m}분 ${s}초` : `${s}초`;

        const text = [
          `제목: ${info.title || '알 수 없음'}`,
          `채널: ${info.uploader || info.channel || '알 수 없음'}`,
          `길이: ${durationStr}`,
          `조회수: ${info.view_count ? info.view_count.toLocaleString() : '알 수 없음'}`,
          `업로드: ${info.upload_date ? `${info.upload_date.slice(0,4)}-${info.upload_date.slice(4,6)}-${info.upload_date.slice(6,8)}` : '알 수 없음'}`,
          `설명: ${(info.description || '').slice(0, 500)}`,
          info.categories?.length ? `카테고리: ${info.categories.join(', ')}` : '',
          info.tags?.length ? `태그: ${info.tags.slice(0, 10).join(', ')}` : '',
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text }] };
      }

      case 'video_check_tools': {
        const missing = videoAnalyzer.checkTools();

        // faster-whisper 체크
        let whisperOk = false;
        try {
          const { execSync } = require('child_process');
          execSync('python -c "import faster_whisper"', { windowsHide: true, timeout: 5000, stdio: 'pipe' });
          whisperOk = true;
        } catch {}

        const status = [
          `yt-dlp: ${missing.includes('yt-dlp') ? '미설치 (pip install yt-dlp)' : '설치됨'}`,
          `ffmpeg: ${missing.includes('ffmpeg') ? '미설치 (winget install ffmpeg)' : '설치됨'}`,
          `faster-whisper: ${whisperOk ? '설치됨' : '미설치 (pip install faster-whisper)'}`,
          '',
          missing.length || !whisperOk
            ? '일부 도구가 없습니다. 위 명령어로 설치해주세요.'
            : '모든 도구가 준비되었습니다. video_analyze를 사용할 수 있습니다.',
        ].join('\n');

        return { content: [{ type: 'text', text: status }] };
      }

      default:
        return { content: [{ type: 'text', text: `알 수 없는 도구: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `에러: ${err.message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
