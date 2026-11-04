import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appendRunLogs, emptyTaskRun, parseRunEvents, RunRequestError, TaskRunTracker,
  type RunEvents, type RunLog, type RunTask, type TaskRunView } from '../src/frontend/lib/task-run';

const now = Date.now();
const task: RunTask = { id: 'task-one', createdAt: new Date(now - 60_000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(), status: 'qr_ready' };
const expiredTask = { ...task, expiresAt: new Date(now - 1_000).toISOString(), status: 'expired' };
const log = (id: string): RunLog => ({ id, time: new Date(now).toISOString(), level: 'INFO', message: `日志 ${id}` });
function events(options: Partial<RunEvents> = {}): RunEvents {
  return { task, run: { taskId: task.id, status: 'running_daily', updatedAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(), finishedAt: null }, logs: [], nextCursor: '0-0', hasMore: false,
  truncated: false, ...options };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 8; i += 1) await new Promise<void>(resolve => setImmediate(resolve)); }
const blockedPause = () => new Promise<void>(() => {});

function readerClock(t: TestContext) {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  const cleared: unknown[] = [];
  let next = 0;
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    delays.push(delay); timers.set(++next, callback); return next;
  }) as unknown as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => { cleared.push(timer); timers.delete(Number(timer)); });
  const removed = t.mock.method(AbortSignal.prototype, 'removeEventListener');
  return { timers, delays, cleared, removed };
}

test('默认读取开始前父任务已取消时不发送请求或建立时限', async t => {
  const clock = readerClock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No request should be sent'); });
  const updates: TaskRunView[] = [];
  let tracker: TaskRunTracker;
  tracker = new TaskRunTracker(view => {
    updates.push(view);
    if (view.loading) tracker.dispose();
  }, () => assert.fail('unexpected unauthorized'), undefined, blockedPause);
  await tracker.restore();
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(clock.delays, []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].error, '');
});

for (const outcome of ['timeout', 'cancel'] as const) {
  test(`默认读取在响应正文等待期间${outcome}会中止请求并清理资源`, async t => {
    const clock = readerClock(t);
    let view = emptyTaskRun();
    let signal: AbortSignal | undefined;
    let readingBody = false;
    t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return { ok: true, json: () => {
        readingBody = true;
        return new Promise((_resolve, reject) => signal!.addEventListener('abort',
          () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      } } as Response;
    });
    const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), undefined, blockedPause);
    const restoring = tracker.restore();
    try {
      await settle();
      assert.equal(readingBody, true, 'The headers have arrived but JSON body reading is still pending');
      assert.deepEqual(clock.delays, [10000]);
      assert.equal(clock.timers.size, 1, 'The deadline must cover the complete response body');
      if (outcome === 'timeout') clock.timers.values().next().value!();
      else tracker.dispose();
      await restoring;
      assert.equal(signal?.aborted, true);
      assert.equal(clock.timers.size, 0);
      assert.equal(clock.cleared.length, 1);
      assert.ok(clock.removed.mock.calls.some(call => call.arguments[0] === 'abort'));
      if (outcome === 'timeout') assert.match(view.error, /重试/);
      else assert.equal(view.error, '', 'Disposing the tracker must not display a late failure');
    } finally { tracker.dispose(); await restoring; }
  });
}

for (const status of [200, 503]) {
  test(`默认读取HTTP ${status}完成后清理时限和父取消监听`, async t => {
    const clock = readerClock(t);
    let view = emptyTaskRun();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: status === 200, status,
      json: async () => ({ task: null, run: null }) }) as Response);
    const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), undefined, blockedPause);
    try {
      await tracker.restore();
      assert.deepEqual(clock.delays, [10000]);
      assert.equal(clock.timers.size, 0);
      assert.equal(clock.cleared.length, 1);
      assert.ok(clock.removed.mock.calls.some(call => call.arguments[0] === 'abort'));
      if (status === 200) assert.equal(view.restored, true);
      else assert.match(view.error, /重试/);
    } finally { tracker.dispose(); }
  });
}

test('首次恢复直接采用完整运行状态，不等待日志响应', async () => {
  let view = emptyTaskRun();
  const pendingLogs = deferred<unknown>();
  const snapshot = events({ task: expiredTask });
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path =>
    path.endsWith('/latest') ? { task: expiredTask, run: snapshot.run } : pendingLogs.promise, blockedPause);
  await tracker.restore();
  assert.equal(view.run?.status, 'running_daily');
  assert.equal(view.loading, false);
  assert.equal(view.restored, true);
  tracker.dispose();
  pendingLogs.resolve(snapshot);
});

