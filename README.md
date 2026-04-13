# ClawBrid

> Claude Code Bridge - Connect Claude Code to Slack & Telegram with a real-time monitoring dashboard.

ClawBrid는 [Claude Code](https://claude.ai/code) CLI를 Slack과 Telegram 메신저에 연결하는 브릿지 서버입니다. 메신저로 메시지를 보내면 Claude Code가 작업을 수행하고 결과를 돌려줍니다.

## Features

- **Slack & Telegram Bridge** - 메신저에서 Claude Code와 실시간 대화
- **Real-time Monitor** - Tauri 기반 경량 대시보드 (~12MB), Deep Space Neon 테마
- **Video Analysis** - YouTube/영상 URL 분석 (프레임 캡처 + 음성 변환 → AI 종합 분석)
- **Image Generation** - 로컬 Stable Diffusion (diffusers) 이미지 생성/합성/업스케일 (자동 설치)
- **MCP Servers** - Claude Code와 직접 연동되는 크론/영상 분석/이미지 생성 MCP 서버
- **Cron System** - node-cron 기반 정기 작업 스케줄링
- **UltraPlan** - 심층 분석 + 구조화된 실행 계획 생성
- **Web Tools** - DuckDuckGo 웹 검색, 웹페이지 브라우징 + Claude 분석
- **Knowledge Graph** - 지식 그래프 기반 컨텍스트 관리 (500노드/1000엣지)
- **Long-term Memory** - JSON 키워드 기반 장기 메모리 시스템
- **Voice Recognition** - faster-whisper 기반 음성 메시지 → 텍스트 자동 변환
- **File Support** - 이미지, PDF, 문서 파일 첨부 시 Claude Code가 직접 읽고 분석
- **Session Persistence** - 대화 세션이 유지되어 이전 대화 맥락을 기억
- **Plugin System** - `~/.clawbrid/plugins/` JS 플러그인으로 기능 확장
- **Permission System** - Telegram 관리자/일반 사용자 권한 분리
- **Edit Confirmation** - 파일 수정/삭제 전 반드시 사용자 확인 요청
- **PM2 Integration** - 각 Bridge를 독립 PM2 프로세스로 관리

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- [PM2](https://pm2.keymetrics.io/) (`npm install -g pm2`)
- Windows 10+ (Tauri 모니터는 WebView2 사용)

### Optional (자동 설치)

- **Python** + `faster-whisper` - 음성 인식 (postinstall에서 자동 설치)
- **yt-dlp** - 영상 다운로드 (postinstall에서 자동 설치)
- **ffmpeg** - 영상 프레임 추출 (`winget install ffmpeg`)
- **diffusers** + **torch** - AI 이미지 생성 (postinstall에서 자동 설치, GPU 권장)

## Install

```bash
npm install -g lee775/clawbrid-release
```

첫 `clawbrid dashboard` 실행 시:
- Tauri 모니터가 GitHub Releases에서 자동 다운로드됩니다
- MCP 서버(크론, 영상 분석)가 Claude Code에 자동 등록됩니다

## Usage

```bash
clawbrid                # 첫 실행: 설정 UI / 이후: 대시보드
clawbrid dashboard      # 모니터 대시보드 열기
clawbrid setup          # 설정 다시 하기
clawbrid update         # 최신 버전으로 업데이트
```

### CLI Commands

| 명령 | 설명 |
|------|------|
| `clawbrid dashboard` | 모니터 대시보드 |
| `clawbrid setup` | 설정 마법사 |
| `clawbrid start [slack\|telegram]` | 브릿지 시작 |
| `clawbrid stop [slack\|telegram]` | 브릿지 중지 |
| `clawbrid restart [slack\|telegram]` | 브릿지 재시작 |
| `clawbrid status` | PM2 프로세스 상태 |
| `clawbrid logs [slack\|telegram]` | 로그 확인 |
| `clawbrid config` | 현재 설정 보기 |
| `clawbrid update` | 업데이트 |
| `clawbrid version` | 버전 확인 |

### Bridge Commands (Slack: `!`, Telegram: `/`)

| 명령어 | 설명 |
|--------|------|
| `stop` | Claude 작업 중단 |
| `reset` | 세션 초기화 |
| `search [검색어]` | DuckDuckGo 웹 검색 |
| `browse [URL] [질문]` | 웹페이지 읽기, 질문 시 Claude 분석 |
| `youtube [URL] [질문]` | 영상 분석 (프레임 캡처 + 음성 변환 → Claude 종합 분석) |
| `image [프롬프트]` | AI 이미지 생성 (로컬 Stable Diffusion) |
| `ultraplan [주제]` | 심층 분석 + 구조화된 실행 계획 |
| `graph stats\|add\|link\|find\|del\|list` | Knowledge Graph 관리 |
| `memory list\|add\|del\|search` | 장기 메모리 관리 |
| `voice on\|off` | 음성 인식 토글 |
| `plugin list\|reload\|toggle` | 플러그인 관리 |
| `cron add\|list\|del\|toggle\|run` | 크론 작업 관리 |
| `system [prompt]` | 시스템 프롬프트 설정 |
| `adduser\|removeuser` | 사용자 권한 관리 (관리자 전용) |

## Video Analysis

YouTube나 영상 URL을 보내면 자동으로 다운로드 → 프레임 캡처 → 음성 텍스트 변환 → Claude 종합 분석을 수행합니다.

```
# 메신저에서
!youtube https://youtube.com/watch?v=xxx 핵심 내용 요약해줘
/youtube https://youtu.be/xxx 이 영상의 기술 스택 분석해줘

# Claude Code에서 (MCP 자동 호출)
"이 영상 분석해줘: https://youtube.com/watch?v=xxx"
```

**동작 과정:**
1. `yt-dlp` - 영상 다운로드 (720p 이하)
2. `ffmpeg` - 프레임 캡처 (15초 간격, 최대 20장, 자동 간격 조정)
3. `faster-whisper` - 음성 → 타임스탬프 텍스트 변환
4. Claude에 프레임 이미지 + 음성 텍스트 전달 → 시각+청각 종합 분석

## MCP Servers

ClawBrid는 3개의 MCP 서버를 제공합니다. `clawbrid dashboard` 실행 시 자동 등록됩니다.

### clawbrid-cron
Claude Code에서 자연어로 크론 작업을 관리할 수 있습니다.

```
"매일 아침 9시에 서버 상태 체크해줘" → Claude가 cron_add 도구로 자동 등록
```

| 도구 | 설명 |
|------|------|
| `cron_list` | 등록된 크론 작업 목록 |
| `cron_add` | 크론 작업 등록 |
| `cron_remove` | 크론 작업 삭제 |
| `cron_toggle` | 활성화/비활성화 |
| `cron_run` | 즉시 실행 |

### clawbrid-video
Claude Code에서 영상 분석이 필요할 때 자동으로 호출됩니다.

```
"이 YouTube 영상 분석해줘: https://..." → Claude가 video_analyze 도구로 자동 분석
```

| 도구 | 설명 |
|------|------|
| `video_analyze` | 영상 다운로드 + 프레임 캡처 + 음성 변환 → 이미지/텍스트 반환 |
| `video_info` | 영상 메타데이터만 빠르게 조회 (제목, 길이, 채널 등) |
| `video_check_tools` | 필요 도구(yt-dlp, ffmpeg, whisper) 설치 상태 확인 |

### clawbrid-image
Claude Code에서 이미지 생성/합성이 필요할 때 자동으로 호출됩니다. diffusers + torch 기반 (자동 설치).

```
"고양이가 우주에 떠있는 그림 그려줘" → Claude가 image_generate 도구로 자동 생성
"이 이미지를 애니메이션 스타일로 바꿔줘" → Claude가 image_edit 도구로 합성
```

| 도구 | 설명 |
|------|------|
| `image_generate` | 텍스트→이미지 생성 (txt2img) |
| `image_edit` | 이미지 기반 수정/합성 (img2img) |
| `image_upscale` | 이미지 고해상도 업스케일 |
| `image_status` | 환경 상태 확인 (GPU/CPU, 모델 로드) |

**참고**: 최초 실행 시 SD 모델(~4GB) 자동 다운로드. GPU(NVIDIA CUDA) 있으면 수초, CPU만 있으면 수분 소요.

### 수동 MCP 등록

```bash
claude mcp add --scope user clawbrid-cron -- node <path>/src/mcp/cron-mcp-server.js
claude mcp add --scope user clawbrid-video -- node <path>/src/mcp/video-mcp-server.js
claude mcp add --scope user clawbrid-image -- node <path>/src/mcp/image-mcp-server.js
```

## Slack Setup

1. [api.slack.com/apps](https://api.slack.com/apps)에서 앱 생성
2. **Socket Mode** 활성화 → App-Level Token 생성
3. **OAuth & Permissions** → Bot Token Scopes 추가:
   - `chat:write`, `files:read`, `app_mentions:read`
   - `im:history`, `im:read`, `im:write`
4. **Event Subscriptions** → Bot Events 추가:
   - `message.im`, `app_mention`
5. 앱 설치 후 Bot Token, Signing Secret, App Token을 ClawBrid에 입력

## Telegram Setup

1. [@BotFather](https://t.me/BotFather)에게 `/newbot` 명령으로 봇 생성
2. 받은 Bot Token을 ClawBrid에 입력
3. 관리자 User ID 입력 ([@userinfobot](https://t.me/userinfobot)으로 확인)

## Configuration

설정 파일: `~/.clawbrid/config.json`

```json
{
  "claude": {
    "workDir": "C:/",
    "addDirs": ["C:/", "D:/"],
    "maxTurns": 50,
    "timeout": 600000,
    "confirmBeforeEdit": true
  },
  "slack": { "enabled": true, "botToken": "xoxb-...", "appToken": "xapp-..." },
  "telegram": { "enabled": true, "botToken": "123:ABC...", "adminUser": "12345" }
}
```

## Architecture

```
clawbrid dashboard → Tauri Monitor (Rust + WebView2)
                      ├── PM2: clawbrid-slack     (Node.js)
                      ├── PM2: clawbrid-telegram   (Node.js)
                      └── PM2: clawbrid-cron       (Node.js)

Claude Code CLI ──── MCP: clawbrid-cron   (stdio)
                ├─── MCP: clawbrid-video  (stdio)
                └─── MCP: clawbrid-image  (stdio) → diffusers/torch
```

- **Tauri Monitor**: 6탭 대시보드 (Dashboard, Chat, PM2, Cron, Logs, Settings)
- **Bridge 프로세스**: PM2로 독립 관리, 모니터 없이도 동작
- **Cron Worker**: 스케줄 작업 실행
- **MCP 서버**: Claude Code와 직접 통신 (크론 관리, 영상 분석)

## License

MIT
