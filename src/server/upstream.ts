import type { Config } from './config.js';

export type Status = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'qr_ready' | 'failed' | 'expired';
export interface Task {
  id: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  simulation: true;
  error?: string;
}
export interface Submission { id: string; accessToken: string; createdAt: string; expiresAt: string }
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const statuses = new Set<Status>(['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'failed', 'expired']);

export class TaskService {
  constructor(private config: Config) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.config.serviceUrl}${path}`, {
        ...init,
        headers: { ...init.headers, 'X-Service-Token': this.config.serviceToken },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch { throw new ApiError(503, '登录服务暂时不可用，请确认任务服务已启动后重试。'); }
  }

  async enqueue(task: Submission): Promise<void> {
    // 固定 ID 重试，依靠队列服务幂等处理，避免网络中断重复启动模拟器。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.request('/internal/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task),
        });
        if (response.status === 429 || response.status === 503) throw new ApiError(503, '当前登录请求较多，请稍后再试。');
        if (!response.ok) throw new ApiError(502, '登录任务提交失败，请检查客户端与任务服务的配置。');
        await response.body?.cancel();
        return;
      } catch (error) {
        if (attempt === 1 || !(error instanceof ApiError) || error.status !== 503) throw error;
      }
    }
  }

  async get(id: string, token: string): Promise<Task> {
    const response = await this.request(`/internal/tasks/${id}`, { headers: { 'X-Session-Token': token } });
    if (response.status === 404) throw new ApiError(404, '登录申请不存在或已失效，请重新生成二维码。');
    if (!response.ok) throw new ApiError(502, '无法读取登录进度，请稍后重试。');
    let task: Task;
    try { task = await response.json() as Task; } catch { throw new ApiError(502, '登录服务返回了无效结果。'); }
    if (!task || typeof task !== 'object' || task.id !== id || !statuses.has(task.status) || task.simulation !== true || !Number.isFinite(Date.parse(task.expiresAt)) || !Number.isFinite(Date.parse(task.createdAt))) {
      throw new ApiError(502, '登录服务返回了无效结果。');
    }
    // 不向浏览器转发来自 SDK、文件系统或工作进程的内部报错。
    return { id, status: task.status, createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true,
      ...(task.status === 'failed' ? { error: '二维码生成失败，请重新申请。' } : {}) };
  }
}
