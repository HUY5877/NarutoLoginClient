import { useEffect, useRef, useState } from 'react';
import { emptyTaskRun, TaskRunTracker, type RunTask, type TaskRunView } from '@/lib/task-run';

export function useTaskRun(userId: string | null, session: RunTask | null, onUnauthorized: () => void) {
  const [state, setState] = useState<{ owner: string | null; view: TaskRunView }>({ owner: null, view: emptyTaskRun() });
  const tracker = useRef<TaskRunTracker | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    setState({ owner: userId, view: emptyTaskRun() });
    if (!userId) return;
    const current = new TaskRunTracker(view => setState({ owner: userId, view }), () => unauthorized.current());
    tracker.current = current;
    if (sessionRef.current) current.follow(sessionRef.current);
    else void current.restore();
    return () => { current.dispose(); if (tracker.current === current) tracker.current = null; };
  }, [userId]);

  useEffect(() => {
    if (userId && session) tracker.current?.follow(session);
  }, [userId, session?.id]);

  return { ...(userId && state.owner === userId ? state.view : emptyTaskRun()), retry: () => tracker.current?.retry() };
}
