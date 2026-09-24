import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { LoginEvent, LoginEventStore } from './database.js';
import { ApiError } from './errors.js';
import type { Status, Task, TaskService } from './queue.js';
import { loginFailure } from '../shared/task-errors.js';

interface Options {
  store?: LoginEventStore;
  tasks: Pick<TaskService, 'enqueue' | 'getForUser'>;
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
    try {
      await this.options.store.initialize();
      return await run(this.options.store);
    } catch {
      throw new ApiError(503, '登录申请记录暂时不可用，请稍后重试查询。', 'LOGIN_EVENTS_UNAVAILABLE');
    }
  }

  private publicTask(event: LoginEvent): Task {
    const status = event.status === 'failed' ? 'failed' : Date.parse(event.expiresAt) <= this.now() ? 'expired' : event.status;
    return { id: event.id, status, createdAt: event.createdAt, expiresAt: event.expiresAt, simulation: true,
      ...(status === 'failed' ? loginFailure(undefined) : {}) };
  }

  private async resume(event: LoginEvent): Promise<Task> {
    const task = this.publicTask(event);
    if (task.status === 'expired') return task;
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
      const current = await this.options.tasks.getForUser(event.id, event.userId);
      await this.recordStatus(event.id, event.userId, current.status);
      if (current.status === 'failed') {
        const { error: _error, errorCode, ...publicFields } = current;
        return { ...publicFields, ...loginFailure(errorCode) };
      }
      return current;
    } catch (error) {
      // A dispatched task must not be submitted again when Redis loses a key.
      // The durable event still owns this user's slot until its original expiry.
      if (error instanceof ApiError && error.status === 404) return task;
      throw error;
    }
  }

  async create(userId: string, requestId: string): Promise<Task> {
    // Refresh a completed failure before reserving the user's next slot.
    const active = await this.database(store => store.getActive(userId, new Date(this.now())));
    if (active) await this.resume(active);
    const created = this.now();
    const candidate: LoginEvent = {
      id: randomUUID(), userId, requestId, accessToken: randomBytes(32).toString('hex'),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.config.sessionTtlMs).toISOString(),
      status: 'queued', dispatchedAt: null, finishedAt: null,
    };
    const event = await this.database(store => store.reserve(candidate, new Date(this.now())));
    return await this.resume(event);
  }

  async getActive(userId: string): Promise<Task | null> {
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
}
