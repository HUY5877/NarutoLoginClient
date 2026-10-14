import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { LoginEvent, LoginEventStore } from './database.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';
import type { Status, Task, TaskService } from './queue.js';
import { loginFailure } from '../shared/task-errors.js';
import { DEFAULT_USER_OPTIONS, type UserOptions } from '../shared/user-options.js';
import { DEFAULT_LOGIN_TYPE, type LoginType } from '../shared/login-types.js';

interface Options {
  store?: LoginEventStore;
  tasks: Pick<TaskService, 'enqueue' | 'getForUser'> & Partial<Pick<TaskService, 'getActive' | 'requestRefresh'>>;
  now?: () => number;
}

// PostgreSQL records the intent before Redis receives it. Replaying an unfinished
// dispatch always uses the same task ID and token, so Redis enqueues it at most once.
export class LoginEventService {
  private readonly now: () => number;

  constructor(private readonly config: Pick<Config, 'sessionTtlMs'>, private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  private async database<T>(run: (store: LoginEventStore) => Promise<T>): Promise<T> {
    if (!this.options.store) throw new ApiError(503, '账号数据库未配置，请先配置 DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
    let phase = 'database.initialize';
    try {
      await this.options.store.initialize();
      phase = 'database.query';
      return await run(this.options.store);
    } catch (error) {
      logBackend('error', 'dependency.failed', { component: 'login-events', phase, error });
      throw new ApiError(503, '登录申请记录暂时不可用，请稍后重试查询。', 'LOGIN_EVENTS_UNAVAILABLE');
    }
  }

  private publicTask(event: LoginEvent): Task {
    const status = event.status === 'failed' ? 'failed' : Date.parse(event.expiresAt) <= this.now() ? 'expired' : event.status;
    return { id: event.id, status, createdAt: event.createdAt, expiresAt: event.expiresAt, simulation: true,
      userOptions: { ...event.userOptions }, loginType: event.loginType ?? DEFAULT_LOGIN_TYPE,
      ...(status === 'failed' ? loginFailure(undefined) : {}) };
  }

  private async resume(event: LoginEvent): Promise<Task> {
    const task = this.publicTask(event);
    if (task.status === 'expired' && !event.dispatchedAt) {
      // The worker may have claimed the Redis outbox while PostgreSQL's
      // dispatched acknowledgement was unavailable. Recover that live lease
      // without replaying an envelope whose original queue deadline has passed.
      try {
        const current = await this.options.tasks.getForUser(event.id, event.userId);
        if (['failed', 'expired'].includes(current.status) || Date.parse(current.expiresAt) <= this.now()) return task;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return task;
        throw error;
      }
      const dispatchedAt = new Date(this.now());
      await this.database(store => store.markDispatched(event.id, event.userId, dispatchedAt));
      event = { ...event, dispatchedAt: dispatchedAt.toISOString() };
    }
    if (task.status === 'failed') {
      // The database remembers failure, while Redis retains its safe reason.
      // Never replay a failed job or revive it from a stale Redis status.
      try {
        const current = await this.options.tasks.getForUser(event.id, event.userId);
        if (current.status === 'failed') return { ...task, ...loginFailure(current.errorCode) };
      } catch { /* The known failure remains visible when Redis has expired or is unavailable. */ }
      return task;
    }
    if (!event.dispatchedAt) {
      // Keep the event on timeout: Redis may have accepted a command whose reply
      // was lost. A later read can safely complete this same dispatch.
      await this.options.tasks.enqueue(event);
      await this.database(store => store.markDispatched(event.id, event.userId, new Date(this.now())));
    }
    try {
      let current = await this.options.tasks.getForUser(event.id, event.userId);
      if (current.status !== 'failed' && Date.parse(current.expiresAt) <= this.now()) current = { ...current, status: 'expired' };
      await this.database(store => store.updateStatus(event.id, event.userId, current.status, new Date(this.now()), current.expiresAt));
      if (current.status === 'failed') {
        const { error: _error, errorCode, ...publicFields } = current;
        return { ...publicFields, userOptions: task.userOptions, loginType: task.loginType, ...loginFailure(errorCode) };
      }
      return { ...current, userOptions: task.userOptions, loginType: task.loginType };
    } catch (error) {
      // A dispatched task must not be submitted again when Redis loses a key.
      // The durable event still owns this user's slot until its original expiry.
      if (error instanceof ApiError && error.status === 404) return task;
      throw error;
    }
  }

  async create(userId: string, requestId: string, userOptions: UserOptions = DEFAULT_USER_OPTIONS,
    loginType: LoginType = DEFAULT_LOGIN_TYPE): Promise<Task> {
    // A claimed worker has a separate ten-minute lease. Consult its account lock
    // before expiring the original queue reservation in PostgreSQL.
    const live = await this.liveActive(userId);
    if (live && !['failed', 'expired'].includes(live.status)) return live;
    // Refresh a completed failure before reserving the user's next slot.
    const active = await this.database(store => store.getActive(userId, new Date(this.now())));
    if (active) await this.resume(active);
    const created = this.now();
    const candidate: LoginEvent = {
      id: randomUUID(), userId, requestId, accessToken: randomBytes(32).toString('hex'),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.config.sessionTtlMs).toISOString(),
      status: 'queued', dispatchedAt: null, finishedAt: null, userOptions: { ...userOptions }, loginType,
    };
    const event = await this.database(store => store.reserve(candidate, new Date(this.now())));
    try { return await this.resume(event); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'ACTIVE_LOGIN_SESSION') {
        // A claim can race the reservation above. Discard only this undispatched
        // candidate and resume the task that still owns Redis's account lock.
        await this.recordStatus(event.id, userId, 'failed');
        const current = await this.liveActive(userId);
        if (current) return current;
      }
      throw error;
    }
  }

  private async liveActive(userId: string): Promise<Task | null> {
    const task = await this.options.tasks.getActive?.(userId);
    if (!task) return null;
    return this.getForUser(task.id, userId);
  }

  async getActive(userId: string): Promise<Task | null> {
    const live = await this.liveActive(userId);
    if (live && !['failed', 'expired'].includes(live.status)) return live;
    const event = await this.database(store => store.getActive(userId, new Date(this.now())));
    if (!event) return null;
    const task = await this.resume(event);
    return task.status === 'failed' || task.status === 'expired' ? null : task;
  }

  async getForUser(id: string, userId: string): Promise<Task> {
    const event = await this.database(store => store.getEvent(id, userId));
    if (!event) throw new ApiError(404, '登录申请不存在或不属于当前账号。');
    return await this.resume(event);
  }

  async recordStatus(id: string, userId: string, status: Status): Promise<void> {
    await this.database(store => store.updateStatus(id, userId, status, new Date(this.now())));
  }

  async refresh(id: string, userId: string): Promise<Task> {
    await this.getForUser(id, userId);
    if (!this.options.tasks.requestRefresh) throw new ApiError(503, '二维码刷新服务尚未配置。');
    return this.options.tasks.requestRefresh(id, userId);
  }
}
