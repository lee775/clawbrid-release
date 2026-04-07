# Changelog

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
