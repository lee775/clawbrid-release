# CLAUDE.md

# 언어
- always speaking korean

# 작업 방식
- 독립적인 작업은 무조건 병렬로 처리

# ClawBrid - Claude Code Bridge

## 프로젝트 개요
Telegram을 Claude Code CLI / Codex CLI에 연결하는 AI 브릿지. Tauri 데스크톱 대시보드 포함. (Slack·Google Chat 브릿지는 v1.1.0에서 제거)

**기술 스택**: Node.js ≥18, Tauri 2.x (Rust), node-telegram-bot-api, node-cron, MCP SDK

## 아키텍처

```
bin/clawbrid.js (CLI 엔트리)
├── src/bridges/           # 메시징 브릿지 (PM2로 실행)
│   ├── telegram.js        # Telegram Bot API
│   └── telegram-standalone.js
├── src/core/              # 핵심 모듈
│   ├── agent-router.js    # claude/codex 선택, 세션 관리, 결과 파일 전송 규칙 주입
│   ├── claude-runner.js   # Claude CLI 실행, 프롬프트 빌드
│   ├── codex-runner.js    # Codex CLI 실행
│   ├── config.js          # ~/.clawbrid/config.json 관리
│   ├── cron-manager.js    # node-cron 스케줄러
│   ├── knowledge-graph.js # Knowledge Graph 캐싱 (500노드/1000엣지)
│   ├── memory-manager.js  # JSON 키워드 기반 장기 메모리
│   ├── plugin-manager.js  # ~/.clawbrid/plugins/ JS 플러그인
│   ├── status-reporter.js # 프로세스 상태 모니터링
│   ├── telegram-polling.js # getUpdates 단일 폴링 루프 (라이브러리 내장 폴링 사용 금지)
│   ├── video-analyzer.js  # yt-dlp + ffmpeg + whisper 영상 분석
│   ├── voice-transcriber.js # faster-whisper STT (Python)
│   └── web-tools.js       # DuckDuckGo 검색, URL 브라우징
├── src/mcp/
│   ├── cron-mcp-server.js  # Claude CLI용 MCP 크론 서버
│   └── video-mcp-server.js # Claude CLI용 MCP 영상 분석 서버
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
clawbrid start [telegram|cron]   # PM2 브릿지/크론 워커 시작 (생략 시 둘 다)
clawbrid stop [telegram|cron]    # PM2 브릿지/크론 워커 중지
clawbrid restart [telegram|cron] # PM2 브릿지/크론 워커 재시작
clawbrid status         # PM2 프로세스 상태
clawbrid logs [telegram|cron]    # 최근 로그
clawbrid config         # 현재 설정 출력
clawbrid update         # 업데이트 (개발자: git pull + 재링크, 일반: npm install)
clawbrid version        # 버전 출력
```

## update 로직 (중요)

`clawbrid update`는 `.git` 폴더 존재 여부로 개발자/일반 사용자를 판별:
- **개발자** (.git 있음): `git pull` → `npm install -g "C:\ClawBrid" --force` (심링크 유지)
- **일반 사용자** (.git 없음): `npm install -g lee775/clawbrid-release --force`

**주의**: 개발자 환경에서 `npm install -g lee775/clawbrid-release`를 직접 실행하면 심링크가 깨져서 MODULE_NOT_FOUND 발생. 반드시 `clawbrid update` 또는 `npm install -g C:\ClawBrid --force` 사용.

## 브릿지 명령어 (Telegram: `/`)

| 명령어 | 설명 |
|--------|------|
| `start/stop` | Claude 세션 시작/종료 |
| `search [query]` | DuckDuckGo 웹 검색 |
| `browse [URL] [질문]` | 웹페이지 읽기, 질문 시 Claude 분석 |
| `youtube [URL] [질문]` | 영상 분석 (프레임 캡처 + 음성 변환 → Claude) |
| `ultraplan [주제]` | 심층 분석 + 구조화된 실행 계획 |
| `graph stats/add/link/find/del/list` | Knowledge Graph 관리 |
| `memory save/search/list/del` | 장기 메모리 관리 |
| `voice on/off` | 음성 인식 토글 |
| `plugin list/reload/toggle` | 플러그인 관리 |
| `cron add/list/del/toggle/run` | 크론 작업 관리 |
| `system [prompt]` | 시스템 프롬프트 설정 |
| `adduser/removeuser`, `/admin` | 사용자 승인 관리 (관리자 전용 — 승인된 사용자는 그 외 모든 기능을 동일 권한으로 사용) |

**결과 파일 전송**: 작업마다 `~/.clawbrid/temp/outbox/<chatId>_<ts>/` 폴더를 만들어 `runAgent`의 `outboxDir`로 넘기면, agent-router가 에이전트에 저장 규칙을 주입하고 작업 후 telegram.js가 그 폴더의 모든 파일을 해당 채팅으로 전송한다 (50MB 초과·실패 파일은 보존 + 경로 안내).

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
  "dotenv": "^16.4.0",
  "node-cron": "^4.2.1",
  "node-telegram-bot-api": "^0.66.0",
  "telegram": "^2.26.22"
}
```

**선택적**: Python faster-whisper (음성 인식), yt-dlp + ffmpeg (영상 분석), PM2 (프로세스 관리)

## 포트/프로토콜

- Telegram: Bot API polling (HTTPS)
- Tauri 대시보드: 로컬 WebView (네트워크 포트 없음)
- MCP: stdio (Claude CLI와 직접 통신)

## 개발 시 주의사항

1. **심링크 보호**: `npm install -g <remote>` 하면 로컬 심링크 깨짐. 항상 `npm install -g C:\ClawBrid --force` 사용
2. **nvm4w 경로**: `C:\nvm4w\nodejs` → `C:\Users\pc_09\AppData\Local\nvm\v24.13.0` 심링크
3. **Knowledge Graph I/O**: `_addNodeToGraph`/`_addEdgeToGraph`로 배치 처리 후 1회 save (다중 save 금지)
4. **browse 명령어 제어흐름**: `browsePassthrough` 변수로 질문 있을 때 Claude 호출로 분기
5. **text 변수**: `let text` (not `const`) — browse passthrough에서 재할당 필요
6. **DuckDuckGo 파싱**: `class="result results_links"` 기준으로 split
7. **httpGet 리다이렉트**: MAX_REDIRECTS=5, `rejectUnauthorized: false`
