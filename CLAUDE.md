# CLAUDE.md

# 언어
- always speaking korean

# 작업 방식
- 독립적인 작업은 무조건 병렬로 처리

# ClawBrid - Claude Code Bridge

## 프로젝트 개요
Slack/Telegram을 Claude Code CLI에 연결하는 멀티채널 AI 브릿지. Tauri 데스크톱 대시보드 포함.

**기술 스택**: Node.js ≥18, Tauri 2.x (Rust), @slack/bolt, node-telegram-bot-api, node-cron, MCP SDK

## 아키텍처

```
bin/clawbrid.js (CLI 엔트리)
├── src/bridges/           # 메시징 브릿지 (PM2로 실행)
│   ├── slack.js           # Slack Socket Mode (25KB)
│   ├── telegram.js        # Telegram Bot API (28KB)
│   ├── slack-standalone.js
│   └── telegram-standalone.js
├── src/core/              # 핵심 모듈
│   ├── claude-runner.js   # Claude CLI 실행, 프롬프트 빌드
│   ├── config.js          # ~/.clawbrid/config.json 관리
│   ├── cron-manager.js    # node-cron 스케줄러
│   ├── knowledge-graph.js # Knowledge Graph 캐싱 (500노드/1000엣지)
│   ├── memory-manager.js  # JSON 키워드 기반 장기 메모리
│   ├── plugin-manager.js  # ~/.clawbrid/plugins/ JS 플러그인
│   ├── status-reporter.js # 프로세스 상태 모니터링
│   ├── video-analyzer.js  # yt-dlp + ffmpeg + whisper 영상 분석
│   ├── image-generator.js # diffusers 기반 이미지 생성/합성 (sd-worker.py 관리)
│   ├── sd-worker.py       # Python Stable Diffusion 워커 (모델 상주)
│   ├── voice-transcriber.js # faster-whisper STT (Python)
│   └── web-tools.js       # DuckDuckGo 검색, URL 브라우징
├── src/mcp/
│   ├── cron-mcp-server.js  # Claude CLI용 MCP 크론 서버
│   ├── video-mcp-server.js # Claude CLI용 MCP 영상 분석 서버
│   └── image-mcp-server.js # Claude CLI용 MCP 이미지 생성 서버
├── src/monitor/           # Tauri 대시보드 프론트엔드
│   ├── index.html         # 메인 대시보드 UI (32KB)
│   ├── setup.html         # 설정 마법사 (14KB)
│   └── tauri-bridge.js    # Tauri IPC 브릿지
└── src-tauri/             # Tauri Rust 백엔드
    └── src/lib.rs         # PM2 관리, 로그, 설정, 트레이
```

## 듀얼 레포 구조

| 레포 | 경로 | GitHub | 용도 |
|------|------|--------|------|
| **소스 (개발)** | `C:\ClawBrid` | `lee775/clawbrid` | 개발용, .git 있음 |
| **릴리즈 (배포)** | `C:\clawbrid-release` | `lee775/clawbrid-release` | 일반 사용자용, bin 난독화 |

**npm 글로벌 심링크**: `C:\Users\pc_09\AppData\Local\nvm\v24.13.0\node_modules\clawbrid` → `C:\ClawBrid`

## 릴리즈 빌드 프로세스

```
1. C:\ClawBrid에서 개발 완료
2. Tauri 모니터 빌드: src-tauri/target/release/clawbrid-monitor.exe
3. GitHub Releases에 exe 업로드 (v1.0.0-tauri 태그)
4. bin/clawbrid.js 난독화
5. C:\clawbrid-release에 복사 (src/, bin/, package.json, CHANGELOG.md, README.md)
6. clawbrid-release 레포에 push
7. 사용자 설치: npm install -g lee775/clawbrid-release
```

**빌드 명령어**:
```bash
# Tauri 모니터 빌드
cd src-tauri
cargo tauri build

# 릴리즈 레포로 동기화 (수동)
# bin/, src/, package.json, CHANGELOG.md, README.md를 C:\clawbrid-release\로 복사
```

## CLI 명령어

```bash
clawbrid dashboard      # Tauri 모니터 실행
clawbrid setup          # 설정 마법사
clawbrid start [slack|telegram]   # PM2 브릿지 시작
clawbrid stop [slack|telegram]    # PM2 브릿지 중지
clawbrid restart [slack|telegram] # PM2 브릿지 재시작
clawbrid status         # PM2 프로세스 상태
clawbrid logs [slack|telegram]    # 최근 로그
clawbrid config         # 현재 설정 출력
clawbrid update         # 업데이트 (개발자: git pull + 재링크, 일반: npm install)
clawbrid version        # 버전 출력
```

