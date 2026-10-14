import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyTaskLogs, parseTaskLogPage, TaskLogPager } from '../src/frontend/lib/admin-task-logs';
import { AdminRequestError } from '../src/frontend/lib/admin';
import type { DailyTaskLogPage } from '../src/shared/admin';

const taskId = 'task-one';
const at = '2026-10-14T00:00:00.000Z';
const log = (id: number) => ({ id: `${id}-0`, time: at, level: 'INFO' as const, message: `日志 ${id}` });
const page = (patch: Partial<DailyTaskLogPage> = {}): DailyTaskLogPage => ({
  taskId, status: 'completed', logs: [log(1)], nextCursor: '1-0', snapshotCursor: '2-0', hasMore: true, truncated: false, ...patch,
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('日志页拒绝跨任务、游标倒退、快照变化和提前终止，允许跳过损坏条目', () => {
  assert.throws(() => parseTaskLogPage(page(), 'other-task', '0-0', null));
  assert.throws(() => parseTaskLogPage(page(), taskId, '2-0', '2-0'));
  assert.throws(() => parseTaskLogPage(page(), taskId, '0-0', '3-0'));
  assert.throws(() => parseTaskLogPage(page({ hasMore: false }), taskId, '0-0', null));
  assert.throws(() => parseTaskLogPage(page({ nextCursor: '0-0', logs: [] }), taskId, '0-0', null));
  assert.throws(() => parseTaskLogPage(page({ logs: [log(1), log(1)] }), taskId, '0-0', null));
  assert.throws(() => parseTaskLogPage(page({ snapshotCursor: '18446744073709551616-0' }), taskId, '0-0', null));
  assert.throws(() => parseTaskLogPage(page({ nextCursor: '1-0\n' }), taskId, '0-0', null));
  assert.throws(() => parseTaskLogPage(page({ logs: Array.from({ length: 101 }, (_, index) => log(index + 1)) }), taskId, '0-0', null));
  assert.equal(parseTaskLogPage(page({ logs: [], nextCursor: '2-0', hasMore: false, truncated: true }), taskId, '0-0', null).truncated, true);
  assert.equal(parseTaskLogPage(page({ snapshotCursor: '3-0', nextCursor: '2-0', truncated: true }), taskId, '0-0', null).logs.length, 1);
});

test('仅手动加载下一页且固定快照，累计超过2000条日志也不裁剪', async () => {
  let view = emptyTaskLogs();
  const paths: string[] = [];
  const pager = new TaskLogPager(taskId, next => { view = next; }, () => assert.fail('unauthorized'), async path => {
    paths.push(path);
    const after = Number(new URL(path, 'https://fixture').searchParams.get('after')!.split('-')[0]);
    const last = Math.min(after + 100, 2101);
    return page({ logs: Array.from({ length: last - after }, (_, index) => log(after + index + 1)),
      nextCursor: `${last}-0`, snapshotCursor: '2101-0', hasMore: last < 2101 });
  });
  await pager.load();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(paths.length, 1, 'Opening does not automatically drain further pages');
  assert.equal(view.logs.length, 100);
  assert.equal(paths[0], '/api/admin/daily-tasks/task-one/logs?after=0-0');
  while (view.hasMore) await pager.load();
  assert.equal(paths.length, 22);
  assert.equal(paths[1], '/api/admin/daily-tasks/task-one/logs?after=100-0&snapshot=2101-0');
  assert.equal(view.logs.length, 2101);
  assert.equal(view.logs[0].id, '1-0');
  assert.equal(view.logs.at(-1)?.id, '2101-0');
  assert.equal(view.truncated, false);
  await pager.load(); assert.equal(paths.length, 22);
  pager.dispose();
});

test('下一页读取失败保留已有日志，重试沿同一游标，坏快照不合并', async () => {
  let view = emptyTaskLogs();
  const paths: string[] = [];
  const pager = new TaskLogPager(taskId, next => { view = next; }, () => {}, async path => {
    paths.push(path);
    if (paths.length === 2) throw new AdminRequestError(503, '任务日志暂时不可用。');
    if (paths.length === 3) return page({ logs: [log(2)], nextCursor: '2-0', snapshotCursor: '3-0' });
    return paths.length === 1 ? page() : page({ logs: [log(2)], nextCursor: '2-0', hasMore: false });
  });
  await pager.load(); await pager.load();
  assert.equal(view.logs.length, 1);
  assert.match(view.error, /暂时不可用/);
  await pager.load();
  assert.equal(view.logs.length, 1);
  assert.match(view.error, /重试/);
  await pager.load();
  assert.deepEqual(paths.slice(1), Array(3).fill('/api/admin/daily-tasks/task-one/logs?after=1-0&snapshot=2-0'));
  assert.deepEqual(view.logs.map(item => item.id), ['1-0', '2-0']);
  assert.equal(view.error, '');
  pager.dispose();
});

test('关闭详情中止读取并忽略迟到结果，权限丢失清除日志且只回调一次', async () => {
  const gate = deferred<unknown>();
  let signal: AbortSignal | undefined;
  let updates = 0;
  const pager = new TaskLogPager(taskId, () => { updates++; }, () => assert.fail('late permission callback'), async (_path, input) => { signal = input; return gate.promise; });
  const reading = pager.load();
  const count = updates;
  pager.dispose(); gate.resolve(page()); await reading;
  assert.equal(signal?.aborted, true);
  assert.equal(updates, count);
  for (const status of [401, 403]) {
    let view = emptyTaskLogs(), lost = 0;
    const current = new TaskLogPager(taskId, next => { view = next; }, () => { lost++; }, async () => { throw new AdminRequestError(status, '需要管理员权限。'); });
    await current.load(); await current.load();
    assert.equal(lost, 1);
    assert.equal(view.logs.length, 0);
    assert.equal(view.hasMore, false);
    assert.equal(view.loading, false);
    current.dispose();
  }
});
