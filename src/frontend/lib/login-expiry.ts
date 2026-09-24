import type { Session } from '../hooks/use-login-session';
import { loginFailure } from '../../shared/task-errors';

/** Keep the last observed stage when the API or local clock ends an application. */
export function expireLoginSession(session: Session, previous: Session | null = null): Session {
  if (session.status === 'failed') return session;
  const last = session.status === 'expired' && previous?.id === session.id ? previous : session;
  const unclaimed = last.status === 'queued' || last.errorCode === 'queue_timeout';
  return { ...session, status: 'expired',
    ...(unclaimed && !session.errorCode ? loginFailure('queue_timeout') : {}) };
}
