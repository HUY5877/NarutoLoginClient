import { useEffect, useRef, useState } from 'react';
import { emptyTaskLogs, TaskLogPager } from '@/lib/admin-task-logs';

export function useAdminTaskLogs(taskId: string, open: boolean, onAccessLost: () => void) {
  const [view, setView] = useState(emptyTaskLogs);
  const pager = useRef<TaskLogPager | null>(null);
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  useEffect(() => {
    setView(emptyTaskLogs());
    if (!open) return;
    const current = new TaskLogPager(taskId, setView, () => accessLost.current());
    pager.current = current;
    void current.load();
    return () => { current.dispose(); if (pager.current === current) pager.current = null; };
  }, [taskId, open]);
  return { ...view, loadMore: () => { void pager.current?.load(); } };
}
