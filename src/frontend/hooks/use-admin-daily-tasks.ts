import { useCallback, useEffect, useRef, useState } from 'react';
import { withDailyTaskRun, type DailyTaskRun, type DailyTaskPage } from '../../shared/admin';
import { adminRequest, AdminRequestError, isDailyPage, isDailyTaskRunPage } from '@/lib/admin';

interface TaskList { path: string; data: DailyTaskPage }
const errorMessage = (error: unknown) => error instanceof Error && !['AbortError', 'TimeoutError'].includes(error.name)
  ? error.message : '读取超时，请检查网络后刷新。';

/** A modal owns one filtered application list; page changes read only its current runs. */
export function useAdminDailyTasks(path: string | null, page: number, onAccessLost: () => void) {
  const [list, setList] = useState<TaskList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [settledRuns, setSettledRuns] = useState<{ source: TaskList; page: number; refresh: number } | null>(null);
  const [runError, setRunError] = useState('');
  const [runRefresh, setRunRefresh] = useState(0);
  const [known, setKnown] = useState<{ path: string; runs: Map<string, DailyTaskRun> } | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const runRequest = useRef<AbortController | null>(null);
  const current = path && list?.path === path ? list : null;
  const currentPage = current ? Math.min(page, Math.max(1, Math.ceil(current.data.total / 20))) : 1;
  const statusLoading = runLoading || Boolean(current?.data.items.length
    && (settledRuns?.source !== current || settledRuns.page !== currentPage || settledRuns.refresh !== runRefresh));

  const reload = useCallback(async () => {
    listRequest.current?.abort(); runRequest.current?.abort(); runRequest.current = null;
    setList(previous => previous?.path === path ? previous : null);
    setKnown(previous => previous?.path === path ? previous : null);
    setListError(''); setRunError(''); setRunLoading(false);
    if (!path) { setSettledRuns(null); setListLoading(false); return; }
    const controller = new AbortController(); listRequest.current = controller;
    setListLoading(true);
    try {
      const body = await adminRequest(path, controller.signal);
      if (listRequest.current !== controller) return;
      if (!isDailyPage(body)) throw new Error('返回信息异常，请刷新后重试。');
      const query = new URLSearchParams(path.split('?')[1]);
      if ((body.selectedDate ?? 'all') !== (query.get('date') ?? 'all')
        || (body.mainTask ?? 'daily') !== query.get('mainTask')) throw new Error('返回信息异常，请刷新后重试。');
      setList({ path, data: body });
    } catch (error) {
      if (listRequest.current !== controller) return;
      if (error instanceof AdminRequestError && [401, 403].includes(error.status)) { onAccessLost(); return; }
      setListError(errorMessage(error));
    } finally { if (listRequest.current === controller) setListLoading(false); }
  }, [path, onAccessLost]);

  useEffect(() => {
    void reload();
    return () => {
      listRequest.current?.abort(); listRequest.current = null;
      runRequest.current?.abort(); runRequest.current = null;
    };
  }, [reload]);

  useEffect(() => {
    runRequest.current?.abort(); runRequest.current = null;
    setRunError(''); setRunLoading(false);
    if (!current) return;
    const source = current;
    const items = source.data.items.slice((currentPage - 1) * 20, currentPage * 20);
    if (!items.length) return;
    const ids = items.map(item => item.id);
    const controller = new AbortController(); runRequest.current = controller;
    setRunLoading(true);
    void (async () => {
      try {
        const body = await adminRequest(`/api/admin/daily-tasks/runs?ids=${encodeURIComponent(ids.join(','))}`, controller.signal);
        if (runRequest.current !== controller) return;
        if (!isDailyTaskRunPage(body, ids)) throw new Error('返回信息异常，请刷新后重试。');
        setKnown(previous => {
          const runs = new Map(previous?.path === source.path ? previous.runs : []);
          body.items.forEach(({ id, run }) => { if (run) runs.set(id, run); });
          return { path: source.path, runs };
        });
      } catch (error) {
        if (runRequest.current !== controller) return;
        if (error instanceof AdminRequestError && [401, 403].includes(error.status)) { onAccessLost(); return; }
        setRunError(errorMessage(error));
      } finally {
        if (runRequest.current === controller) {
          setSettledRuns({ source, page: currentPage, refresh: runRefresh });
          setRunLoading(false);
        }
      }
    })();
    return () => { controller.abort(); if (runRequest.current === controller) runRequest.current = null; };
  }, [current, currentPage, runRefresh, onAccessLost]);

  const data = current ? { ...current.data, page: currentPage,
    items: current.data.items.slice((currentPage - 1) * 20, currentPage * 20)
      .map(item => withDailyTaskRun(item, known?.path === current.path ? known.runs.get(item.id) ?? null : null)) } : null;
  return { data, loading: listLoading || statusLoading, listLoading, statusLoading, error: listError || runError,
    reload, reloadRuns: () => setRunRefresh(value => value + 1) };
}