## update 로직 (중요)

`clawbrid update`는 `.git` 폴더 존재 여부로 개발자/일반 사용자를 판별:
- **개발자** (.git 있음): `git pull` → `npm install -g "C:\ClawBrid" --force` (심링크 유지)
- **일반 사용자** (.git 없음): `npm install -g lee775/clawbrid-release --force`

**주의**: 개발자 환경에서 `npm install -g lee775/clawbrid-release`를 직접 실행하면 심링크가 깨져서 MODULE_NOT_FOUND 발생. 반드시 `clawbrid update` 또는 `npm install -g C:\ClawBrid --force` 사용.

## 브릿지 명령어 (Slack: `!`, Telegram: `/`)

| 명령어 | 설명 |
|--------|------|
| `start/stop` | Claude 세션 시작/종료 |
| `search [query]` | DuckDuckGo 웹 검색 |
| `browse [URL] [질문]` | 웹페이지 읽기, 질문 시 Claude 분석 |
| `youtube [URL] [질문]` | 영상 분석 (프레임 캡처 + 음성 변환 → Claude) |
| `image [프롬프트]` | AI 이미지 생성 (로컬 Stable Diffusion) |
| `ultraplan [주제]` | 심층 분석 + 구조화된 실행 계획 |
| `graph stats/add/link/find/del/list` | Knowledge Graph 관리 |
| `memory save/search/list/del` | 장기 메모리 관리 |
| `voice on/off` | 음성 인식 토글 |
| `plugin list/reload/toggle` | 플러그인 관리 |
| `cron add/list/del/toggle/run` | 크론 작업 관리 |
| `system [prompt]` | 시스템 프롬프트 설정 |
| `adduser/removeuser` | 사용자 권한 관리 (관리자 전용) |

## 설정 파일 위치

| 파일 | 경로 |
|------|------|
| 설정 | `~/.clawbrid/config.json` |
| 세션 | `~/.clawbrid/sessions.json` |
| 대화 기록 | `~/.clawbrid/history/<channel>_<id>/<YYYY-MM-DD>.md` |
| 메모리 | `~/.clawbrid/memory.json` |
| Knowledge Graph | `~/.clawbrid/knowledge-graph.json` |
| 크론 작업 | `~/.clawbrid/cron-tasks.json` |
| 플러그인 | `~/.clawbrid/plugins/*.js` |
| 모니터 exe | `~/.clawbrid/clawbrid-monitor.exe` |

## 의존성 (package.json)

```json
{
  "@modelcontextprotocol/sdk": "^1.29.0",
  "@slack/bolt": "^4.1.0",
  "dotenv": "^16.4.0",
  "node-cron": "^4.2.1",
  "node-telegram-bot-api": "^0.66.0"
}
```

**선택적**: Python faster-whisper (음성 인식), yt-dlp + ffmpeg (영상 분석), PM2 (프로세스 관리)

## 포트/프로토콜

- Slack: Socket Mode (WebSocket, 포트 불필요)
- Telegram: Bot API polling (HTTPS)
- Tauri 대시보드: 로컬 WebView (네트워크 포트 없음)
- MCP: stdio (Claude CLI와 직접 통신)

## 개발 시 주의사항

1. **심링크 보호**: `npm install -g <remote>` 하면 로컬 심링크 깨짐. 항상 `npm install -g C:\ClawBrid --force` 사용
2. **nvm4w 경로**: `C:\nvm4w\nodejs` → `C:\Users\pc_09\AppData\Local\nvm\v24.13.0` 심링크
3. **Knowledge Graph I/O**: `_addNodeToGraph`/`_addEdgeToGraph`로 배치 처리 후 1회 save (다중 save 금지)
4. **browse 명령어 제어흐름**: `browsePassthrough` 변수로 질문 있을 때 Claude 호출로 분기
5. **Slack text 변수**: `let text` (not `const`) — browse passthrough에서 재할당 필요
6. **DuckDuckGo 파싱**: `class="result results_links"` 기준으로 split
7. **httpGet 리다이렉트**: MAX_REDIRECTS=5, `rejectUnauthorized: false`
