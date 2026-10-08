import { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest, AdminRequestError } from '@/lib/admin';

export function useAdminData<T>(path: string | null, validate: (value: unknown) => value is T, onAccessLost: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const body = await adminRequest(path, controller.signal);
      if (request.current !== controller) return;
      if (!validate(body)) throw new Error('返回信息异常，请刷新后重试。');
      setData(body);
    } catch (caught) {
      if (request.current !== controller) return;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) { onAccessLost(); return; }
      setError(caught instanceof Error && !['AbortError', 'TimeoutError'].includes(caught.name)
        ? caught.message : '读取超时，请检查网络后刷新。');
    } finally { if (request.current === controller) setLoading(false); }
  }, [path, validate, onAccessLost]);
  useEffect(() => {
    setData(null); setError('');
    void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load]);
  return { data, loading, error, reload: load };
}

export function useAdminMutation(onAccessLost: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  async function run(path: string, method: string, body?: unknown, validate?: (value: unknown) => boolean) {
    if (request.current) return false;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await adminRequest(path, controller.signal, method, body);
      if (request.current !== controller) return false;
      if (validate && !validate(result)) throw new Error('操作结果尚未确认，请刷新列表查看。');
      return true;
    } catch (caught) {
      if (request.current !== controller) return false;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) { onAccessLost(); return false; }
      setError(caught instanceof Error && !['AbortError', 'TimeoutError'].includes(caught.name)
        ? caught.message : '请求超时，操作可能已完成，请取消并刷新列表确认结果。');
      return false;
    } finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return { run, busy, error, clearError: () => setError('') };
}
