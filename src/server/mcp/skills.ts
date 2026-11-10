import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MCPServerResources } from '@mastra/mcp';

export const HYRZ_SKILL_URI = 'skill://hyrz-service/SKILL.md';

/** Load once when constructing the server; only this authored resource is exposed. */
export function createHyrzSkillResources(): MCPServerResources {
  // The adjacent folder works in source and in the standalone Vite server build.
  // Vercel's API bundle includes the source assets at the project-relative path.
  const file = [new URL('./skills/hyrz-service/SKILL.md', import.meta.url),
    resolve(process.cwd(), 'src/server/mcp/skills/hyrz-service/SKILL.md')].find(path => existsSync(path));
  if (!file) throw new Error('MCP skill is unavailable');
  const text = readFileSync(file, 'utf8');
  return {
    listResources: async () => [{ uri: HYRZ_SKILL_URI, name: 'hyrz-service',
      description: '火影忍者项目的 QQ 绑定、二维码和任务操作规范，使用业务工具前先阅读。', mimeType: 'text/markdown' }],
    getResourceContent: async ({ uri }) => {
      if (uri !== HYRZ_SKILL_URI) throw new Error('Unknown skill resource');
      return { text };
    },
  };
}
