#!/usr/bin/env node
/**
 * ClawBrid Image MCP Server
 * 사용자가 이미지 생성(그려줘, draw 등)을 요청하면 Claude가 이 도구를 자동 호출한다.
 * 내부적으로 codex exec --skip-git-repo-check로 이미지를 만들고 ~/.clawbrid/temp/images/에 저장.
 * 브릿지는 세션 완료 후 해당 폴더를 스냅샷 비교하여 새 파일을 Slack/Telegram으로 전송한다.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const path = require('path');
const imageCodex = require('../core/image-codex');

const server = new Server(
  { name: 'clawbrid-image', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'image_generate',
      description: `사용자가 이미지/그림/사진 생성·편집·수정을 요청할 때 호출하세요. Codex CLI로 PNG 이미지를 생성/편집하고 ClawBrid 브릿지가 자동으로 Slack/Telegram에 업로드합니다.

[신규 생성] 예: "강아지 그려줘", "draw a cat" → prompt만 전달.

[이미지 편집] 사용자가 이미지를 첨부하고 (메시지에 "[첨부 이미지: /path/to/file]" 포함) 수정/편집/변형/스타일변경/배경변경/합성 등을 요청하면 source_image에 해당 경로를 전달하세요. 예: "이 사진 수채화 스타일로", "배경을 바다로 바꿔줘", "모자를 씌워줘".

[단순 분석] 첨부 이미지에 대해 "뭐야?", "설명해줘", "뭐가 보여?" 등 분석/설명만 요청하면 이 도구를 호출하지 말고 이미지 내용을 직접 설명해주세요.

호출 후에는 간단히 "이미지를 생성/편집해서 전송했습니다" 정도로만 답변하세요.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '상세한 영어 이미지 생성/편집 프롬프트 (40-80 단어 권장). 사용자 요청을 분석해 style, lighting, composition, color palette, quality hints (예: cinematic, 4k, intricate details)를 포함한 영문 프롬프트를 직접 구성해서 전달하세요. 편집 모드면 원본에서 어떻게 바꿀지 명확히 기술(예: "transform this photo into a watercolor painting, preserve composition, soft pastel colors, visible brush strokes"). 한국어 원문을 그대로 넣지 말고 Codex가 바로 사용할 수 있는 상세 영어 프롬프트로 작성해주세요.',
          },
          source_image: {
            type: 'string',
            description: '(선택) 편집할 원본 이미지의 절대 경로. 사용자가 첨부한 이미지를 수정/편집/변형하려는 의도일 때만 전달하세요. 단순 신규 생성 요청이면 생략.',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'image_check',
      description: 'Codex CLI 설치 상태와 이미지 생성 가능 여부를 확인합니다.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'image_generate': {
        if (!imageCodex.isCodexReady()) {
          return { content: [{ type: 'text', text: '❌ Codex CLI가 설치되지 않았습니다. 사용자에게 Codex CLI 설치가 필요함을 안내하세요.' }] };
        }
        const prompt = args?.prompt;
        const sourceImage = args?.source_image || null;
        if (!prompt) {
          return { content: [{ type: 'text', text: 'prompt 파라미터가 필요합니다.' }] };
        }
        if (sourceImage) {
          const fs = require('fs');
          if (!fs.existsSync(sourceImage)) {
            return { content: [{ type: 'text', text: `❌ source_image 경로를 찾을 수 없습니다: ${sourceImage}` }] };
          }
        }
        const { englishPrompt, files } = await imageCodex.generate(prompt, null, { enhance: false, sourceImage });
        const list = files.map(f => path.basename(f)).join(', ');
        const mode = sourceImage ? '편집' : '생성';
        return {
          content: [{
            type: 'text',
            text: `✅ 이미지 ${files.length}개 ${mode} 완료.\n프롬프트: ${englishPrompt}\n파일: ${list}\n\n브릿지가 메신저로 자동 전송할 예정입니다.`,
          }],
        };
      }

      case 'image_check': {
        const ready = imageCodex.isCodexReady();
        return {
          content: [{
            type: 'text',
            text: ready
              ? '✅ Codex CLI 설치됨 — image_generate 사용 가능'
              : '❌ Codex CLI 미설치. 설치 가이드: https://github.com/openai/codex',
          }],
        };
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
