/**
 * 긴 사용자 질문(≥100자)을 구조화된 마크다운으로 재정리.
 * Claude 1턴 호출로 ## 맥락 / ## 요청 / ## 제약사항 / ## 완료 기준 형식으로 변환.
 * 실패·타임아웃 시 원본 텍스트를 그대로 반환한다.
 */
const { spawn } = require('child_process');

const STRUCTURE_THRESHOLD = 100;
const MAX_LENGTH = 5000; // 이상이면 이미 임베디드 데이터(웹페이지/영상 transcript) 포함 가능성 → 패스

function shouldStructure(text) {
  if (!text) return false;
  if (text.length < STRUCTURE_THRESHOLD) return false;
  if (text.length > MAX_LENGTH) return false;
  // 이미 마크다운 헤더 있으면(ultraplan·사전 구조화·웹페이지 본문 등) 패스
  if (text.includes('## ')) return false;
  // /browse 패스스루처럼 외부 데이터 임베디드된 프롬프트는 패스
  if (/--- (웹페이지|페이지 끝|첨부파일|첨부 이미지) ---/.test(text)) return false;
  return true;
}

function structurePrompt(text) {
  return new Promise((resolve) => {
    const instruction = `다음 사용자 질문을 아래 마크다운 구조로 정리해주세요.

규칙:
- 사용자가 명시한 정보만 옮기세요. 추측·창작·내용 추가 절대 금지.
- 사용자가 언급하지 않은 섹션은 "(명시 없음)"으로 두세요.
- "## 엣지케이스", "## 참고" 섹션은 사용자가 관련 정보를 실제로 언급한 경우에만 추가하세요.
- 정리된 마크다운만 출력하고, 도입부·결론·코멘트·\`\`\` 코드블록 펜스 절대 붙이지 마세요.

## 맥락
- 어디에 쓰일지, 무슨 데이터, 규모, 관련 파일/시스템

## 요청
- 실제 작업 내용

## 제약사항
- 반드시 지켜야 할 기술적 제약, 건드리면 안 되는 영역

## 완료 기준
- 완료 판단 기준, 검증 방법

---

사용자 질문:
${text}`;

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
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve(text); // 타임아웃: 원본 사용
    }, 60000);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        const md = (parsed.result || '').trim();
        // 신뢰 검증: 최소한 ## 맥락 + ## 요청 헤더가 있어야 채택
        if (md && md.includes('## 맥락') && md.includes('## 요청')) return resolve(md);
      } catch {}
      resolve(text);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(text); });

    try {
      proc.stdin.write(instruction);
      proc.stdin.end();
    } catch {}
  });
}

module.exports = { shouldStructure, structurePrompt, STRUCTURE_THRESHOLD };
