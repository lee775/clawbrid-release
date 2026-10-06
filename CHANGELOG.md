# Changelog

## [1.1.0] - 2026-10-06

### Added
- **텔레그램 결과 파일 전송**: 에이전트가 만든 파일을 형식과 상관없이(문서·압축파일·이미지·영상 등) 텔레그램으로 자동 전송합니다.
  - 작업마다 전용 폴더(`~/.clawbrid/temp/outbox/<chatId>_<ts>/`)를 쓰므로, 동시에 작업한 다른 사용자에게 파일이 가지 않습니다.
  - 50MB를 넘거나 전송에 실패한 파일은 지우지 않고 PC 경로를 안내합니다.
  - 10MB를 넘는 이미지는 사진이 아닌 파일로 보냅니다.

### Changed
- **권한 통합**: 승인된 사용자는 모두 같은 권한으로 사용합니다. 비관리자 도구 제한, `/agent` 전환 제한, 쉘 크론 제한을 없앴습니다. 사용자 승인 관리(`/admin`, `/adduser`, `/removeuser`)만 관리자 전용으로 남깁니다.
- `confirmBeforeEdit` 기본값을 `false`로 바꿨습니다. 에이전트가 파일을 수정하기 전에 확인을 묻지 않습니다.

### Removed
- **Slack·Google Chat 브릿지**: 브릿지 코드, CLI 대상, 대시보드 UI·설정 마법사 단계, 크론의 Slack 전송, 관련 의존성(`@slack/bolt`, `@google-cloud/pubsub`, `google-auth-library`)을 제거했습니다.

## [1.0.4] - 2026-10-06

### Fixed
- 연속 메시지가 같은 세션으로 동시에 실행되던 경쟁 조건을 고쳤습니다.
- 시작 메시지 전송이 실패하면 처리되지 않은 예외로 프로세스가 종료되던 문제를 고쳤습니다.

## [1.0.3] - 2026-10-06

### Fixed
- 텔레그램 폴링 루프가 중복으로 돌아 메시지가 여러 번 처리되던 문제를 고쳤습니다. 라이브러리 내장 폴링을 단일 루프(`telegram-polling.js`)로 교체했습니다.

## [1.0.2] - 2026-09-08

### Fixed
- 텔레그램 429 플러드 제한에 대응합니다. 폴링 빈도를 줄이고, 텔레그램이 알려준 대기 시간(`retry_after`)을 지킵니다.

## [1.0.1] - 2026-08-28

### Fixed
- 텔레그램 폴링이 응답 없이 멈춘 상태(좀비)에서 자동 복구합니다.

## [1.0.0] - 2026-04-07

### Changed
- **Electron -> Tauri 마이그레이션**: 데스크톱 셸을 Tauri+Rust로 전환 (~12MB, Electron ~200MB 대비)
- 런타임 감지를 `tauri-bridge.js` SSOT로 통합
- PM2/npm 실행을 `cmd /C` 래퍼로 변경 (Windows .cmd 호환)
- 첫 실행 시 GitHub Releases에서 Tauri exe 자동 다운로드 (`~/.clawbrid/`)
- 바탕화면 바로가기 첫 dashboard 실행 시 자동 생성
- dashboard 중복 실행 방지 (멱등성)
- line ending LF 통일 (`.gitattributes`)
- postinstall 폐기, 첫 실행 다운로드 방식으로 전환

### Removed
- Electron 의존성 제거 (`optionalDependencies`)
- `.npmignore` 제거 (`files` 필드 단독 사용)

## [0.x] - ~2026-04-06

### Added
- 초기 ClawBrid: Slack/Telegram 브릿지, 모니터 대시보드
- 크론 작업 시스템 (node-cron 기반)
- 크론 MCP 서버 + Claude CLI 자동 등록
- 펫 시스템 (가챠, 말풍선, 파티클)
- PM2 프로세스 관리 (start/stop/restart)
- CLI 명령어: dashboard, setup, start, stop, restart, status, logs, config, update, version
