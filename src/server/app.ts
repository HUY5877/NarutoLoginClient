import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express, { type CookieOptions, type ErrorRequestHandler, type Request } from 'express';
import type { AuthService, User } from './auth.js';
import type { Config } from './config.js';
import type { ObjectReader } from './storage.js';
import { ApiError } from './errors.js';
import type { Task } from './queue.js';
import type { LoginEventService } from './login-events.js';
import { isLogCursorRange, isStreamCursor, type TaskRunService } from './task-runs.js';
import { parseUserOptions } from '../shared/user-options.js';
import { parseLoginType } from '../shared/login-types.js';
import type { AdminService } from './admin.js';
import { logBackend, requestLogContext } from './logging.js';
import type { QqCaptureService } from './qq-captures.js';
import { validateQqJson } from './qq-authorization-data.js';
import type { QqBindingService } from './qq-binding.js';

export interface Dependencies {
  events: Pick<LoginEventService, 'create' | 'getForUser' | 'getActive' | 'recordStatus'> & Partial<Pick<LoginEventService, 'refresh'>>;
  auth: Pick<AuthService, 'register' | 'login' | 'getUser' | 'listApplications' | 'reviewApplication'>;
  storage: ObjectReader;
  runs?: Pick<TaskRunService, 'getLatest' | 'getEvents'>;
  admin?: Pick<AdminService, 'listUsers' | 'getUser' | 'createUser' | 'updateUser' | 'deleteUser' | 'dailyTasks' | 'dailyTaskFailureDetails' | 'dailyTaskLogs' | 'interruptDailyTask' | 'monthlyStats'>;
  qqCaptures?: Pick<QqCaptureService, 'upload' | 'list'> & Partial<Pick<QqCaptureService, 'initialize'>>;
  qqBindings?: Pick<QqBindingService, 'getStatus' | 'createChallenge' | 'confirm' | 'unbind' | 'handleWebhook'>;
  now?: () => number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError(400, '无效的登录申请编号。');
  return id;
}

function sessionToken(req: Request, cookieName: string): string | undefined {
  const value = req.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && value.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function cookieOptions(req: Request): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' };
}

function logPath(req: Request): string {
  const path = req.originalUrl.split('?')[0].replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id');
  // Unknown paths can contain arbitrary user input; never include them in diagnostics.
  return /^\/api\/(?:health|auth\/(?:me|login|register|logout)|qq-captures|qq-authorizations|login-sessions(?:\/(?:active|:id)(?:\/(?:refresh|qr))?)?|task-runs\/(?:latest|:id\/events)|admin\/(?:users(?:\/:id)?|monthly-stats|daily-tasks(?:\/:id\/(?:failure-details|logs|interrupt))?|registration-applications(?:\/:id\/review)?))$/.test(path)
    ? path : '/api/unknown';
}

