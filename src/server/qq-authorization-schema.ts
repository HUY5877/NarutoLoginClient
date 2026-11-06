import { qqUnavailable } from './qq-authorization-data.js';

interface SchemaClient { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
const common = ['id', 'owner_id', 'app_id', 'openid_fingerprint', 'label', 'account_hint', 'captured_at', 'expires_at', 'updated_at'];
const encrypted = ['ciphertext', 'nonce', 'auth_tag', 'encryption_version'];
const plain = ['access_token', 'openid', 'callback_url'];
const columnType = (name: string) => name === 'id' || name === 'owner_id' ? 'uuid'
  : ['captured_at', 'expires_at', 'updated_at'].includes(name) ? 'timestamp with time zone'
  : ['ciphertext', 'nonce', 'auth_tag'].includes(name) ? 'bytea' : name === 'encryption_version' ? 'smallint' : 'text';

/** Both stores call this inside their schema transaction, before either creates a table. */
export async function prepareQqAuthorizationTables(client: SchemaClient, appEnv: 'test' | 'prod' = 'prod'): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_authorizations.schema.v2'))");
  const result = await client.query(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'naruto_login' AND table_name IN ('qq_authorizations', 'qq_authorizations_encrypted')`);
  const columns = (name: string) => new Map(result.rows.filter(row => row.table_name === name).map(row => [String(row.column_name), row]));
  const source = columns('qq_authorizations'), legacy = columns('qq_authorizations_encrypted');
  const matches = (actual: Map<string, Record<string, unknown>>, required: string[], excluded: string[]) =>
    actual.size === common.length + required.length && [...common, ...required].every(name => {
      const row = actual.get(name); return row?.data_type === columnType(name) && row.is_nullable === 'NO';
    }) && excluded.every(name => !actual.has(name));
  if (appEnv === 'test' && legacy.size && !matches(legacy, encrypted, plain)) throw qqUnavailable();
  if (!source.size || matches(source, plain, encrypted)) return;
  if (appEnv !== 'test' || !matches(source, encrypted, plain) || legacy.size) throw qqUnavailable();
  const database = await client.query('SELECT current_database() AS database');
  if (database.rows[0]?.database !== 'naruto_login_test') throw qqUnavailable();

  // This is the historical test schema. Rename atomically; never decrypt, copy or rewrite its rows.
  const indexes = await client.query(`SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'naruto_login'
    AND indexname IN ('qq_authorizations_owner_updated_idx', 'qq_authorizations_encrypted_owner_updated_idx')`);
  if (indexes.rows.some(row => row.indexname === 'qq_authorizations_encrypted_owner_updated_idx'
    || row.indexname === 'qq_authorizations_owner_updated_idx' && row.tablename !== 'qq_authorizations')) throw qqUnavailable();
  await client.query('ALTER TABLE naruto_login.qq_authorizations RENAME TO qq_authorizations_encrypted');
  await client.query('ALTER INDEX IF EXISTS naruto_login.qq_authorizations_owner_updated_idx RENAME TO qq_authorizations_encrypted_owner_updated_idx');
}
