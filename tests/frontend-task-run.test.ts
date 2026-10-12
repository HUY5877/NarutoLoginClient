import assert from 'node:assert/strict';
import test from 'node:test';
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

test('run records restore after the QR session expired and keep polling daily work', async () => {
  let view = emptyTaskRun();
  const paths: string[] = [];
  const waits: number[] = [];
  const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), async path => {
    paths.push(path);
    return path.endsWith('/latest') ? { task: expiredTask } : events({ task: expiredTask, logs: [log('1-0')], nextCursor: '1-0' });
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

test('terminal run drains every page before stopping and retains truncated notice', async () => {
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
  assert.equal(paths.length, 2);
  assert.equal(paths[1], '/api/task-runs/task-one/events?after=1-0');
  assert.deepEqual(waits, [0]);
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

test('cache deduplicates log IDs and keeps the latest 2000 entries', () => {
  const previous = Array.from({ length: 2_000 }, (_, i) => log(`${i + 1}-0`));
  const merged = appendRunLogs(previous, [log('2000-0'), log('2001-0'), log('2001-0')]);
  assert.equal(merged.logs.length, 2_000);
  assert.equal(merged.logs[0].id, '2-0');
  assert.equal(merged.logs.at(-1)?.id, '2001-0');
  assert.equal(merged.trimmed, true);
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
    return path.endsWith('/latest') ? { task: null } : events();
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

test('run parser preserves authorization through finishing and terminal failure without treating it as daily start', () => {
  const authorizedAt = new Date(now).toISOString();
  const finishing = events({ run: { ...events().run!, status: 'finishing_login', authorizedAt, startedAt: null } });
  assert.equal(parseRunEvents(finishing, task.id, '0-0').run?.authorizedAt, authorizedAt);
  assert.equal(parseRunEvents(finishing, task.id, '0-0').run?.startedAt, null);
  const failed = events({ run: { ...finishing.run!, status: 'failed', errorCode: 'login_finish_failed' } });
  assert.equal(parseRunEvents(failed, task.id, '0-0').run?.authorizedAt, authorizedAt);
  assert.throws(() => parseRunEvents(events({ run: { ...finishing.run!, authorizedAt: 'invalid' } }), task.id, '0-0'));
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

test('刷新恢复和日志分页裁剪保留首次秘境完成，新任务清除旧标记', async () => {
  let view = emptyTaskRun();
  let page = 0;
  const secretRealmCompletedAt = new Date(now).toISOString();
  const newTask = { ...task, id: 'new-daily-task' };
  const newResponse = deferred<unknown>();
  const paths: string[] = [];
  const tracker = new TaskRunTracker(next => { view = next; }, () => assert.fail('unexpected unauthorized'), async path => {
    paths.push(path);
    if (path.endsWith('/latest')) return { task: expiredTask };
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
  assert.equal(view.truncated, true);
  assert.equal(view.logs.length, 2000);
  assert.equal(view.logs[0].id, '2-0');
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