export function createApp(config: Config, { events, auth, storage, runs, admin, qqCaptures, qqBindings, now = Date.now }: Dependencies) {
  const app = express();
  const cookieName = config.sessionCookieName ?? 'naruto_session';
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    const requestId = randomUUID();
    const upstream = req.get('x-vercel-id');
    const vercelRequestId = upstream && /^[A-Za-z0-9_:-]{1,128}$/.test(upstream) ? upstream : undefined;
    res.locals.requestStartedAt = performance.now();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.set('X-Request-Id', requestId);
    requestLogContext.run({ requestId, method: req.method, path: logPath(req), ...(vercelRequestId ? { vercelRequestId } : {}) }, next);
  });
  const bindingService = () => {
    if (!qqBindings) throw new ApiError(503, 'QQ 群提醒绑定尚未配置。', 'QQ_BINDING_DISABLED');
    return qqBindings;
  };
  // QQ signs exact bytes. Register before ordinary JSON parsing and website session/CSRF handling.
  app.post('/api/qq/events', express.raw({ type: () => true, limit: '64kb', inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ApiError(400, 'QQ 机器人回调格式无效。', 'QQ_WEBHOOK_INVALID');
    res.json(await bindingService().handleWebhook(req.body, { appId: req.get('X-Bot-Appid'),
      timestamp: req.get('X-Signature-Timestamp'), signature: req.get('X-Signature-Ed25519') }));
  });
  const standardJson = express.json({ limit: '2kb' });
  const captureJson = express.json({ limit: '64kb', verify: (_req, _res, buffer) => validateQqJson(buffer) });
  app.use((req, res, next) => {
    const captureUpload = req.method === 'POST' && /^\/api\/qq-captures\/?$/i.test(req.path);
    (captureUpload ? captureJson : standardJson)(req, res, next);
  });
  app.get('/api/health', (_req, res) => res.json({
    ok: true, storage: config.storageDriver, simulation: true, environment: config.appEnv ?? 'prod',
  }));

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

  app.get('/api/auth/me', async (req, res) => res.json({ user: await auth.getUser(sessionToken(req, cookieName)) }));
  app.post('/api/auth/register', async (req, res) => {
    res.status(201).json(await auth.register(req.body));
  });
  app.post('/api/auth/login', async (req, res) => {
    const result = await auth.login(req.body);
    res.cookie(cookieName, result.token, { ...cookieOptions(req), expires: result.expiresAt });
    res.json({ user: result.user });
  });
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(cookieName, cookieOptions(req));
    res.status(204).end();
  });

  app.use('/api/qq-binding', async (req, res, next) => {
    const user = await auth.getUser(sessionToken(req, cookieName));
    if (!user) throw new ApiError(401, '请先登录账号。', 'AUTH_REQUIRED');
    res.locals.user = user; next();
  });
  app.get('/api/qq-binding', async (_req, res) => res.json(qqBindings
    ? await qqBindings.getStatus((res.locals.user as User).id) : { enabled: false, binding: null, challenge: null }));
  app.post('/api/qq-binding/challenge', async (_req, res) => res.status(201).json(await bindingService().createChallenge((res.locals.user as User).id)));
  app.post('/api/qq-binding/confirm', async (req, res) => res.json(await bindingService().confirm((res.locals.user as User).id, req.body)));
  app.delete('/api/qq-binding', async (_req, res) => { await bindingService().unbind((res.locals.user as User).id); res.status(204).end(); });

  const captureService = () => {
    if (!qqCaptures) throw new ApiError(503, 'QQ 抓号服务尚未配置。', 'QQ_AUTHORIZATION_UNAVAILABLE');
    return qqCaptures;
  };
  // Native capture clients authenticate with a short-lived task capability, never a website cookie.
  app.post('/api/qq-captures', async (req, res) => res.status(201).json(await captureService().upload(req.body)));
  app.get('/api/qq-authorizations', async (req, res) => {
    const user = await auth.getUser(sessionToken(req, cookieName));
    if (!user) throw new ApiError(401, '请先登录账号。', 'AUTH_REQUIRED');
    res.json(await captureService().list(user.id));
  });

  app.use('/api/admin', async (req, res, next) => {
    const user = await auth.getUser(sessionToken(req, cookieName));
    if (!user) throw new ApiError(401, '请先登录管理员账号。', 'AUTH_REQUIRED');
    if (!user.isAdmin) throw new ApiError(403, '仅管理员可以访问管理功能。', 'ADMIN_REQUIRED');
    res.locals.user = user;
    next();
  });
  app.get('/api/admin/registration-applications', async (req, res) => {
    res.json(await auth.listApplications(res.locals.user as User, req.query.status));
  });
  app.post('/api/admin/registration-applications/:id/review', async (req, res) => {
    const id = sessionId(req);
    res.json(await auth.reviewApplication(res.locals.user as User, id, req.body));
  });
  const adminService = () => {
    if (!admin) throw new ApiError(503, '管理服务尚未配置。', 'ADMIN_UNAVAILABLE');
    return admin;
  };
  app.get('/api/admin/daily-tasks', async (req, res) => res.json(await adminService().dailyTasks(res.locals.user as User, req.query)));
  app.post('/api/admin/daily-tasks/:id/interrupt', async (req, res) =>
    res.json(await adminService().interruptDailyTask(res.locals.user as User, sessionId(req))));
  app.get('/api/admin/monthly-stats', async (req, res) => res.json(await adminService().monthlyStats(res.locals.user as User, req.query)));
  app.get('/api/admin/daily-tasks/:id/failure-details', async (req, res) =>
    res.json(await adminService().dailyTaskFailureDetails(res.locals.user as User, sessionId(req))));
  app.get('/api/admin/daily-tasks/:id/logs', async (req, res) => {
    // Vercel 的 /api/:path* 重写会附带 path；任务身份仍只使用 URL 路径。
    if (Object.keys(req.query).some(key => key !== 'after' && key !== 'snapshot' && key !== 'path')) {
      throw new ApiError(400, '无效的日志读取位置。');
    }
    const after = req.query.after === undefined ? '0-0' : req.query.after;
    const snapshot = req.query.snapshot;
    if (!isStreamCursor(after) || snapshot !== undefined && (!isStreamCursor(snapshot) || !isLogCursorRange(after, snapshot))) {
      throw new ApiError(400, '无效的日志读取位置。');
    }
    res.json(await adminService().dailyTaskLogs(res.locals.user as User, sessionId(req), after, snapshot));
  });
  app.get('/api/admin/users', async (req, res) => res.json(await adminService().listUsers(res.locals.user as User, req.query)));
  app.get('/api/admin/users/:id', async (req, res) => res.json(await adminService().getUser(res.locals.user as User, req.params.id as string)));
  app.post('/api/admin/users', async (req, res) => res.status(201).json(await adminService().createUser(res.locals.user as User, req.body)));
  app.patch('/api/admin/users/:id', async (req, res) => res.json(await adminService().updateUser(res.locals.user as User, req.params.id as string, req.body)));
  app.delete('/api/admin/users/:id', async (req, res) => {
    await adminService().deleteUser(res.locals.user as User, req.params.id as string);
    res.status(204).end();
  });

  app.use(['/api/login-sessions', '/api/task-runs'], async (req, res, next) => {
    const user = await auth.getUser(sessionToken(req, cookieName));
    if (!user) throw new ApiError(401, '请先登录账号，再获取二维码。', 'AUTH_REQUIRED');
    res.locals.user = user;
    next();
  });
  app.get('/api/task-runs/latest', async (_req, res) => {
    if (!runs) throw new ApiError(503, '任务日志服务尚未配置。', 'TASK_RUNS_UNAVAILABLE');
    res.json(await runs.getLatest((res.locals.user as User).id));
  });
  app.get('/api/task-runs/:id/events', async (req, res) => {
    const id = sessionId(req);
    const after = req.query.after === undefined ? '0-0' : req.query.after;
    if (!isStreamCursor(after)) throw new ApiError(400, '无效的日志读取位置。');
    if (!runs) throw new ApiError(503, '任务日志服务尚未配置。', 'TASK_RUNS_UNAVAILABLE');
    res.json(await runs.getEvents(id, (res.locals.user as User).id, after));
  });
  const publicTask = (task: Task) => ({ ...task, showGetButton: task.status === 'failed' || task.status === 'expired' || now() >= Date.parse(task.expiresAt) });
  app.post('/api/login-sessions', async (req, res) => {
    const user = res.locals.user as User;
    const requestId: unknown = req.body?.requestId === undefined ? randomUUID() : req.body.requestId;
    if (typeof requestId !== 'string' || !uuid.test(requestId)) throw new ApiError(400, '无效的申请标识，请重新操作。');
    const userOptions = parseUserOptions(req.body?.userOptions);
    if (!userOptions) throw new ApiError(400, '任务设置格式不正确，请检查主任务、装备栏体力开关和秘境刷取方式。', 'INVALID_USER_OPTIONS');
    const loginType = parseLoginType(req.body?.loginType);
    if (!loginType) throw new ApiError(400, '请选择有效的登录渠道。', 'INVALID_LOGIN_TYPE');
    // Auth has initialized the parent tables; publish QQ jobs only after their capture table exists.
    if (loginType === 'android_qq' || loginType === 'ios_qq') await qqCaptures?.initialize?.();
    const task = await events.create(user.id, requestId, userOptions, loginType);
    res.status(202).json({ ...publicTask(task), pollAfterMs: 1000 });
  });

  app.get('/api/login-sessions/active', async (_req, res) => {
    const user = res.locals.user as User;
    const session = await events.getActive(user.id);
    res.json({ session, showGetButton: session === null });
  });
  app.post('/api/login-sessions/:id/refresh', async (req, res) => {
    if (!events.refresh) throw new ApiError(503, '二维码刷新服务尚未配置。');
    const task = await events.refresh(sessionId(req), (res.locals.user as User).id);
    res.status(202).json({ ...publicTask(task), pollAfterMs: 1000 });
  });
  app.get('/api/login-sessions/:id', async (req, res) => {
    const id = sessionId(req);
    const userId = (res.locals.user as User).id;
    const task = await events.getForUser(id, userId);
    if (task.status === 'failed') return res.json(publicTask(task));
    if (now() >= Date.parse(task.expiresAt) || task.status === 'expired') return res.json(publicTask({ ...task, status: 'expired' }));
    if (task.refreshRequestId || task.loginAuthorized || task.scanCaptured) return res.json(publicTask(task));
    // 对象是否存在决定二维码就绪；队列状态只用于显示当前步骤。
    const exists = await storage.exists(id);
    if (now() >= Date.parse(task.expiresAt)) return res.json(publicTask({ ...task, status: 'expired' }));
    const status = exists ? 'qr_ready' : task.status === 'qr_ready' ? 'preparing_qr' : task.status;
    if (status !== task.status) await events.recordStatus(id, userId, status);
    return res.json(publicTask({ ...task, status }));
  });

  app.get('/api/login-sessions/:id/qr', async (req, res) => {
    const id = sessionId(req);
    const task = await events.getForUser(id, (res.locals.user as User).id);
    if (task.status === 'expired' || now() >= Date.parse(task.expiresAt)) throw new ApiError(410, '二维码已过期，请重新生成。');
    if (task.status === 'failed') throw new ApiError(409, '本次二维码生成失败，请重新申请。');
    if (task.refreshRequestId || task.loginAuthorized || task.scanCaptured) throw new ApiError(409,
      task.loginAuthorized || task.scanCaptured ? '扫码已完成，无需再次扫码。' : '新二维码正在准备，请稍候。');
    const content = await storage.read(id);
    if (now() >= Date.parse(task.expiresAt)) throw new ApiError(410, '二维码已过期，请重新生成。');
    const latest = await events.getForUser(id, (res.locals.user as User).id);
    if (now() >= Date.parse(latest.expiresAt)) throw new ApiError(410, '扫码时间已结束，请重新启动模拟器。');
    if (latest.refreshRequestId || latest.loginAuthorized || latest.scanCaptured || latest.qrRevision !== task.qrRevision
      || latest.status === 'failed' || latest.status === 'expired') {
      throw new ApiError(409, '二维码状态已更新，请重新查询。', 'QR_CHANGED');
    }
    if (!content) throw new ApiError(404, '二维码尚未生成，请稍后重试。');
    if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new ApiError(502, '二维码图片格式无效，请重新申请。');
    }
    res.type('png').send(content);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error instanceof ApiError ? error.status
      : error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type)) ? 400 : 500;
    if (status >= 500) logBackend('error', 'api.request_failed', {
      component: 'api', status, errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', error,
      durationMs: Math.round(performance.now() - (res.locals.requestStartedAt ?? performance.now())),
    });
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    else if (error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
      res.status(400).json({ error: '请求格式无效。' });
    } else res.status(500).json({ error: '登录服务处理失败，请稍后重试。' });
  };
  app.use(onError);
  return app;
}
