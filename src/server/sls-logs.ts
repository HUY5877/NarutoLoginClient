import SlsClientExport, { GetLogsV2Headers, GetLogsV2Request } from '@alicloud/sls20201230';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';
import type { SlsConfig } from './config.js';
import type { TaskLog } from './task-runs.js';
import { isPublicTaskLog } from './public-task-logs.js';

// Static imports keep the SDK in Vercel's dependency trace. Native ESM exposes
// its CommonJS wrapper, while bundlers may already unwrap the default export.
const SlsClient = (SlsClientExport as unknown as { default?: typeof SlsClientExport }).default ?? SlsClientExport;

export interface SlsLogPage {
  logs: TaskLog[];
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
}
export interface TaskLogArchive {
  read(taskId: string, after: string, tail?: boolean): Promise<SlsLogPage | null>;
}
export interface SlsQueryResult { progress: string | undefined; data: unknown }
export type SlsQuery = (query: string, from: number, to: number, timeoutMs: number) => Promise<SlsQueryResult>;
const maxLong = 9223372036854775807n;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const cursor = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9][0-9]{0,18})-(0|[1-9][0-9]{0,18})$/.test(value)
  && value.split('-').every(part => BigInt(part) <= maxLong);
function compare(left: string, right: string) {
  const [lm, ls] = left.split('-').map(BigInt), [rm, rs] = right.split('-').map(BigInt);
  return lm < rm ? -1 : lm > rm ? 1 : ls < rs ? -1 : ls > rs ? 1 : 0;
}
function position(id: string) {
  const [ms, seq] = id.split('-');
  return `("streamMs" > ${ms} OR ("streamMs" = ${ms} AND "streamSeq" > ${seq}))`;
}
function integer(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function parseLog(row: Record<string, unknown>): TaskLog | null {
  if (!cursor(row.id) || typeof row.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.time)
    || !Number.isFinite(Date.parse(row.time)) || !['INFO', 'WARNING', 'ERROR'].includes(String(row.level))
    || typeof row.message !== 'string' || !row.message || [...row.message].length > 1000
    || `${row.streamMs}-${row.streamSeq}` !== row.id) return null;
  // SLS SQL serializes a missing aggregate value as the string "null".
  const missing = (v: unknown) => v === undefined || v === null || v === '' || v === 'null';
  const hasProgress = !missing(row.actionIndex) || !missing(row.actionTotal);
  const actionIndex = integer(row.actionIndex), actionTotal = integer(row.actionTotal);
  if (hasProgress && (actionIndex === null || actionTotal === null || actionIndex > actionTotal || actionTotal > 100000)) return null;
  return { id: row.id, time: row.time, level: row.level as TaskLog['level'], message: row.message,
    ...(hasProgress ? { actionIndex: actionIndex!, actionTotal: actionTotal! } : {}) };
}

/** Read the indexed body once. Empty pages can be refreshed as more logs arrive. */
export class SlsTaskLogArchive implements TaskLogArchive {
  private readonly query: SlsQuery;
  constructor(config: SlsConfig, private readonly environment: 'prod' | 'test', private readonly timeoutMs: number,
    options: { query?: SlsQuery; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    if (options.query) this.query = options.query;
    else {
      const client = new SlsClient(new $OpenApiUtil.Config({ endpoint: config.endpoint, protocol: 'https',
        accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.stsToken }));
      this.query = async (query, from, to, timeoutMs) => {
        const response = await client.getLogsV2WithOptions(config.project, config.logstore,
          new GetLogsV2Request({ from, to, query, line: 0, offset: 0, powerSql: false }),
          new GetLogsV2Headers({ acceptEncoding: 'gzip' }),
          new RuntimeOptions({ readTimeout: timeoutMs, connectTimeout: timeoutMs, autoretry: false, maxAttempts: 1 }));
        return { progress: response.body?.meta?.progress, data: response.body?.data };
      };
    }
  }
  private readonly now: () => number;

  async read(taskId: string, after: string, tail = false): Promise<SlsLogPage | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)
      || !cursor(after)) return null;
    const now = this.now();
    const from = Math.max(0, Math.floor(now / 1000) - 8 * 86400), to = Math.floor(now / 1000) + 60;
    const scoped = `"taskId" = '${taskId}' AND "environment" = '${this.environment}'`;
    const search = `taskId: "${taskId}" AND environment: "${this.environment}"`;
    const size = tail ? 10 : 100, limit = size + 1, direction = tail ? 'DESC' : 'ASC';
    // Filter invalid positions before LIMIT so a corrupt id cannot displace a
    // valid body at the same numeric position or keep an empty page repeating.
    const validPosition = `"streamMs" IS NOT NULL AND "streamSeq" IS NOT NULL AND "streamMs" >= 0 AND "streamSeq" >= 0 AND "id" = concat(cast("streamMs" AS varchar), '-', cast("streamSeq" AS varchar))`;
    const sql = `${search} AND kind: event | SELECT "id", max("taskId") AS "taskId", max("environment") AS "environment", max("time") AS "time", max("level") AS "level", max("message") AS "message", max("actionIndex") AS "actionIndex", max("actionTotal") AS "actionTotal", max("streamMs") AS "streamMs", max("streamSeq") AS "streamSeq" FROM log WHERE ${scoped} AND "kind" = 'event' AND ${validPosition} AND ${position(after)} GROUP BY "id" ORDER BY "streamMs" ${direction}, "streamSeq" ${direction} LIMIT ${limit}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: SlsQueryResult;
    try {
      result = await Promise.race([this.query(sql, from, to, this.timeoutMs), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SLS query timed out')), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    // An incomplete index can still provide useful rows. Provider/transport failures throw above.
    if (!Array.isArray(result.data) || !result.data.every(object) || result.data.length > limit) {
      throw new Error('SLS query returned invalid data');
    }
    const logs: TaskLog[] = [];
    let previous: string | undefined, nextCursor = after, truncated = false;
    for (const [index, row] of result.data.entries()) {
      if (row.taskId !== taskId || row.environment !== this.environment || !cursor(row.id)
        || `${row.streamMs}-${row.streamSeq}` !== row.id || compare(row.id, after) <= 0
        || previous !== undefined && (tail ? compare(row.id, previous) >= 0 : compare(row.id, previous) <= 0)) {
        throw new Error('SLS query returned invalid log positions');
      }
      previous = row.id;
      if (!tail && index >= size) continue;
      if (!tail || index === 0) nextCursor = row.id;
      const log = parseLog(row);
      if (!log) truncated = true;
      else if (isPublicTaskLog(log)) logs.push(log);
    }
    return { logs, nextCursor, hasMore: result.data.length > size, truncated };
  }
}
