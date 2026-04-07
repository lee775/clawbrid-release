#!/usr/bin/env node
/**
 * ClawBrid Cron MCP Server
 * Claude Code에 등록하면 자연어로 크론 작업을 관리할 수 있음
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const cronManager = require('../core/cron-manager');

const server = new Server(
  { name: 'clawbrid-cron', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'cron_list',
      description: '등록된 크론 작업 목록을 조회합니다',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cron_add',
      description: '새로운 크론 작업을 등록합니다. 표준 cron expression을 사용합니다. 예: "*/30 * * * *"(30분마다), "0 9 * * *"(매일9시), "50 18 * * 1-5"(평일18:50)',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '크론 작업 이름' },
          type: { type: 'string', enum: ['claude', 'shell'], description: 'claude: Claude 프롬프트 실행, shell: 쉘 명령 실행' },
          command: { type: 'string', description: '실행할 프롬프트 또는 쉘 명령' },
          schedule: { type: 'string', description: '표준 cron expression (분 시 일 월 요일). 예: "*/30 * * * *", "0 9 * * *", "50 18 * * 1-5"' },
          target: { type: 'string', enum: ['slack', 'telegram', 'none'], description: '결과 전송 대상', default: 'none' },
        },
        required: ['name', 'command', 'schedule'],
      },
    },
    {
      name: 'cron_remove',
      description: '크론 작업을 삭제합니다',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '삭제할 크론 작업 이름' },
        },
        required: ['name'],
      },
    },
    {
      name: 'cron_toggle',
      description: '크론 작업을 활성화/비활성화합니다',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '토글할 크론 작업 이름' },
        },
        required: ['name'],
      },
    },
    {
      name: 'cron_run',
      description: '크론 작업을 즉시 실행합니다',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '즉시 실행할 크론 작업 이름' },
        },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'cron_list': {
        const crons = cronManager.loadCrons();
        if (!crons.length) return { content: [{ type: 'text', text: '등록된 크론 작업이 없습니다.' }] };
        const list = crons.map(c => {
          const status = c.enabled ? '활성' : '비활성';
          const last = c.lastRun ? new Date(c.lastRun).toLocaleString('ko-KR') : '없음';
          return `- ${c.name} | ${c.type} | ${c.schedule} | ${status} | 마지막: ${last}`;
        }).join('\n');
        return { content: [{ type: 'text', text: `크론 작업 목록:\n${list}` }] };
      }

      case 'cron_add': {
        const entry = cronManager.addCron({
          name: args.name,
          type: args.type || 'claude',
          command: args.command,
          schedule: args.schedule,
          target: args.target || 'none',
        });
        cronManager.startCron(entry);
        return { content: [{ type: 'text', text: `크론 등록 완료: "${entry.name}" (${entry.schedule}, ${entry.type}, 전송: ${entry.target})` }] };
      }

      case 'cron_remove': {
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === args.name);
        if (!found) return { content: [{ type: 'text', text: `"${args.name}" 크론을 찾을 수 없습니다.` }] };
        cronManager.removeCron(found.id);
        return { content: [{ type: 'text', text: `크론 삭제 완료: "${args.name}"` }] };
      }

      case 'cron_toggle': {
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === args.name);
        if (!found) return { content: [{ type: 'text', text: `"${args.name}" 크론을 찾을 수 없습니다.` }] };
        cronManager.toggleCron(found.id);
        const updated = cronManager.loadCrons().find(c => c.id === found.id);
        return { content: [{ type: 'text', text: `"${args.name}" ${updated.enabled ? '활성화' : '비활성화'}됨` }] };
      }

      case 'cron_run': {
        const crons = cronManager.loadCrons();
        const found = crons.find(c => c.name === args.name);
        if (!found) return { content: [{ type: 'text', text: `"${args.name}" 크론을 찾을 수 없습니다.` }] };
        await cronManager.executeCron(found);
        const updated = cronManager.loadCrons().find(c => c.id === found.id);
        return { content: [{ type: 'text', text: `실행 완료: ${updated?.lastResult || '(결과 없음)'}` }] };
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
