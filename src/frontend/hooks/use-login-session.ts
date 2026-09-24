import { useCallback, useEffect, useRef, useState } from 'react';
import { loginFailure } from '../../shared/task-errors';
import { expireLoginSession } from '../lib/login-expiry';

export type SessionStatus = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'qr_ready' | 'failed' | 'expired';
export type Phase = 'idle' | 'restoring' | 'submitting' | 'query_failed' | 'login_confirmed' | SessionStatus;
export interface Session {
  id: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  simulation: boolean;
  error?: string;
  errorCode?: string;
  pollAfterMs?: number;
  showGetButton?: boolean;
}
interface ActiveResponse { session: Session | null; showGetButton: boolean }
interface PendingIntent { requestId: string; createdAt: number; expiresAt: number }
const intentLifetimeMs = 120_000;
const pendingKey = (userId: string) => `naruto-login:pending:${userId}`;
const statusLabels: Record<Phase, string> = {
  idle: '等待生成二维码', restoring: '正在查询本账户的登录申请', submitting: '正在提交已保存的登录申请',
  query_failed: '登录申请状态暂时无法确认', queued: '申请已收到，正在排队',
  starting_emulator: '正在准备独立游戏环境', opening_game: '正在打开火影忍者',
  preparing_qr: '正在准备登录二维码', qr_ready: '登录二维码已就绪', login_confirmed: '扫码授权已完成',
  failed: '这次准备未能完成', expired: '二维码已过期',
};
class RequestError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); }
}
function readPending(userId: string): PendingIntent | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(userId)) || 'null') as PendingIntent | null;
    if (!value || typeof value.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) ||
      value.createdAt > Date.now() || value.expiresAt <= Date.now()) return null;
    const expiresAt = Math.min(value.expiresAt, value.createdAt + intentLifetimeMs);
    return expiresAt > Date.now() ? { ...value, expiresAt } : null;
  } catch { return null; }
}
function clearPending(userId: string, requestId?: string) {
  try {
    if (!requestId || readPending(userId)?.requestId === requestId) localStorage.removeItem(pendingKey(userId));
  } catch { /* The server remains authoritative when storage is unavailable. */ }
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
async function request(path: string, signal: AbortSignal, init?: RequestInit) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, {
      ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new RequestError(response.status === 401 ? '请先登录账户，再查询二维码。'
        : body?.error || '暂时无法查询登录申请，请稍后重试。', response.status, body?.code);
    }
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (caught) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (caught instanceof RequestError) throw caught;
    throw new RequestError('网络暂时中断，申请状态尚未确认，请重试查询。');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}
const retryable = (caught: unknown) => caught instanceof RequestError &&
  (caught.status === 0 || caught.status === 429 || caught.status >= 500);
