#!/usr/bin/env node
/**
 * ClawBrid Image MCP Server
 * diffusers 기반 로컬 Stable Diffusion 이미지 생성/합성
 * Claude Code에서 이미지 관련 요청 시 자동 호출
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const imageGen = require('../core/image-generator');

const server = new Server(
  { name: 'clawbrid-image', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'image_generate',
      description: '텍스트 프롬프트로 이미지를 생성합니다 (Stable Diffusion txt2img). 사용자가 이미지 생성, 그림 그리기, 일러스트 제작 등을 요청할 때 사용하세요. 영어 프롬프트가 품질이 좋습니다. 최초 실행 시 모델 다운로드(~4GB)로 시간이 걸릴 수 있습니다.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '이미지 생성 프롬프트 (영어 권장). 예: "a beautiful sunset over mountains, digital art, 4k, detailed"',
          },
          negative_prompt: {
            type: 'string',
            description: '제외할 요소. 기본값: "(worst quality, low quality:1.4), blurry, watermark, text"',
          },
          width: { type: 'number', description: '이미지 너비 (기본 512). 64의 배수 권장', default: 512 },
          height: { type: 'number', description: '이미지 높이 (기본 512). 64의 배수 권장', default: 512 },
          steps: { type: 'number', description: '생성 단계 수 (기본 20, 높을수록 품질↑ 속도↓)', default: 20 },
          cfg_scale: { type: 'number', description: '프롬프트 충실도 (기본 7)', default: 7 },
          seed: { type: 'number', description: '시드값 (-1=랜덤)', default: -1 },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'image_edit',
      description: '기존 이미지를 기반으로 수정/합성합니다 (Stable Diffusion img2img). 이미지 스타일 변경, 합성, 편집 등에 사용하세요. denoising_strength가 높을수록 원본에서 많이 변형됩니다.',
      inputSchema: {
        type: 'object',
        properties: {
          image_path: {
            type: 'string',
            description: '수정할 원본 이미지 파일 경로 (절대 경로)',
          },
          prompt: {
            type: 'string',
            description: '수정/합성 프롬프트. 예: "convert to anime style", "add snow effect"',
          },
          negative_prompt: { type: 'string', description: '제외할 요소' },
          denoising_strength: {
            type: 'number',
            description: '변형 강도 (0.0~1.0, 기본 0.75). 낮으면 원본 유지, 높으면 많이 변형',
            default: 0.75,
          },
          width: { type: 'number', description: '출력 너비 (기본 512)', default: 512 },
          height: { type: 'number', description: '출력 높이 (기본 512)', default: 512 },
          steps: { type: 'number', description: '생성 단계 수 (기본 20)', default: 20 },
          cfg_scale: { type: 'number', description: '프롬프트 충실도 (기본 7)', default: 7 },
        },
        required: ['image_path', 'prompt'],
      },
    },
    {
      name: 'image_upscale',
      description: '이미지를 고해상도로 업스케일합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          image_path: {
            type: 'string',
            description: '업스케일할 이미지 파일 경로 (절대 경로)',
          },
          scale: {
            type: 'number',
            description: '확대 배율 (기본 2, 최대 4)',
            default: 2,
          },
        },
        required: ['image_path'],
      },
    },
    {
      name: 'image_status',
      description: '이미지 생성 환경 상태를 확인합니다 (GPU/CPU, 패키지 설치 여부, 모델 로드 상태). 이미지 생성 전 환경을 확인할 때 사용하세요.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // 도구 설치 확인 (status 제외)
    if (name !== 'image_status') {
      const missing = imageGen.checkTools();
      if (missing.length) {
        return {
          content: [{
            type: 'text',
            text: `필요한 패키지가 없습니다: ${missing.join(', ')}\n설치 명령: pip install diffusers transformers accelerate torch Pillow`,
          }],
        };
      }
    }

    switch (name) {
      case 'image_generate': {
        if (!args.prompt) {
          return { content: [{ type: 'text', text: 'prompt가 필요합니다.' }] };
        }

        const result = await imageGen.generate({
          prompt: args.prompt,
          negative_prompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          steps: args.steps,
          cfg_scale: args.cfg_scale,
          seed: args.seed,
        });

        const content = [];
        content.push({
          type: 'text',
          text: `이미지 생성 완료 (${result.images.length}장)\n프롬프트: ${args.prompt}\n크기: ${args.width || 512}x${args.height || 512}\n저장 경로:\n${result.images.map(img => img.path).join('\n')}`,
        });

        for (const img of result.images) {
          content.push({ type: 'image', data: img.base64, mimeType: 'image/png' });
        }

        return { content };
      }

      case 'image_edit': {
        if (!args.image_path || !args.prompt) {
          return { content: [{ type: 'text', text: 'image_path와 prompt가 필요합니다.' }] };
        }

        const result = await imageGen.edit({
          image_path: args.image_path,
          prompt: args.prompt,
          negative_prompt: args.negative_prompt,
          denoising_strength: args.denoising_strength,
          width: args.width,
          height: args.height,
          steps: args.steps,
          cfg_scale: args.cfg_scale,
        });

        const content = [];
        content.push({
          type: 'text',
          text: `이미지 편집 완료\n프롬프트: ${args.prompt}\n변형 강도: ${args.denoising_strength || 0.75}\n저장 경로:\n${result.images.map(img => img.path).join('\n')}`,
        });

        for (const img of result.images) {
          content.push({ type: 'image', data: img.base64, mimeType: 'image/png' });
        }

        return { content };
      }

      case 'image_upscale': {
        if (!args.image_path) {
          return { content: [{ type: 'text', text: 'image_path가 필요합니다.' }] };
        }

        const result = await imageGen.upscale({
          image_path: args.image_path,
          scale: args.scale,
        });

        return {
          content: [
            { type: 'text', text: `업스케일 완료 (${args.scale || 2}배)\n저장 경로: ${result.path}` },
            { type: 'image', data: result.base64, mimeType: 'image/png' },
          ],
        };
      }

      case 'image_status': {
        const status = await imageGen.getStatus();

        if (!status.connected) {
          return {
            content: [{
              type: 'text',
              text: `이미지 생성 환경 문제\n${status.error}\n\n설치: pip install diffusers transformers accelerate torch Pillow`,
            }],
          };
        }

        const lines = [
          '이미지 생성 환경 정상',
          `디바이스: ${status.device}${status.gpu ? ` (${status.gpu}, VRAM ${status.vram_gb}GB)` : ''}`,
          `모델 로드: ${status.model_loaded ? status.current_model : '미로드 (첫 생성 시 자동 로드)'}`,
          `diffusers: ${status.diffusers_version || '미설치'}`,
          `torch: ${status.torch_version || '미설치'}`,
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
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
