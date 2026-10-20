import { createRequire } from 'node:module';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';
import type { SlsConfig } from './config.js';
import type { TaskLog } from './task-runs.js';

// The generated SDK exports a CommonJS `default`; unwrap it explicitly for native ESM and Vercel.
const { default: SlsClient, GetLogsV2Headers, GetLogsV2Request } = createRequire(import.meta.url)('@alicloud/sls20201230') as typeof import('@alicloud/sls20201230');

export interface SlsLogPage {
  logs: TaskLog[];
  snapshotCursor: string;
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
}
export interface TaskLogArchive {
  read(taskId: string, after: string, snapshot: string | undefined, watermark: string | undefined, tail?: boolean): Promise<SlsLogPage | null>;
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
function position(id: string, operator: '>' | '>=' | '<=') {
  const [ms, seq] = id.split('-');
  const outer = operator === '<=' ? '<' : '>';
  return `("streamMs" ${outer} ${ms} OR ("streamMs" = ${ms} AND "streamSeq" ${operator} ${seq}))`;
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
  const missing = (v: unknown) => v === undefined || v === null || v === '';
  const hasProgress = !missing(row.actionIndex) || !missing(row.actionTotal);
  const actionIndex = integer(row.actionIndex), actionTotal = integer(row.actionTotal);
  if (hasProgress && (actionIndex === null || actionTotal === null || actionIndex > actionTotal || actionTotal > 100000)) return null;
  return { id: row.id, time: row.time, level: row.level as TaskLog['level'], message: row.message,
    ...(hasProgress ? { actionIndex: actionIndex!, actionTotal: actionTotal! } : {}) };
}

/** Complete alone cannot prove ingestion: validate the producer's checkpoint range and the run watermark too. */
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

  async read(taskId: string, after: string, snapshot: string | undefined, watermark: string | undefined, tail = false): Promise<SlsLogPage | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)
      || !cursor(after) || snapshot !== undefined && !cursor(snapshot)) return null;
    const now = this.now(), deadline = Date.now() + this.timeoutMs;
    const from = Math.max(0, Math.floor(now / 1000) - 8 * 86400), to = Math.floor(now / 1000) + 60;
    const scoped = `"taskId" = '${taskId}' AND "environment" = '${this.environment}'`;
    const search = `taskId: "${taskId}" AND environment: "${this.environment}"`;
    const execute = async (sql: string): Promise<Array<Record<string, unknown>> | null> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([this.query(sql, from, to, remaining), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SLS query timed out')), remaining);
        })]);
        if (result.progress !== 'Complete' || !Array.isArray(result.data) || !result.data.every(object)) return null;
        return result.data;
      } finally { clearTimeout(timer); }
    };
    const markers = await execute(`${search} AND kind: checkpoint | SELECT DISTINCT "taskId", "environment", "firstId", "throughId", "entryCount", "truncated", "streamMs", "streamSeq" FROM log WHERE ${scoped} AND "kind" = 'checkpoint' ORDER BY "streamMs" DESC, "streamSeq" DESC LIMIT 10`);
    if (!markers?.length) return null;
    const valid = markers.filter(row => row.taskId === taskId && row.environment === this.environment
      && cursor(row.firstId) && cursor(row.throughId) && compare(row.firstId, row.throughId) <= 0
      && `${row.streamMs}-${row.streamSeq}` === row.throughId && integer(row.entryCount) !== null && Number(row.entryCount) > 0
      && ['true', 'false'].includes(String(row.truncated)));
    valid.sort((a, b) => compare(b.throughId as string, a.throughId as string)
      || compare(a.firstId as string, b.firstId as string)
      || Number(String(b.truncated) === 'true') - Number(String(a.truncated) === 'true'));
    const marker = valid[0];
    if (!marker) return null;
    const first = marker.firstId as string, through = marker.throughId as string;
    const upper = snapshot ?? watermark ?? through;
    if (!cursor(upper) || compare(upper, through) > 0 || compare(after, upper) > 0) return null;
    const window = `${position(first, '>=')} AND ${position(through, '<=')}`;
    const producer = `("firstId" = '${first}' OR "firstId" IS NULL)`;
    const pageWindow = `${position(after, '>')} AND ${position(upper, '<=')}`;
    // A restarted producer starts a new checkpoint range. Validate that range without excluding older producers' logs.
    const counts = await execute(`${search} AND kind: event | SELECT count(DISTINCT CASE WHEN ${window} AND ${producer} THEN "id" END) AS "entryCount", count(DISTINCT CASE WHEN ${pageWindow} THEN "id" END) AS "remainingCount" FROM log WHERE ${scoped} AND "kind" = 'event'`);
    if (counts?.length !== 1 || integer(counts[0].entryCount) !== Number(marker.entryCount)) return null;
    const remaining = integer(counts[0].remainingCount);
    if (remaining === null) return null;
    const limit = tail ? 11 : 101, direction = tail ? 'DESC' : 'ASC';
    const rows = await execute(`${search} AND kind: event | SELECT "id", max("taskId") AS "taskId", max("environment") AS "environment", max("time") AS "time", max("level") AS "level", max("message") AS "message", max("actionIndex") AS "actionIndex", max("actionTotal") AS "actionTotal", max("streamMs") AS "streamMs", max("streamSeq") AS "streamSeq" FROM log WHERE ${scoped} AND "kind" = 'event' AND ${pageWindow} GROUP BY "id" ORDER BY "streamMs" ${direction}, "streamSeq" ${direction} LIMIT ${limit}`);
    if (!rows || rows.length !== Math.min(limit, remaining)) return null;
    const logs: TaskLog[] = [];
    for (const row of rows) {
      if (row.taskId !== taskId || row.environment !== this.environment) return null;
      const log = parseLog(row);
      if (!log || compare(log.id, after) <= 0 || compare(log.id, upper) > 0
        || logs.length && (tail ? compare(log.id, logs.at(-1)!.id) >= 0 : compare(log.id, logs.at(-1)!.id) <= 0)) return null;
      logs.push(log);
    }
    const hasMore = remaining > (tail ? 10 : 100);
    return { logs: tail ? logs : logs.slice(0, 100), snapshotCursor: upper,
      nextCursor: hasMore && !tail ? logs[99].id : upper, hasMore,
      truncated: valid.some(value => String(value.truncated) === 'true') };
  }
}
