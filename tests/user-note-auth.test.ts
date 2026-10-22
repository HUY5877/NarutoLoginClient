import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { AuthService } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { PgAuthStore, type StoredUser, type UserChanges } from '../src/server/database.js';
import { ApiError } from '../src/server/errors.js';

const serverRequire = createRequire(new URL('../src/server/package.json', import.meta.url));
const { decodeJwt } = serverRequire('jose') as typeof import('../src/server/node_modules/jose/dist/types/index.d.ts');
const { Pool } = serverRequire('pg') as { Pool: { prototype: {
  connect(): Promise<{ query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
} } };

test('管理员修改备注后原用户名仍可登录，备注不能登录且不出现在公开用户或 JWT 中', async t => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
    JWT_SECRET: 'user-note-auth-fixture-secret-'.repeat(2) });
  const now = new Date('2026-10-22T00:00:00.000Z');
  const adminId = '10000000-0000-4000-8000-000000000001';
  const row: StoredUser & { note: string; createdAt: Date; applicationStatus: null } = {
    id: '10000000-0000-4000-8000-000000000002', username: 'Naruto_Account', usernameKey: 'naruto_account',
    password: 'note-auth-password', isAdmin: false, isInvalid: false, note: 'OldRemark',
    createdAt: now, applicationStatus: null,
  };
  const privateNote = 'PrivateRemark';
  const columns = { username: 'username', username_key: 'usernameKey', password: 'password',
    is_invalid: 'isInvalid', is_admin: 'isAdmin', admin_note: 'note' } as const;
  async function query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.endsWith('FOR SHARE')) return { rows: values[0] === adminId ? [{ id: adminId }] : [] };
    if (sql.startsWith('UPDATE naruto_login.users')) {
      // Apply actual SQL bindings so accidentally writing the note into username_key breaks authentication.
      for (const [column, property] of Object.entries(columns)) {
        const binding = new RegExp(`\\b${column} = (?:COALESCE\\()?\\$(\\d+)`).exec(sql);
        if (binding) {
          const value = values[Number(binding[1]) - 1];
          if (value !== null && value !== undefined) Object.assign(row, { [property]: value });
        }
      }
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('SELECT u.id, u.username, u.username_key')) {
      assert.match(sql, /WHERE u\.username_key = \$1$/);
      assert.doesNotMatch(sql, /admin_note/);
      const { note: _note, ...stored } = row;
      return { rows: values[0] === row.usernameKey ? [stored] : [] };
    }
    if (sql.startsWith('SELECT id, username, is_admin')) {
      assert.doesNotMatch(sql, /admin_note/);
      return { rows: values[0] === row.id && !row.isInvalid ? [{ id: row.id, username: row.username, isAdmin: row.isAdmin }] : [] };
    }
    return { rows: [] };
  }
  t.mock.method(Pool.prototype, 'connect', async () => ({ query, release() {} }));
  t.mock.method(Pool.prototype, 'query', query);
  const store = new PgAuthStore(config.databaseUrl!);
  const auth = new AuthService(config, { store, now: () => now.getTime() });
  t.after(() => auth.close());
  const before = await auth.login({ username: 'NARUTO_ACCOUNT', password: row.password });
  const changes: UserChanges & { note: string } = { username: 'Naruto_Account', usernameKey: 'naruto_account',
    isAdmin: false, isInvalid: false, note: privateNote };
  const updated = await store.updateUser(adminId, row.id, changes, now);
  assert.equal((updated as { note?: string }).note, privateNote);
  const loggedIn = await auth.login({ username: 'NARUTO_ACCOUNT', password: row.password });
  await assert.rejects(auth.login({ username: privateNote, password: row.password }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'INVALID_CREDENTIALS');
    return true;
  });
  for (const user of [loggedIn.user, await auth.getUser(loggedIn.token), await auth.getUser(before.token)]) {
    assert.deepEqual(user, { id: row.id, username: 'Naruto_Account', isAdmin: false });
  }
  const claims = decodeJwt(loggedIn.token);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
  assert.doesNotMatch(JSON.stringify({ user: loggedIn.user, claims }), /PrivateRemark|admin_note|"note"/);
});
