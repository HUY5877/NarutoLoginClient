/** Canonical lifecycle stored in runs; QR deadlines only apply before authorization. */
export type RunStatus = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'waiting_scan'
  | 'finishing_login' | 'running_daily' | 'completed' | 'failed' | 'interrupted' | 'expired';
export const RUN_RETENTION_MS = 604_800_000;
export const runStatuses = new Set<RunStatus>(['queued', 'starting_emulator', 'opening_game', 'preparing_qr',
  'waiting_scan', 'finishing_login', 'running_daily', 'completed', 'failed', 'interrupted', 'expired']);
export const terminalRun = (status: string) => ['completed', 'failed', 'interrupted', 'expired'].includes(status);
export function canonicalStatus(status: string): RunStatus {
  return (status === 'qr_ready' ? 'waiting_scan' : status) as RunStatus;
}
export function effectiveRunStatus(record: { status: string; loginAuthorized?: boolean; authorizedAt?: unknown;
  startedAt?: unknown; loginExpiresAt?: string; expiresAt?: string }, now: number): RunStatus {
  const status = canonicalStatus(record.status);
  if (terminalRun(status) || status === 'finishing_login' || status === 'running_daily') return status;
  if (record.loginAuthorized === true || typeof record.authorizedAt === 'string' || typeof record.startedAt === 'string') {
    return typeof record.startedAt === 'string' ? 'running_daily' : 'finishing_login';
  }
  const deadline = record.loginExpiresAt ?? record.expiresAt;
  return deadline && Date.parse(deadline) <= now ? 'expired' : status;
}