async function retryRead(path: string, signal: AbortSignal, onRetry: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request(path, signal); }
    catch (caught) {
      if (!retryable(caught) || attempt >= 2 || signal.aborted) throw caught;
      onRetry();
      await delay(1_000 * (attempt + 1), signal);
    }
  }
}
function validSession(value: Session): boolean {
  return typeof value?.id === 'string' && value.id.length > 0 &&
    ['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'failed', 'expired'].includes(value.status) &&
    Number.isFinite(Date.parse(value.expiresAt));
}
function isLive(value: Session | null): boolean {
  return Boolean(value && !['failed', 'expired'].includes(value.status) && Date.parse(value.expiresAt) > Date.now());
}

export function useLoginSession(userId: string | null, onUnauthorized: () => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<Session | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [showGetButton, setShowGetButton] = useState(false);
  const [pendingUntil, setPendingUntil] = useState<number | null>(null);
  const [acceptedRevision, setAcceptedRevision] = useState(0);
  const [confirmedTaskId, setConfirmedTaskId] = useState<string | null>(null);
  const confirmedTaskRef = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const qrUrlRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const runningRef = useRef(false);
  const canCreateRef = useRef(false);
  const expiryCheckedRef = useRef<number | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const replaceQr = useCallback((next: string | null) => {
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    qrUrlRef.current = next;
    setQrUrl(next);
  }, []);
  const updateAvailability = useCallback((available: boolean) => {
    canCreateRef.current = available;
    setShowGetButton(available);
  }, []);

  const run = useCallback(async (mode: 'recover' | 'query') => {
    if (!userId || runningRef.current) return;
    runningRef.current = true;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    const active = () => generationRef.current === generation && !controller.signal.aborted;
    const onRetry = () => { if (active()) setRetrying(true); };
    setOwnerId(userId);
    updateAvailability(false);
    setPhase('restoring');
    setError('');
    setRetrying(false);
    confirmedTaskRef.current = null;
    setConfirmedTaskId(null);
    replaceQr(null);
    const savedIntent = readPending(userId);
    setPendingUntil(savedIntent?.expiresAt ?? null);

    const readActive = async (): Promise<ActiveResponse> => {
      const response = await retryRead('/api/login-sessions/active', controller.signal, onRetry);
      const body = await response.json() as ActiveResponse;
      if (typeof body.showGetButton !== 'boolean' || (body.session !== null && !validSession(body.session))) {
        throw new RequestError('登录申请状态返回异常，请重试查询。');
      }
      return body;
    };
    const showInactive = (result: ActiveResponse) => {
      const outstanding = readPending(userId);
      setPendingUntil(outstanding?.expiresAt ?? null);
      if (!result.showGetButton || outstanding) {
        throw new RequestError(outstanding ? '已保存的申请仍在确认中，请稍后重试查询。' : '申请尚未结束，请稍后重试查询。');
      }
      let previous = sessionRef.current;
      if (previous && previous.status !== 'failed' && Date.parse(previous.expiresAt) <= Date.now()) {
        previous = expireLoginSession(previous);
        sessionRef.current = previous;
        setSession(previous);
      }
      setPhase(previous?.status === 'failed' ? 'failed'
        : previous && (previous.status === 'expired' || Date.parse(previous.expiresAt) <= Date.now()) ? 'expired' : 'idle');
      setError(previous?.status === 'failed' || previous?.errorCode === 'queue_timeout' ? loginFailure(previous.errorCode).error : '');
      setRetrying(false);
      updateAvailability(true);
    };
    const accept = (value: Session) => {
      if (value.status === 'expired') value = expireLoginSession(value, sessionRef.current);
      setAcceptedRevision(generation);
      sessionRef.current = value;
      setSession(value);
      setNow(Date.now());
      clearPending(userId);
      setPendingUntil(null);
      updateAvailability(false);
      return value;
    };

    try {
      let result = await readActive();
      if (!active()) return;
      let current = result.session;
      if (current) current = accept(current);
      if (!current && mode === 'recover' && savedIntent && savedIntent.expiresAt > Date.now()) {
        setPhase('submitting');
        for (let attempt = 0; ; attempt += 1) {
          try {
            const response = await request('/api/login-sessions', controller.signal, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: savedIntent.requestId }), keepalive: true,
            });
            current = await response.json() as Session;
            if (!validSession(current) || typeof current.showGetButton !== 'boolean') {
              throw new RequestError('申请已提交，状态尚未确认，请重试查询。');
            }
            break;
          } catch (caught) {
            if (!active()) return;
            if (caught instanceof RequestError && (caught.code === 'ACTIVE_LOGIN_SESSION' || retryable(caught))) {
              result = await readActive();
              current = result.session;
              if (current) break;
              if (retryable(caught) && attempt < 2 && savedIntent.expiresAt > Date.now()) {
                onRetry();
                await delay(1_000 * (attempt + 1), controller.signal);
                continue;
              }
            }
            throw caught;
          }
        }
        if (!active()) return;
        current = accept(current);
      }
      if (!active()) return;
      if (!current) { showInactive(result); return; }

      while (active()) {
        current = accept(current);
        if (!isLive(current)) {
          const ended = expireLoginSession(current);
          accept(ended);
          setPhase(ended.status);
          setError(ended.status === 'failed' || ended.errorCode === 'queue_timeout' ? loginFailure(ended.errorCode).error : '');
          setRetrying(false);
          updateAvailability(true);
          return;
        }
        const path = `/api/login-sessions/${encodeURIComponent(current.id)}`;
        const sessionId = current.id;
        setPhase(current.status === 'qr_ready' ? 'preparing_qr' : current.status);
        setRetrying(false);
        if (current.status === 'qr_ready') {
          const response = await retryRead(`${path}/qr`, controller.signal, onRetry);
          if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/png')) {
            throw new RequestError('二维码图片暂时无法读取，请重试查询。');
          }
          const blob = await response.blob();
          if (!active()) return;
          if (!isLive(current)) continue;
          if (!blob.size) throw new RequestError('二维码图片为空，请重试查询。');
          replaceQr(URL.createObjectURL(blob));
          setPhase('qr_ready');
          setRetrying(false);
          return;
        }
        const interval = Number.isFinite(current.pollAfterMs) ? Math.min(5_000, Math.max(500, current.pollAfterMs!)) : 1_000;
        await delay(interval, controller.signal);
        let response: Response;
        try { response = await retryRead(path, controller.signal, onRetry); }
        catch (caught) {
          if (!active()) return;
          if (caught instanceof RequestError && [404, 410].includes(caught.status)) {
            const ended = expireLoginSession(current);
            accept(ended);
            setPhase('expired');
            setError(ended.errorCode === 'queue_timeout' ? loginFailure(ended.errorCode).error : '');
            setRetrying(false);
            updateAvailability(true);
            return;
          }
          throw caught;
        }
        const next = await response.json() as Session;
        if (!validSession(next) || next.id !== sessionId || typeof next.showGetButton !== 'boolean') {
          throw new RequestError('登录申请状态暂时无法确认，请重试查询。');
        }
        current = next;
      }
    } catch (caught) {
      if (!active()) return;
      replaceQr(null);
      updateAvailability(false);
      if (caught instanceof RequestError && caught.status === 401) {
        setSession(null);
        sessionRef.current = null;
        setPhase('idle');
        unauthorizedRef.current();
      } else {
        setPhase('query_failed');
        setError(caught instanceof RequestError ? caught.message : '申请状态查询失败，请重试查询。');
      }
      setRetrying(false);
    } finally {
      if (generationRef.current === generation) runningRef.current = false;
    }
  }, [userId, replaceQr, updateAvailability]);

  useEffect(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    runningRef.current = false;
    expiryCheckedRef.current = null;
    replaceQr(null);
    setSession(null);
    sessionRef.current = null;
    setOwnerId(userId);
    setPhase('idle');
    setError('');
    setRetrying(false);
    setPendingUntil(null);
    setAcceptedRevision(0);
    confirmedTaskRef.current = null;
    setConfirmedTaskId(null);
    // Opening a page only resets its local view. The button initiates the
    // authoritative server check, including recovery of a saved request ID.
    updateAvailability(Boolean(userId));
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      runningRef.current = false;
      if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
      qrUrlRef.current = null;
      clearInterval(clock);
    };
  }, [userId, replaceQr, updateAvailability]);

  const expiry = session && session.id === confirmedTaskId ? null
    : pendingUntil ?? (session && !['failed', 'expired'].includes(session.status) ? Date.parse(session.expiresAt) : null);
  useEffect(() => {
    if (!userId || ownerId !== userId || !expiry || now < expiry || expiryCheckedRef.current === expiry) return;
    expiryCheckedRef.current = expiry;
    generationRef.current += 1;
    controllerRef.current?.abort();
    runningRef.current = false;
    replaceQr(null);
    if (sessionRef.current) {
      const ended = expireLoginSession(sessionRef.current);
      sessionRef.current = ended;
      setSession(ended);
    }
    setPendingUntil(null);
    setPhase('expired');
    setError(sessionRef.current?.errorCode === 'queue_timeout' ? loginFailure('queue_timeout').error : '');
    setRetrying(false);
    updateAvailability(true);
  }, [userId, ownerId, expiry, now, replaceQr, updateAvailability]);

  function startLogin() {
    if (!userId || !canCreateRef.current || runningRef.current) return;
    updateAvailability(false);
    try {
      const timestamp = Date.now();
      const intent = readPending(userId) || {
        requestId: crypto.randomUUID(), createdAt: timestamp, expiresAt: timestamp + intentLifetimeMs,
      };
      // This synchronous write precedes every await and POST, including an immediate page reload.
      localStorage.setItem(pendingKey(userId), JSON.stringify(intent));
      setPendingUntil(intent.expiresAt);
      void run('recover');
    } catch {
      setPhase('query_failed');
      setError('浏览器无法保存本次申请，请允许网站存储后重试查询。');
    }
  }
  function handleQrError() {
    if (sessionRef.current?.id === confirmedTaskRef.current) return;
    replaceQr(null);
    updateAvailability(false);
    setPhase('query_failed');
    setError('二维码图片加载失败，请重试查询。');
  }
  const confirmLogin = useCallback((taskId: string, finished = false) => {
    if (!userId || sessionRef.current?.id !== taskId) return;
    updateAvailability(finished);
    if (confirmedTaskRef.current === taskId) return;
    confirmedTaskRef.current = taskId;
    setConfirmedTaskId(taskId);
    generationRef.current += 1;
    controllerRef.current?.abort();
    runningRef.current = false;
    replaceQr(null);
    setPendingUntil(null);
    setPhase('login_confirmed');
    setError('');
    setRetrying(false);
  }, [userId, replaceQr, updateAvailability]);
  const currentOwner = Boolean(userId && ownerId === userId);
  const visiblePhase = currentOwner ? phase : 'idle';
  const visibleSession = currentOwner ? session : null;
  const pending = ['restoring', 'submitting', 'queued', 'starting_emulator', 'opening_game', 'preparing_qr'].includes(visiblePhase);
  const remainingSeconds = currentOwner && expiry ? Math.max(0, Math.ceil((expiry - now) / 1_000)) : 0;
  const countdown = `${Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:${(remainingSeconds % 60).toString().padStart(2, '0')}`;
  const canResumePending = currentOwner && pendingUntil !== null && pendingUntil > now;
  return {
    acceptedRevision: currentOwner ? acceptedRevision : 0,
    phase: visiblePhase, session: visibleSession, qrUrl: currentOwner ? qrUrl : null,
    error: currentOwner ? error : '', retrying: currentOwner && retrying, pending,
    showGetButton: currentOwner && showGetButton, canRetryQuery: currentOwner && visiblePhase === 'query_failed', canResumePending,
    remainingSeconds, countdown, isError: ['failed', 'expired', 'query_failed'].includes(visiblePhase),
    statusLabel: statusLabels[visiblePhase], startLogin, confirmLogin,
    retryQuery: () => run(userId && readPending(userId) ? 'recover' : 'query'), handleQrError,
  };
}
