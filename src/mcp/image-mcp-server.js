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
      description: '사용자가 이미지/그림/사진 생성을 요청할 때 반드시 이 도구를 호출하세요. 예: "강아지 그려줘", "바다 사진 만들어줘", "draw a cat", "generate an image of ...". 한국어/영어 프롬프트를 받아 내부적으로 영어 상세 프롬프트로 확장한 뒤 Codex CLI로 PNG 이미지를 생성합니다. 생성된 파일은 ClawBrid 브릿지가 자동으로 Slack/Telegram에 업로드하므로, 당신은 이 도구를 호출하는 것만으로 충분합니다. 호출 후에는 간단히 "이미지를 생성해서 전송했습니다" 정도로 답변하세요.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '이미지 생성 요청 (한국어 또는 영어). 사용자 원문 그대로 넣거나, 사용자 의도를 요약한 문장을 넣으세요. 내부에서 자동으로 영어 상세 프롬프트로 확장됩니다.',
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
        if (!prompt) {
          return { content: [{ type: 'text', text: 'prompt 파라미터가 필요합니다.' }] };
        }
        const { englishPrompt, files } = await imageCodex.generate(prompt, null);
        const list = files.map(f => path.basename(f)).join(', ');
        return {
          content: [{
            type: 'text',
            text: `✅ 이미지 ${files.length}개 생성 완료.\n영문 프롬프트: ${englishPrompt}\n파일: ${list}\n\n브릿지가 메신저로 자동 전송할 예정입니다.`,
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