test('首次恢复已完成任务回到待开始，不读取旧日志', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path => {
    paths.push(path);
    return { task, run: { ...events().run!, status: 'completed', finishedAt: task.createdAt } };
  }, blockedPause);
  await tracker.restore();
  await settle();
  assert.deepEqual(paths, ['/api/task-runs/latest']);
  assert.equal(view.restored, true);
  assert.equal(view.task, null);
  assert.equal(view.run, null);
  assert.deepEqual(view.logs, []);
  tracker.dispose();
});

test('首次恢复缺少运行状态不能视为没有任务', async () => {
  let view = emptyTaskRun();
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async () => ({ task, run: null }), blockedPause);
  await tracker.restore();
  assert.equal(view.restored, false);
  assert.match(view.error, /重试/);
  tracker.dispose();
});

test('排队任务也具有完整运行状态', () => {
  const queued = events({ run: { ...events().run!, status: 'queued', startedAt: null } });
  assert.equal(parseRunEvents(queued, task.id, '0-0').run?.status, 'queued');
});

test('扫码接收时间独立于游戏授权，接受有效时间并拒绝畸形值', () => {
  const value = events();
  Object.assign(value.run!, { status: 'waiting_scan', startedAt: null, scanCapturedAt: task.createdAt });
  assert.equal((parseRunEvents(value, task.id, '0-0').run as unknown as Record<string, unknown>).scanCapturedAt, task.createdAt);
  for (const invalid of [null, 1, false, '', 'invalid']) {
    Object.assign(value.run!, { scanCapturedAt: invalid });
    assert.throws(() => parseRunEvents(value, task.id, '0-0'));
  }
});

test('run records restore after the QR session expired and keep polling daily work', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  const waits: number[] = [];
  const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), async path => {
    paths.push(path);
    return path.endsWith('/latest') ? { task: expiredTask, run: events().run } : events({ task: expiredTask, logs: [log('1-0')], nextCursor: '1-0' });
  }, async ms => { waits.push(ms); await blockedPause(); });
  await tracker.restore();
  await settle();
  assert.equal(paths[0], '/api/task-runs/latest');
  assert.equal(paths[1], '/api/task-runs/task-one/events?after=0-0');
  assert.equal(view.run?.status, 'running_daily');
  assert.equal(view.polling, true);
  assert.equal(view.unavailable, false);
  assert.deepEqual(waits, [1_500]);
  tracker.dispose();
});

test('终态每次只读一批，即使还有更多也等用户继续读取', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  const waits: number[] = [];
  const terminal = { ...events().run!, status: 'completed' as const, finishedAt: new Date(now).toISOString() };
  const pages = [events({ run: terminal, logs: [log('1-0')], nextCursor: '1-0', hasMore: true, truncated: true }),
    events({ run: terminal, logs: [log('2-0')], nextCursor: '2-0' })];
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path => {
    paths.push(path); return pages.shift();
  }, async ms => { waits.push(ms); });
  tracker.follow(task);
  await settle();
  assert.equal(paths.length, 1);
  assert.equal(view.logs.length, 1);
  assert.equal(view.polling, false);
  tracker.retry(); await settle();
  assert.equal(paths.length, 2);
  assert.equal(paths[1], '/api/task-runs/task-one/events?after=1-0');
  assert.deepEqual(waits, []);
  assert.deepEqual(view.logs.map(item => item.id), ['1-0', '2-0']);
  assert.equal(view.polling, false);
  assert.equal(view.truncated, true);
  tracker.dispose();
});

test('null run with expired login finishes querying and still shows available logs', async () => {
  let view = emptyTaskRun();
  let requests = 0;
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async () => {
    requests += 1;
    return events({ task: expiredTask, run: null, logs: [log('1-0')], nextCursor: '1-0' });
  }, () => assert.fail('must stop'));
  tracker.follow(expiredTask);
  await settle();
  assert.equal(requests, 1);
  assert.equal(view.unavailable, true);
  assert.equal(view.polling, false);
  assert.equal(view.logs.length, 1);
  tracker.dispose();
});

test('new QR task aborts an older latest response and never restores the older task', async () => {
  let view = emptyTaskRun();
  const latest = deferred<unknown>();
  let latestSignal: AbortSignal | undefined;
  const newTask = { ...task, id: 'task-new' };
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async (path, signal) => {
    if (path.endsWith('/latest')) { latestSignal = signal; return latest.promise; }
    return events({ task: newTask, run: { ...events().run!, taskId: newTask.id }, logs: [log('2-0')], nextCursor: '2-0' });
  }, blockedPause);
  const restoring = tracker.restore();
  tracker.follow(newTask);
  latest.resolve({ task });
  await restoring;
  await settle();
  assert.equal(latestSignal?.aborted, true);
  assert.equal(view.task?.id, 'task-new');
  assert.deepEqual(view.logs.map(item => item.id), ['2-0']);
  tracker.dispose();
});

