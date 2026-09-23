import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { PgAuthStore, type LoginEvent } from '../src/server/database.js';

interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean): void;
}
const { Pool } = createRequire(new URL('../src/server/package.json', import.meta.url))('pg') as {
  Pool: { prototype: { connect(): Promise<Client>; query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> } };
};
const owner = '10000000-0000-4000-8000-000000000001';
const otherOwner = '10000000-0000-4000-8000-000000000002';
const start = Date.parse('2026-09-23T00:00:00.000Z');
const date = (offset = 0) => new Date(start + offset);

function candidate(sequence = 1, userId = owner, offset = 0): LoginEvent {
  return {
    id: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    userId, requestId: `request-${sequence}`, status: 'queued', accessToken: 'ab'.repeat(32),
    createdAt: date(offset).toISOString(), expiresAt: date(offset + 120000).toISOString(),
    dispatchedAt: null, finishedAt: null,
  };
}

type Row = Omit<LoginEvent, 'createdAt' | 'expiresAt' | 'dispatchedAt' | 'finishedAt'> & {
  createdAt: Date; expiresAt: Date; dispatchedAt: Date | null; finishedAt: Date | null;
};
interface Operation { client: number; sql: string; values: unknown[] }

// Model PostgreSQL row locking, ownership filters and row results without opening a socket.
function fixture(t: TestContext) {
  const rows = new Map<string, Row>();
  const operations: Operation[] = [];
  const locks = new Map<string, Promise<void>>();
  const releases = new Map<number, () => void>();
  const owners = new Set([owner, otherOwner]);
  let connections = 0;

  const query = async (client: number, text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    operations.push({ client, sql, values });
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      releases.get(client)?.(); releases.delete(client);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM naruto_login.users')) {
      assert.match(sql, /WHERE id = \$1 FOR UPDATE$/);
      const userId = String(values[0]);
      if (!owners.has(userId)) return { rows: [] };
      const previous = locks.get(userId) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      locks.set(userId, pending);
      await previous;
      releases.set(client, release);
      return { rows: [{ id: userId }] };
    }
    if (sql.startsWith("UPDATE naruto_login.login_events SET status = 'expired'")) {
      assert.match(sql, /WHERE user_id = \$1 AND finished_at IS NULL AND expires_at <= \$2$/);
      for (const row of rows.values()) {
        if (row.userId === values[0] && row.finishedAt === null && row.expiresAt <= (values[1] as Date)) {
          row.status = 'expired'; row.finishedAt = values[1] as Date;
        }
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM naruto_login.login_events')) {
      let matches: Row[];
      if (sql.includes('request_id = $2')) matches = [...rows.values()].filter(row => row.userId === values[0] && row.requestId === values[1]);
      else if (sql.includes('WHERE id = $1 AND user_id = $2')) matches = [...rows.values()].filter(row => row.id === values[0] && row.userId === values[1]);
      else {
        assert.match(sql, /WHERE user_id = \$1 AND finished_at IS NULL AND expires_at > \$2$/);
        matches = [...rows.values()].filter(row => row.userId === values[0] && row.finishedAt === null && row.expiresAt > (values[1] as Date));
      }
      return { rows: matches.map(row => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO naruto_login.login_events')) {
      assert.ok(releases.has(client), 'the user row must remain locked through insertion');
      const [id, userId, requestId, status, accessToken, createdAt, expiresAt, dispatchedAt, finishedAt] = values as
        [string, string, string, LoginEvent['status'], string, Date, Date, Date | null, Date | null];
      if ([...rows.values()].some(row => row.userId === userId && (row.requestId === requestId || row.finishedAt === null && finishedAt === null))) {
        throw new Error('unique constraint violation');
      }
      const row: Row = { id, userId, requestId, status, accessToken, createdAt, expiresAt, dispatchedAt, finishedAt };
      rows.set(id, row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE naruto_login.login_events SET dispatched_at')) {
      assert.match(sql, /SET dispatched_at = COALESCE\(dispatched_at, \$3\) WHERE id = \$1 AND user_id = \$2$/);
      const row = rows.get(String(values[0]));
      if (row && row.userId === values[1]) row.dispatchedAt ??= values[2] as Date;
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE naruto_login.login_events SET status = CASE')) {
      assert.match(sql, /WHERE id = \$1 AND user_id = \$2 AND finished_at IS NULL/);
      assert.match(sql, /status NOT IN \('qr_ready', 'failed', 'expired'\)/);
      assert.match(sql, /OR \$3 IN \('failed', 'expired'\)\)$/);
      assert.doesNotMatch(sql, /SET[\s\S]*expires_at\s*=/);
      const row = rows.get(String(values[0]));
      const status = values[2] as LoginEvent['status'];
      const at = values[3] as Date;
      if (row && row.userId === values[1] && row.finishedAt === null &&
        (row.expiresAt <= at || !['qr_ready', 'failed', 'expired'].includes(row.status) || ['failed', 'expired'].includes(status))) {
        row.status = row.expiresAt <= at ? 'expired' : status;
        row.finishedAt = row.expiresAt <= at || ['failed', 'expired'].includes(status) ? at : null;
      }
      return { rows: [] };
    }
    return { rows: [] };
  };

  t.mock.method(Pool.prototype, 'connect', async () => {
    const client = ++connections;
    return {
      query: (sql: string, values?: unknown[]) => query(client, sql, values),
      release() { assert.equal(releases.has(client), false, 'transaction must release its row lock before returning the connection'); },
    };
  });
  t.mock.method(Pool.prototype, 'query', (sql: string, values?: unknown[]) => query(0, sql, values));
  const store = new PgAuthStore('postgresql://fixture:fixture@127.0.0.1:5432/fixture');
  t.after(() => store.close());
  return { store, rows, operations };
}

test('事件表保留请求幂等约束和每账号唯一有效事件约束，初始化只执行一次', async t => {
  const { store, operations } = fixture(t);
  await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
  await store.getActive(owner, date());
  const setup = operations.filter(operation => operation.sql.includes('CREATE TABLE IF NOT EXISTS naruto_login.login_events'));
  assert.equal(setup.length, 1);
  assert.match(setup[0].sql, /UNIQUE \(user_id, request_id\)/);
  assert.match(setup[0].sql, /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON naruto_login.login_events \(user_id\) WHERE finished_at IS NULL/);
  assert.match(setup[0].sql, /user_id uuid NOT NULL REFERENCES naruto_login.users\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(setup[0].sql, /DROP |TRUNCATE |ALTER /);
});

test('同账号的八个并发预留在用户行锁后只创建一条事件，返回同一任务和凭据', async t => {
  const { store, rows, operations } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.reserve(candidate(index + 1), date())));
  assert.equal(rows.size, 1);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  for (const result of results) assert.deepEqual(result, results[0]);
  const reserveConnections = operations.filter(operation => operation.sql.includes('FROM naruto_login.users')).map(operation => operation.client);
  assert.equal(reserveConnections.length, 8);
  for (const client of reserveConnections) {
    const steps = operations.filter(operation => operation.client === client);
    assert.equal(steps[0].sql, 'BEGIN');
    assert.match(steps[1].sql, /FOR UPDATE$/);
    assert.match(steps[2].sql, /^UPDATE naruto_login.login_events/);
    assert.match(steps[3].sql, /request_id = \$2$/);
    assert.match(steps[4].sql, /finished_at IS NULL AND expires_at > \$2$/);
    assert.equal(steps.at(-1)?.sql, 'COMMIT');
  }
  const insert = operations.find(operation => operation.sql.startsWith('INSERT INTO naruto_login.login_events'))!;
  assert.ok(!insert.sql.includes(candidate().accessToken));
  assert.equal(insert.values[4], candidate().accessToken);
});

test('过期请求编号始终返回原事件，优先级高于新的有效事件，不重新插入任务', async t => {
  const { store, rows } = fixture(t);
  const first = await store.reserve(candidate(), date());
  const retry = { ...candidate(2, owner, 120000), requestId: first.requestId };
  const expired = await store.reserve(retry, date(120000));
  assert.equal(rows.size, 1);
  assert.equal(expired.id, first.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expiresAt, first.expiresAt);
  assert.equal(expired.finishedAt, date(120000).toISOString());
  const next = await store.reserve(candidate(3, owner, 120000), date(120000));
  assert.notEqual(next.id, first.id);
  assert.equal(rows.size, 2);
  assert.deepEqual(await store.reserve(retry, date(120001)), expired);
  assert.equal((await store.getActive(owner, date(120001)))?.id, next.id);
});

test('同一请求编号可用于不同账号，事件和恢复查询始终按账号隔离', async t => {
  const { store, rows } = fixture(t);
  const first = await store.reserve(candidate(), date());
  const second = await store.reserve({ ...candidate(2, otherOwner), requestId: first.requestId }, date());
  assert.equal(rows.size, 2);
  assert.equal((await store.getActive(owner, date()))?.id, first.id);
  assert.equal((await store.getActive(otherOwner, date()))?.id, second.id);
  assert.equal(await store.getEvent(first.id, otherOwner), null);
  assert.deepEqual(await store.getEvent(first.id, owner), first);
  assert.equal(await store.getActive(owner, date(120000)), null);
  const expired = await store.getEvent(first.id, owner);
  assert.equal(expired?.status, 'expired');
  assert.equal(expired?.createdAt, first.createdAt);
  assert.equal(expired?.expiresAt, first.expiresAt);
});

test('分发时间仅记录第一次成功投递，更新必须匹配事件所属账号', async t => {
  const { store } = fixture(t);
  const first = await store.reserve(candidate(), date());
  await store.markDispatched(first.id, otherOwner, date(1));
  assert.equal((await store.getEvent(first.id, owner))?.dispatchedAt, null);
  await store.markDispatched(first.id, owner, date(2));
  await store.markDispatched(first.id, owner, date(3));
  const dispatched = await store.getEvent(first.id, owner);
  assert.equal(dispatched?.dispatchedAt, date(2).toISOString());
  assert.equal(dispatched?.expiresAt, first.expiresAt);
});

test('就绪事件不能回退到排队或准备状态，到期标记结束后不能复活', async t => {
  const { store } = fixture(t);
  const first = await store.reserve(candidate(), date());
  await store.updateStatus(first.id, owner, 'qr_ready', date(100));
  await store.updateStatus(first.id, owner, 'queued', date(200));
  await store.updateStatus(first.id, owner, 'preparing_qr', date(300));
  await store.updateStatus(first.id, otherOwner, 'expired', date(400));
  const ready = await store.getEvent(first.id, owner);
  assert.equal(ready?.status, 'qr_ready');
  assert.equal(ready?.finishedAt, null);
  assert.equal((await store.reserve(candidate(2), date(500))).id, first.id);
  await store.updateStatus(first.id, owner, 'queued', date(120000));
  await store.updateStatus(first.id, owner, 'qr_ready', date(120001));
  const expired = await store.getEvent(first.id, owner);
  assert.equal(expired?.status, 'expired');
  assert.equal(expired?.finishedAt, date(120000).toISOString());
  assert.equal(expired?.expiresAt, first.expiresAt);
});

test('就绪事件收到工作进程失败状态后结束，释放有效事件唯一约束以便立即重试', async t => {
  const { store } = fixture(t);
  const first = await store.reserve(candidate(), date());
  await store.updateStatus(first.id, owner, 'qr_ready', date(100));
  await store.updateStatus(first.id, owner, 'failed', date(200));
  const failed = await store.getEvent(first.id, owner);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.finishedAt, date(200).toISOString());
  assert.equal(failed?.expiresAt, first.expiresAt);
  assert.equal(await store.getActive(owner, date(300)), null);
  for (const status of ['queued', 'preparing_qr', 'qr_ready'] as const) {
    await store.updateStatus(first.id, owner, status, date(400));
    assert.deepEqual(await store.getEvent(first.id, owner), failed);
  }
  const replacement = await store.reserve(candidate(2), date(500));
  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.status, 'queued');
  assert.equal((await store.getActive(owner, date(600)))?.id, replacement.id);
});

