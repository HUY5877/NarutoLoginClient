import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { noopLogger } from '@mastra/core/logger';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Dependencies } from './app.js';
import { ApiError } from './errors.js';
import { QrTaskResultService } from './qr-task-result.js';
import { logBackend } from './logging.js';
import { loginTypes } from '../shared/login-types.js';
import { mainTasks, parseUserOptions, secretRealmModes } from '../shared/user-options.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const qq = z.string().regex(/^[1-9][0-9]*$/).describe('用户的真实数字 QQ 号，以字符串传入。');
const userOptions = z.object({ mainTask: z.enum(mainTasks).optional(), equipmentStamina: z.boolean().optional(),
  secretRealmMode: z.enum(secretRealmModes).optional() }).strict();
const failure = z.object({ status: z.literal('error'), code: z.string(), message: z.string(), taskId: z.string().optional() });
const digest = (value: string) => createHash('sha256').update(value).digest();
type McpDependencies = Pick<Dependencies, 'events' | 'storage' | 'mcpBindings' | 'qqCaptures'> & { now?: () => number };

function safeFailure(error: unknown) {
  if (error instanceof ApiError) return { status: 'error' as const, code: error.code ?? `HTTP_${error.status}`, message: error.message };
  logBackend('error', 'hyrz.tool_failed', { component: 'hyrz', errorCode: 'HYRZ_TOOL_FAILED' });
  return { status: 'error' as const, code: 'HYRZ_TOOL_FAILED', message: '操作暂时未完成，请稍后重试。' };
}

async function safely<T>(run: () => Promise<T>) {
  try { return await run(); } catch (error) { return safeFailure(error); }
}

