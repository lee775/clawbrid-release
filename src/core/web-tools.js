/**
 * ClawBrid 웹 도구
 * - 웹 검색 (DuckDuckGo HTML 파싱)
 * - URL 브라우징 (페이지 텍스트 추출)
 */
const https = require('https');
const http = require('http');

/**
 * HTTP(S) GET 요청
 */
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        ...options.headers,
      },
      timeout: options.timeout || 15000,
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('//')) redirectUrl = 'https:' + redirectUrl;
        return httpGet(redirectUrl, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('요청 타임아웃')); });
  });
}

/**
 * HTML → 텍스트 변환 (태그 제거, 공백 정리)
 */
function htmlToText(html) {
  let text = html;
  // script, style, noscript 제거
  text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // 주요 블록 태그를 줄바꿈으로 변환
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // 모든 태그 제거
  text = text.replace(/<[^>]+>/g, '');
  // HTML 엔티티 디코딩
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // 공백 정리
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * DuckDuckGo 웹 검색
 * @returns {{ title, url, snippet }[]}
 */
async function search(query, maxResults = 5) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const { body } = await httpGet(url);

  const results = [];
  // DuckDuckGo HTML 결과 파싱 — web-result 블록 단위로 분리
  const resultBlocks = body.split(/class="result results_links/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;

    // 제목 + URL 추출 (result__a 태그)
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    // 스니펫 추출
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/);

    if (titleMatch) {
      let resultUrl = titleMatch[1];
      // DuckDuckGo 리다이렉트 URL 디코딩
      const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) resultUrl = decodeURIComponent(uddgMatch[1]);
      // //로 시작하는 URL 처리
      if (resultUrl.startsWith('//')) resultUrl = 'https:' + resultUrl;

      results.push({
        title: htmlToText(titleMatch[2]).trim(),
        url: resultUrl,
        snippet: snippetMatch ? htmlToText(snippetMatch[1]).trim() : '',
      });
    }
  }

  return results;
}

/**
 * URL 페이지 내용 가져오기
 * @returns {{ title, text, url, length }}
 */
async function browse(url) {
  if (!url.startsWith('http')) url = `https://${url}`;

  const { body, status } = await httpGet(url, { timeout: 20000 });

  if (status !== 200) {
    throw new Error(`HTTP ${status} - 페이지를 불러올 수 없습니다.`);
  }

  // 제목 추출
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? htmlToText(titleMatch[1]).trim() : '(제목 없음)';

  // 메인 콘텐츠 추출 시도 (article, main, body 순서)
  let content = '';
  const mainMatch = body.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) {
    content = htmlToText(mainMatch[2]);
  } else {
    // body 전체에서 추출
    const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = htmlToText(bodyMatch ? bodyMatch[1] : body);
  }

  // 너무 길면 잘라내기 (4000자)
  const maxLen = 4000;
  if (content.length > maxLen) {
    content = content.slice(0, maxLen) + '\n\n... (내용이 너무 길어 잘림)';
  }

  return { title, text: content, url, length: content.length };
}

/**
 * 검색 결과를 포맷된 문자열로 변환
 */
function formatSearchResults(results, query) {
  if (!results.length) return `❌ "${query}" 검색 결과가 없습니다.`;

  const lines = results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
  ).join('\n\n');

  return `🔍 "${query}" 검색 결과 (${results.length}건)\n\n${lines}`;
}

/**
 * 브라우즈 결과를 포맷된 문자열로 변환
 */
function formatBrowseResult(result) {
  return `🌐 ${result.title}\n📎 ${result.url}\n📏 ${result.length}자\n\n${result.text}`;
}

module.exports = { search, browse, formatSearchResults, formatBrowseResult, httpGet, htmlToText };