test('失败事件记录结束时间且不被迟到响应复活，新请求可创建新事件', async t => {
  const { store } = fixture(t);
  const first = await store.reserve(candidate(), date());
  await store.updateStatus(first.id, owner, 'failed', date(100));
  await store.updateStatus(first.id, owner, 'queued', date(200));
  await store.updateStatus(first.id, owner, 'qr_ready', date(300));
  const failed = await store.getEvent(first.id, owner);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.finishedAt, date(100).toISOString());
  assert.equal(failed?.expiresAt, first.expiresAt);
  assert.notEqual((await store.reserve(candidate(2), date(400))).id, first.id);
  assert.equal((await store.reserve(candidate(), date(500))).id, first.id);
});

test('不存在的账号无法预留事件，事务回滚且没有创建孤立记录', async t => {
  const { store, rows, operations } = fixture(t);
  await assert.rejects(store.reserve(candidate(1, '10000000-0000-4000-8000-000000000003'), date()), /account does not exist/);
  assert.equal(rows.size, 0);
  assert.equal(operations.at(-1)?.sql, 'ROLLBACK');
});

test('共享存储初始化失败后可重试，不缓存失败 Promise', async t => {
  let attempts = 0;
  const released: boolean[] = [];
  t.mock.method(Pool.prototype, 'connect', async () => ({
    async query(sql: string) {
      if (sql.includes('CREATE TABLE') && ++attempts === 1) throw new Error('temporary setup failure');
      return { rows: [] };
    },
    release(destroy?: boolean) { released.push(Boolean(destroy)); },
  }));
  const store = new PgAuthStore('postgresql://fixture:fixture@127.0.0.1:5432/fixture');
  try {
    await assert.rejects(store.initialize(), /temporary setup failure/);
    await Promise.all([store.initialize(), store.initialize()]);
    await store.initialize();
    assert.equal(attempts, 2);
    assert.deepEqual(released, [true, false]);
  } finally { await store.close(); }
});