/** The bearer credential belongs only to a trusted bot backend, which may select a userId. */
export function createHyrzMcpHandler(config: Config, dependencies: McpDependencies) {
  const expected = config.hyrzMcpToken ? digest(config.hyrzMcpToken) : undefined;
  let server: MCPServer | undefined;
  const bindings = () => {
    if (!dependencies.mcpBindings) throw new ApiError(503, 'QQ 号绑定服务尚未配置。', 'HYRZ_BINDINGS_UNAVAILABLE');
    return dependencies.mcpBindings;
  };
  const qr = new QrTaskResultService({ events: dependencies.events, storage: dependencies.storage, now: dependencies.now });

  function mcpServer() {
    if (server) return server;
    const tools = {
      bind_qq: createTool({
        id: 'bind_qq', description: '为 QQ 号生成一次性网站绑定链接。请把链接交给该 QQ 用户，由其登录网站并明确确认；返回链接不代表已绑定。',
        inputSchema: z.object({ qq }).strict(),
        outputSchema: z.object({ qq: z.string(), bindingUrl: z.string(), expiresAt: z.string() }).or(failure),
        execute: async (input, context) => safely(() => {
          const auth = context?.mcp?.extra.authInfo as { extra?: { publicOrigin?: string } } | undefined;
          return bindings().create(input.qq, auth?.extra?.publicOrigin);
        }),
      }),
      unbind_qq: createTool({
        id: 'unbind_qq', description: '解除指定网站用户的数字 QQ 号绑定。保留原有 QQ 官方机器人 openid 群提醒绑定。',
        inputSchema: z.object({ userId: uuid }).strict(),
        outputSchema: z.object({ userId: z.string(), status: z.literal('unbound') }).or(failure),
        execute: async input => safely(async () => {
          const userId = input.userId.toLowerCase();
          await bindings().assertActiveUser(userId);
          return bindings().unbind(userId);
        }),
      }),
      qq_to_userid: createTool({
        id: 'qq_to_userid', description: '把已确认绑定的数字 QQ 号转换成有效网站用户的 userId。后续二维码工具使用这个 userId；未绑定时先调用 bind_qq。',
        inputSchema: z.object({ qq }).strict(),
        outputSchema: z.object({ qq: z.string(), userId: z.string() }).or(failure),
        execute: async input => safely(() => bindings().resolve(input.qq)),
      }),
      request_qrcode: createTool({
        id: 'request_qrcode', description: '以 userId 提交游戏登录二维码申请。提供登录渠道和任务选项；同一次申请重试必须保留同一 UUID requestId，新的申请才换 ID。已有活动任务会返回其实际渠道和选项。省略选项时采用网页默认设置。',
        inputSchema: z.object({ userId: uuid, requestId: uuid, loginType: z.enum(loginTypes), userOptions: userOptions.optional() }).strict(),
        outputSchema: z.object({ status: z.literal('running'), taskId: z.string(), loginType: z.enum(loginTypes),
          userOptions, expiresAt: z.string(), pollAfterMs: z.number() }).or(failure),
        execute: async input => safely(async () => {
          const userId = input.userId.toLowerCase();
          await bindings().assertActiveUser(userId);
          const options = parseUserOptions(input.userOptions);
          if (!options) throw new ApiError(400, '任务设置格式不正确。', 'INVALID_USER_OPTIONS');
          if (input.loginType === 'android_qq' || input.loginType === 'ios_qq') await dependencies.qqCaptures?.initialize?.();
          const task = await dependencies.events.create(userId, input.requestId.toLowerCase(), options, input.loginType);
          if (task.status === 'failed' || task.status === 'expired' || task.runStatus && ['failed', 'interrupted', 'expired', 'completed'].includes(task.runStatus)) {
            return { status: 'error' as const, taskId: task.id, code: 'QR_REQUEST_ENDED', message: '这次申请已结束。重新申请时请使用新的 requestId。' };
          }
          return { status: 'running' as const, taskId: task.id, loginType: task.loginType ?? input.loginType,
            userOptions: task.userOptions ?? options, expiresAt: task.expiresAt, pollAfterMs: 1000 };
        }),
      }),
      get_qrcode_status: createTool({
        id: 'get_qrcode_status', description: '查询该网站用户自己的二维码申请。准备中返回 running，失败/过期/已扫码返回 error，图片就绪返回 success 与短期阿里云 OSS URL。success 只代表二维码就绪。',
        inputSchema: z.object({ userId: uuid, taskId: uuid }).strict(),
        outputSchema: z.object({ status: z.literal('running'), taskId: z.string(), pollAfterMs: z.number() })
          .or(z.object({ status: z.literal('success'), taskId: z.string(), url: z.string(), expiresAt: z.string() })).or(failure),
        execute: async input => safely(async () => {
          const userId = input.userId.toLowerCase();
          await bindings().assertActiveUser(userId);
          return qr.get(userId, input.taskId.toLowerCase());
        }),
      }),
    };
    server = new MCPServer({ id: 'hyrz', name: 'hyrz', version: '1.0.0', legacy: 'stateless', tools,
      description: '忍者日常 QQ 号绑定与登录二维码申请。',
      instructions: '仅供可信机器人后台调用。先确认数字 QQ 绑定，再用 qq_to_userid 获得 userId。申请和查询使用 userId，不要把数字 QQ 号或 QQ openid 当作 userId。',
      toolResult: { modelOutput: false, transform: ({ output, result }) => {
        if (output && typeof output === 'object' && 'status' in output && output.status === 'error') return { ...result, isError: true };
        return result;
      } },
    });
    // The site's fixed diagnostics replace SDK logging, which may otherwise include tool arguments/results.
    server.__setLogger(noopLogger);
    return server;
  }

  function reject(res: Response, status: number, message: string) {
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="hyrz"');
    res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: status === 401 ? -32001 : -32000, message } });
  }

  return {
    async handle(req: Request, res: Response): Promise<void> {
      if (!expected) return reject(res, 503, 'hyrz MCP 尚未配置。');
      const header = req.get('Authorization') ?? '';
      const match = /^Bearer ([^\s]+)$/i.exec(header);
      if (!match || !timingSafeEqual(expected, digest(match[1]))) return reject(res, 401, '请提供有效的后台调用密钥。');
      const ownOrigin = `${req.protocol}://${req.get('Host')}`;
      const allowed = new Set([ownOrigin, ...config.allowedOrigins, ...(config.hyrzPublicUrl ? [new URL(config.hyrzPublicUrl).origin] : [])]);
      const origin = req.get('Origin');
      if (origin && !allowed.has(origin) || !origin && req.get('Sec-Fetch-Site') === 'cross-site') return reject(res, 403, '请求来源不被允许。');
      if (!dependencies.mcpBindings) return reject(res, 503, 'QQ 号绑定服务尚未配置。');
      // Keep the backend credential out of the SDK request context and diagnostics.
      (req as Request & { auth: { token: string; clientId: string; scopes: string[]; extra: { publicOrigin: string } } }).auth = {
        token: 'hyrz-trusted-backend', clientId: 'hyrz', scopes: ['hyrz:tools'], extra: { publicOrigin: ownOrigin },
      };
      await mcpServer().startHTTP({ url: new URL(req.originalUrl, 'http://localhost'), httpPath: '/api/mcp', req, res });
    },
    async close(): Promise<void> { await server?.close(); },
  };
}