test('dispose aborts requests and prevents late account responses and unauthorized callbacks', async () => {
  const response = deferred<unknown>();
  let requestSignal: AbortSignal | undefined;
  const updates: TaskRunView[] = [];
  const tracker = new TaskRunTracker(view => updates.push(view), () => assert.fail('stale account callback'), async (_path, signal) => {
    requestSignal = signal; return response.promise;
  });
  tracker.follow(task);
  const count = updates.length;
  tracker.dispose();
  response.resolve(events());
  await settle();
  assert.equal(requestSignal?.aborted, true);
  assert.equal(updates.length, count);
});

test('retry resumes the successful cursor and preserves logs through errors', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  let attempt = 0;
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path => {
    paths.push(path);
    attempt += 1;
    if (attempt === 2) throw new Error('private backend diagnostic must never display');
    return events({ logs: [log(attempt === 1 ? '1-0' : '2-0')], nextCursor: attempt === 1 ? '1-0' : '2-0',
      run: { ...events().run!, status: attempt === 1 ? 'running_daily' : 'completed' } });
  }, async () => {});
  tracker.follow(task);
  await settle();
  assert.equal(view.logs.length, 1);
  assert.match(view.error, /重试/);
  assert.doesNotMatch(view.error, /private/);
  tracker.retry();
  await settle();
  assert.equal(paths[2], '/api/task-runs/task-one/events?after=1-0');
  assert.deepEqual(view.logs.map(item => item.id), ['1-0', '2-0']);
  assert.equal(view.error, '');
  assert.equal(view.polling, false);
  tracker.dispose();
});

test('401 clears run logs and notifies authentication once', async () => {
  let view = emptyTaskRun();
  let unauthorized = 0;
  const tracker = new TaskRunTracker(next => { view = next; }, () => { unauthorized += 1; }, async () => { throw new RunRequestError(401); });
  tracker.follow(task);
  await settle();
  assert.deepEqual(view, emptyTaskRun());
  assert.equal(unauthorized, 1);
  tracker.dispose();
});

test('日志按编号去重，超过2000条仍保留已读内容', () => {
  const previous = Array.from({ length: 2_000 }, (_, i) => log(`${i + 1}-0`));
  const merged = appendRunLogs(previous, [log('2000-0'), log('2001-0'), log('2001-0')]);
  assert.equal(merged.logs.length, 2_001);
  assert.equal(merged.logs[0].id, '1-0');
  assert.equal(merged.logs.at(-1)?.id, '2001-0');
});

test('parser rejects cross-task data, regressing cursors and non-progressing pagination', () => {
  assert.throws(() => parseRunEvents(events(), 'another-task', '0-0'));
  assert.throws(() => parseRunEvents(events({ nextCursor: '1-0' }), task.id, '2-0'));
  assert.throws(() => parseRunEvents(events({ hasMore: true }), task.id, '0-0'));
  assert.throws(() => parseRunEvents(events({ run: { ...events().run!, taskId: 'another-task' } }), task.id, '0-0'));
  assert.throws(() => parseRunEvents(events({ logs: [log('2-0'), log('1-0')], nextCursor: '2-0' }), task.id, '0-0'));
});

test('latest without a task stays idle and repeated same-task observations do not restart queries', async () => {
  let view = emptyTaskRun();
  let requests = 0;
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path => {
    requests += 1;
    return path.endsWith('/latest') ? { task: null, run: null } : events();
  }, blockedPause);
  await tracker.restore();
  assert.equal(view.loading, false);
  assert.equal(view.task, null);
  tracker.follow(task);
  tracker.follow(task);
  await settle();
  assert.equal(requests, 2);
  tracker.dispose();
});

test('终态立即展示部分日志，不等待上传水位，下次重试读取迟到日志', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  const terminal = { ...events().run!, status: 'completed' as const, logSource: 'sls' as const, logCursor: '99-0' };
  const pages = [events({ run: terminal, logs: [log('1-0')], nextCursor: '1-0', logsPending: true }),
    events({ run: terminal, logs: [], nextCursor: '1-0' }),
    events({ run: terminal, logs: [log('2-0')], nextCursor: '2-0' })];
  const tracker = new TaskRunTracker(next => { view = next; }, () => {}, async path => {
    paths.push(path); return pages.shift();
  }, () => assert.fail('Terminal run must not wait for uploads'));
  tracker.follow(task); await settle();
  assert.equal(paths.length, 1); assert.equal(view.logs.length, 1);
  assert.equal(view.polling, false); assert.equal(view.error, '');
  tracker.retry(); await settle();
  assert.equal(view.logs.length, 1); assert.equal(view.polling, false);
  tracker.retry(); await settle();
  assert.deepEqual(view.logs.map(item => item.id), ['1-0', '2-0']);
  assert(paths.slice(1).every(path => path.endsWith('after=1-0')));
  tracker.dispose();
});

