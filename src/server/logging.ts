import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestLogContext {
  requestId: string;
  method: string;
  path: string;
  vercelRequestId?: string;
}

export interface BackendLogFields {
  component?: string;
  operation?: string;
  phase?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string;
  error?: unknown;
  timeoutMs?: number;
  storeId?: string;
  poolTotal?: number;
  poolIdle?: number;
  poolWaiting?: number;
}

export const requestLogContext = new AsyncLocalStorage<RequestLogContext>();

const token = (value: unknown): string | undefined => typeof value === 'string'
  && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

function errorCategory(code: string | undefined, message: unknown): string {
  if (code === '57014' || typeof message === 'string' && /query (?:read )?timeout|query timed out|statement timeout/i.test(message)) return 'query_timeout';
  if (typeof message === 'string' && /timeout exceeded when trying to connect|connection terminated due to connection timeout/i.test(message)) return 'connection_timeout';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'connection_timeout';
  if (code === 'ECONNRESET' || code === 'EPIPE' || typeof message === 'string' && /connection terminated unexpectedly/i.test(message)) return 'connection_reset';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failure';
  if (code === '53300') return 'connection_limit';
  if (code === '28P01' || code === '28000') return 'database_authentication';
  if (code === '42501') return 'database_permission';
  if (code === '40P01') return 'database_deadlock';
  if (code === '55P03') return 'database_lock';
  if (code?.startsWith('08')) return 'database_connection';
  if (code?.startsWith('42')) return 'database_schema_or_query';
  if (typeof message === 'string' && /request timed out/i.test(message)) return 'operation_timeout';
  return 'unclassified';
}

/** Driver messages, SQL details, headers and arbitrary properties may contain credentials or user input. */
export function safeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 3) return { category: 'cause_truncated' };
  if (!error || typeof error !== 'object') return { category: 'non_error_thrown' };
  const value = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; cause?: unknown; errors?: unknown };
  const code = token(value.code);
  const stack = typeof value.stack === 'string' ? value.stack.split('\n')
    .filter(line => /^\s+at /.test(line))
    // Keep only source filenames and line numbers, never messages, URLs or local directory names.
    .flatMap(line => {
      const match = line.match(/(?:[/\\]|\()([A-Za-z0-9_.-]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)\)?$/);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 5) : undefined;
  return {
    name: token(value.name) ?? 'Error', ...(code ? { code } : {}),
    category: errorCategory(code, value.message), ...(stack?.length ? { stack } : {}),
    ...(value.cause !== undefined ? { cause: safeError(value.cause, depth + 1) } : {}),
    ...(Array.isArray(value.errors) ? { errors: value.errors.slice(0, 3).map(item => safeError(item, depth + 1)) } : {}),
  };
}

export function logBackend(level: 'info' | 'warn' | 'error', event: string, fields: BackendLogFields = {}): void {
  // Diagnostics must never change a request's result, even when a log sink fails.
  try {
    const context = requestLogContext.getStore();
    const output: Record<string, unknown> = { time: new Date().toISOString(), level, event: token(event) ?? 'backend.log' };
    if (context) Object.assign(output, context);
    for (const key of ['component', 'operation', 'phase', 'errorCode', 'storeId'] as const) {
      const value = token(fields[key]);
      if (value !== undefined) output[key] = value;
    }
    for (const key of ['durationMs', 'status', 'timeoutMs', 'poolTotal', 'poolIdle', 'poolWaiting'] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    }
    if (fields.error !== undefined) output.error = safeError(fields.error);
    console[level](JSON.stringify(output));
  } catch { /* Best effort diagnostics. */ }
}
