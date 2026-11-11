import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MCPServerResources } from '@mastra/mcp';

export const HYRZ_SKILL_URI = 'skill://hyrz-service/SKILL.md';
export const HYRZ_SITE_INFO_URI = 'hyrz://service/site-info';

function websiteUrl(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error();
    }
    return url.origin;
  } catch { throw new Error('Website address is unavailable'); }
}

/** Cache the authored skill; resolve website metadata independently for each request. */
export function createHyrzSkillResources(publicUrl?: string): MCPServerResources {
  // The adjacent folder works in source and in the standalone Vite server build.
  // Vercel's API bundle includes the source assets at the project-relative path.
  const file = [new URL('./skills/hyrz-service/SKILL.md', import.meta.url),
    resolve(process.cwd(), 'src/server/mcp/skills/hyrz-service/SKILL.md')].find(path => existsSync(path));
  if (!file) throw new Error('MCP skill is unavailable');
  const text = readFileSync(file, 'utf8');
  return {
    listResources: async () => [{ uri: HYRZ_SKILL_URI, name: 'hyrz-service',
      description: '火影忍者项目的 QQ 绑定、二维码和任务操作规范，使用业务工具前先阅读。', mimeType: 'text/markdown' },
    { uri: HYRZ_SITE_INFO_URI, name: 'hyrz-site-info',
      description: '当前 MCP 服务对应的网站地址；向用户提供绑定入口前读取，不猜测或复用其他连接的网址。', mimeType: 'application/json' }],
    getResourceContent: async ({ uri, extra }) => {
      if (uri === HYRZ_SITE_INFO_URI) {
        const currentOrigin = publicUrl ?? extra?.authInfo?.extra?.publicOrigin;
        return { text: JSON.stringify({ websiteUrl: websiteUrl(currentOrigin) }) };
      }
      if (uri !== HYRZ_SKILL_URI) throw new Error('Unknown skill resource');
      return { text };
    },
  };
}