test('run parser preserves authorization through finishing and terminal failure without treating it as daily start', () => {
  const authorizedAt = new Date(now).toISOString();
  const finishing = events({ run: { ...events().run!, status: 'finishing_login', authorizedAt, startedAt: null } });
  assert.equal(parseRunEvents(finishing, task.id, '0-0').run?.authorizedAt, authorizedAt);
  assert.equal(parseRunEvents(finishing, task.id, '0-0').run?.startedAt, null);
  const failed = events({ run: { ...finishing.run!, status: 'failed', errorCode: 'login_finish_failed' } });
  assert.equal(parseRunEvents(failed, task.id, '0-0').run?.authorizedAt, authorizedAt);
  assert.throws(() => parseRunEvents(events({ run: { ...finishing.run!, authorizedAt: 'invalid' } }), task.id, '0-0'));
});

test('日志可部分返回，不受旧上传标记限制，运行摘要字段仍须合法', () => {
  const partial = events({ logs: [log('1-0')], nextCursor: '1-0', logsPending: true });
  assert.equal(parseRunEvents(partial, task.id, '0-0').logs.length, 1);
  for (const patch of [{ logSource: 'redis' }, { logCursor: 'invalid' }]) {
    assert.throws(() => parseRunEvents({ ...partial, run: { ...events().run!, ...patch } }, task.id, '0-0'));
  }
});

test('执行快照兼容旧任务，并验证首次秘境完成时间在运行和终态均可读取', () => {
  const secretRealmCompletedAt = new Date(now).toISOString();
  assert.equal(parseRunEvents(events(), task.id, '0-0').run?.secretRealmCompletedAt, undefined);
  for (const status of ['running_daily', 'completed', 'failed', 'interrupted'] as const) {
    const snapshot = events({ run: { ...events().run!, status, secretRealmCompletedAt,
      ...(status === 'failed' ? { errorCode: 'daily_timeout' } : {}) } });
    assert.equal(parseRunEvents(snapshot, task.id, '0-0').run?.secretRealmCompletedAt, secretRealmCompletedAt);
  }
  for (const invalid of ['invalid', '2026-99-99T00:00:00.000Z', null, true, 123, {}]) {
    const snapshot = { ...events(), run: { ...events().run!, secretRealmCompletedAt: invalid } };
    assert.throws(() => parseRunEvents(snapshot, task.id, '0-0'));
  }
});

test('刷新恢复和日志分页保留首次秘境完成及全部已读日志，新任务清除旧标记', async () => {
  let view = emptyTaskRun();
  let page = 0;
  const secretRealmCompletedAt = new Date(now).toISOString();
  const newTask = { ...task, id: 'new-daily-task' };
  const newResponse = deferred<unknown>();
  const paths: string[] = [];
  const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), async path => {
    paths.push(path);
    if (path.endsWith('/latest')) return { task: expiredTask, run: { ...events().run!, secretRealmCompletedAt } };
    if (path.includes(newTask.id)) return newResponse.promise;
    page++;
    const first = (page - 1) * 100 + 1;
    const last = Math.min(page * 100, 2001);
    const terminal = last === 2001;
    return events({ task: expiredTask,
      run: { ...events().run!, secretRealmCompletedAt, status: terminal ? 'failed' : 'running_daily',
        ...(terminal ? { errorCode: 'daily_timeout', finishedAt: new Date(now).toISOString() } : {}) },
      logs: Array.from({ length: last - first + 1 }, (_, i) => log(`${first + i}-0`)),
      nextCursor: `${last}-0`, hasMore: !terminal });
  }, async () => {});
  await tracker.restore();
  await settle();
  assert.equal(view.run?.secretRealmCompletedAt, secretRealmCompletedAt);
  assert.equal(view.run?.status, 'failed');
  assert.equal(view.polling, false);
  assert.equal(view.truncated, false);
  assert.equal(view.logs.length, 2001);
  assert.equal(view.logs[0].id, '1-0');
  assert.equal(view.logs.at(-1)?.id, '2001-0');
  assert.equal(paths[2], '/api/task-runs/task-one/events?after=100-0');
  tracker.follow(newTask);
  assert.equal(view.task?.id, newTask.id);
  assert.equal(view.run, null);
  assert.equal(view.logs.length, 0);
  newResponse.resolve(events({ task: newTask, run: { ...events().run!, taskId: newTask.id, status: 'completed' } }));
  await settle();
  // The tracker callback replaces the view after the earlier null assertion.
  assert.equal((view as TaskRunView).run?.secretRealmCompletedAt, undefined);
  assert.equal(paths.at(-1), '/api/task-runs/new-daily-task/events?after=0-0');
  tracker.dispose();
});
