import { randomBytes, randomUUID } from 'node:crypto';
import express, { type CookieOptions, type ErrorRequestHandler, type Request } from 'express';
import type { AuthService, User } from './auth.js';
import type { Config } from './config.js';
import type { ObjectReader } from './storage.js';
import { ApiError } from './errors.js';
import type { TaskService } from './queue.js';

export interface Dependencies {
  tasks: Pick<TaskService, 'enqueue' | 'getForUser' | 'getActive'>;
  auth: Pick<AuthService, 'register' | 'login' | 'getUser' | 'logout'>;
  storage: ObjectReader;
  now?: () => number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cookieName = 'naruto_session';

function sessionId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError(400, '无效的登录申请编号。');
  return id;
}

function sessionToken(req: Request): string | undefined {
  const value = req.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function cookieOptions(req: Request): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' };
}

export function createApp(config: Config, { tasks, auth, storage, now = Date.now }: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.use(express.json({ limit: '2kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, storage: config.storageDriver, simulation: true }));

  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('Origin');
    const ownOrigin = `${req.protocol}://${req.get('Host')}`;
    if (req.get('Sec-Fetch-Site') === 'cross-site' || origin && origin !== ownOrigin && !config.allowedOrigins.includes(origin)) {
      throw new ApiError(403, '请从登录页面发起申请。');
    }
    if (!req.is('application/json') && !/^application\/json(?:;|$)/i.test(req.get('Content-Type') ?? '')) {
      throw new ApiError(415, '请使用 JSON 格式提交请求。');
    }
    next();
  });

  app.get('/api/auth/me', async (req, res) => res.json({ user: await auth.getUser(sessionToken(req)) }));
  for (const action of ['register', 'login'] as const) {
    app.post(`/api/auth/${action}`, async (req, res) => {
      const result = await auth[action](req.body);
      res.cookie(cookieName, result.token, { ...cookieOptions(req), expires: result.expiresAt });
      res.status(action === 'register' ? 201 : 200).json({ user: result.user });
    });
  }
  app.post('/api/auth/logout', async (req, res) => {
    await auth.logout(sessionToken(req));
    res.clearCookie(cookieName, cookieOptions(req));
    res.status(204).end();
  });

  app.use('/api/login-sessions', async (req, res, next) => {
    const user = await auth.getUser(sessionToken(req));
    if (!user) throw new ApiError(401, '请先登录账号，再获取二维码。', 'AUTH_REQUIRED');
    res.locals.user = user;
    next();
  });
  app.post('/api/login-sessions', async (_req, res) => {
    const user = res.locals.user as User;
    const created = now();
    const task = { id: randomUUID(), userId: user.id, accessToken: randomBytes(32).toString('hex'),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + config.sessionTtlMs).toISOString() };
    await tasks.enqueue(task);
    res.status(202).json({ id: task.id, createdAt: task.createdAt, expiresAt: task.expiresAt, status: 'queued', pollAfterMs: 1000, simulation: true });
  });

  app.get('/api/login-sessions/active', async (_req, res) => {
    const user = res.locals.user as User;
    res.json({ session: await tasks.getActive(user.id) });
  });
  app.get('/api/login-sessions/:id', async (req, res) => {
    const id = sessionId(req);
    const task = await tasks.getForUser(id, (res.locals.user as User).id);
    if (now() >= Date.parse(task.expiresAt) || task.status === 'expired') return res.json({ ...task, status: 'expired' });
    if (task.status === 'failed') return res.json(task);
    // 对象是否存在决定二维码就绪；队列状态只用于显示当前步骤。
    const exists = await storage.exists(id);
    if (now() >= Date.parse(task.expiresAt)) return res.json({ ...task, status: 'expired' });
    return res.json({ ...task, status: exists ? 'qr_ready' : task.status === 'qr_ready' ? 'preparing_qr' : task.status });
  });

  app.get('/api/login-sessions/:id/qr', async (req, res) => {
    const id = sessionId(req);
    const task = await tasks.getForUser(id, (res.locals.user as User).id);
    if (task.status === 'expired' || now() >= Date.parse(task.expiresAt)) throw new ApiError(410, '二维码已过期，请重新生成。');
    if (task.status === 'failed') throw new ApiError(409, '本次二维码生成失败，请重新申请。');
    const content = await storage.read(id);
    if (now() >= Date.parse(task.expiresAt)) throw new ApiError(410, '二维码已过期，请重新生成。');
    if (!content) throw new ApiError(404, '二维码尚未生成，请稍后重试。');
    if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new ApiError(502, '二维码图片格式无效，请重新申请。');
    }
    res.type('png').send(content);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    else if (error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
      res.status(400).json({ error: '请求格式无效。' });
    } else res.status(500).json({ error: '登录服务处理失败，请稍后重试。' });
  };
  app.use(onError);
  return app;
}
