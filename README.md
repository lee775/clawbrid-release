# ClawBrid

> Claude Code Bridge - Connect Claude Code to Slack & Telegram with a real-time monitoring dashboard.

ClawBrid는 [Claude Code](https://claude.ai/code) CLI를 Slack과 Telegram 메신저에 연결하는 브릿지 서버입니다. 메신저로 메시지를 보내면 Claude Code가 작업을 수행하고 결과를 돌려줍니다.

## Features

- **Slack & Telegram Bridge** - 메신저에서 Claude Code와 실시간 대화
- **Real-time Monitor** - Tauri 기반 경량 대시보드 (~12MB)
- **Cron System** - node-cron 기반 정기 작업 스케줄링 + MCP 서버 연동
- **Pet System** - 가챠 기반 가상 펫 컴패니언
- **File Support** - 이미지, PDF, 문서 파일 첨부 시 Claude Code가 직접 읽고 분석
- **Session Persistence** - 대화 세션이 유지되어 이전 대화 맥락을 기억
- **Permission System** - Telegram 관리자/일반 사용자 권한 분리
- **Edit Confirmation** - 파일 수정/삭제 전 반드시 사용자 확인 요청
- **Auto Cleanup** - 다운로드 파일 자동 정리 (기본 7일)
- **PM2 Integration** - 각 Bridge를 독립 PM2 프로세스로 관리

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- [PM2](https://pm2.keymetrics.io/) (`npm install -g pm2`)
- Windows 10+ (Tauri 모니터는 WebView2 사용)

## Install

```bash
npm install -g lee775/clawbrid-release
```

첫 `clawbrid dashboard` 실행 시 Tauri 모니터가 GitHub Releases에서 자동 다운로드됩니다.

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

## Cron System

대시보드에서 크론 작업을 추가/관리할 수 있습니다. Claude Code MCP 서버와 연동되어 Claude가 직접 크론을 등록할 수도 있습니다.

```bash
# MCP 서버 자동 등록 (clawbrid dashboard 실행 시)
claude mcp add --scope user clawbrid-cron -- node <path>/src/mcp/cron-mcp-server.js
```

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
```

- **Tauri Monitor**: 대시보드 UI, 펫 윈도우, 트레이 아이콘
- **Bridge 프로세스**: PM2로 독립 관리, 모니터 없이도 동작
- **Cron Worker**: 스케줄 작업 실행, MCP 서버 제공

## License

MIT
