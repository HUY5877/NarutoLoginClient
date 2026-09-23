import { useCallback, useEffect, useRef, useState } from 'react';

export type SessionStatus =
  | 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr'
  | 'qr_ready' | 'failed' | 'expired';
export type Phase = 'idle' | 'restoring' | 'submitting' | SessionStatus;

export interface Session {
  id: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  simulation: boolean;
  error?: string;
  pollAfterMs?: number;
}

const sessionChangedKey = 'naruto-login:session-changed';
const statusLabels: Record<Phase, string> = {
  idle: '等待生成二维码', restoring: '正在恢复本账户的登录申请', submitting: '正在创建登录申请',
  queued: '申请已收到，正在排队', starting_emulator: '正在准备独立游戏环境',
  opening_game: '正在打开火影忍者', preparing_qr: '正在准备登录二维码',
  qr_ready: '模拟二维码已就绪', failed: '这次准备未能完成', expired: '二维码已过期',
};

class RequestError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); }
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
  const timeoutController = new AbortController();
  const onAbort = () => timeoutController.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = window.setTimeout(() => timeoutController.abort(), 10_000);
  try {
    const response = await fetch(path, {
      ...init, credentials: 'same-origin', cache: 'no-store', signal: timeoutController.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      const message = response.status === 401 ? '请先登录账户，再获取二维码。'
        : response.status === 404 || response.status === 410 ? '登录申请已过期，请重新生成二维码。'
          : body?.error || '暂时无法连接登录服务，请稍后重试。';
      throw new RequestError(message, response.status, body?.code);
    }
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (caught) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (caught instanceof RequestError) throw caught;
    throw new RequestError('登录服务连接超时或网络中断，请稍后重试。');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

async function retryRead(path: string, signal: AbortSignal, onRetry: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request(path, signal); }
    catch (caught) {
      const retryable = caught instanceof RequestError &&
        (caught.status === 0 || caught.status === 429 || caught.status >= 500);
      if (!retryable || attempt >= 2 || signal.aborted) throw caught;
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

export function useLoginSession(userId: string | null, onUnauthorized: () => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<Session | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const qrUrlRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const replaceQr = useCallback((next: string | null) => {
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    qrUrlRef.current = next;
    setQrUrl(next);
  }, []);

  const run = useCallback(async (create: boolean) => {
    if (!userId || submittingRef.current || qrUrlRef.current) return;
    submittingRef.current = true;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    const active = () => generationRef.current === generation && !controller.signal.aborted;
    const onRetry = () => { if (active()) setRetrying(true); };
    setOwnerId(userId);
    setPhase(create ? 'submitting' : 'restoring');
    setSession(null);
    setError('');
    setRetrying(false);
    replaceQr(null);

    const readActive = async () => {
      const response = await retryRead('/api/login-sessions/active', controller.signal, onRetry);
      const body = await response.json() as { session: Session | null };
      if (body.session !== null && !validSession(body.session)) {
        throw new RequestError('登录状态暂时不可用，请稍后重试。');
      }
      return body.session;
    };

    try {
      let current = await readActive();
      if (!active()) return;
      if (!current && create) {
        try {
          const response = await request('/api/login-sessions', controller.signal, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          current = await response.json() as Session;
        } catch (caught) {
          // A concurrent page or a lost response can already own the account's task.
          if (caught instanceof RequestError &&
            (caught.code === 'ACTIVE_LOGIN_SESSION' || caught.status === 0)) {
            current = await readActive();
            if (!current) throw caught;
          } else throw caught;
        }
        if (!validSession(current)) throw new RequestError('登录服务返回了无效信息，请重试。');
        try { localStorage.setItem(sessionChangedKey, `${userId}:${Date.now()}`); }
        catch { /* Focus synchronization also restores tasks. */ }
      }
      if (!active()) return;
      if (!current) { setPhase('idle'); setRetrying(false); return; }
      const sessionId = current.id;
      const path = `/api/login-sessions/${encodeURIComponent(sessionId)}`;
      const pollInterval = Number.isFinite(current.pollAfterMs)
        ? Math.min(5_000, Math.max(500, current.pollAfterMs!)) : 1_000;

      while (active()) {
        setSession(current);
        setNow(Date.now());
        if (Date.now() >= Date.parse(current.expiresAt) || current.status === 'expired') {
          setPhase('expired'); break;
        }
        if (current.status === 'failed') {
          throw new RequestError(current.error || '游戏环境暂时未能准备完成，请重新生成二维码。');
        }
        setPhase(current.status === 'qr_ready' ? 'preparing_qr' : current.status);
        setRetrying(false);
        if (current.status === 'qr_ready') {
          const response = await retryRead(`${path}/qr`, controller.signal, onRetry);
          if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/png')) {
            throw new RequestError('二维码格式异常，请重试。');
          }
          const blob = await response.blob();
          if (!active()) return;
          if (Date.now() >= Date.parse(current.expiresAt)) { setPhase('expired'); break; }
          if (!blob.size) throw new RequestError('二维码图片为空，请重试。');
          replaceQr(URL.createObjectURL(blob));
          setPhase('qr_ready');
          setRetrying(false);
          break;
        }
        await delay(pollInterval, controller.signal);
        const response = await retryRead(path, controller.signal, onRetry);
        current = await response.json() as Session;
        if (!validSession(current) || current.id !== sessionId) {
          throw new RequestError('登录状态暂时不可用，请重试。');
        }
      }
    } catch (caught) {
      if (!active()) return;
      replaceQr(null);
      if (caught instanceof RequestError && caught.status === 401) {
        setSession(null);
        setPhase('idle');
        unauthorizedRef.current();
      } else {
        setPhase(caught instanceof RequestError && [404, 410].includes(caught.status) ? 'expired' : 'failed');
        setError(caught instanceof RequestError ? caught.message : '登录状态读取失败，请重试。');
      }
      setRetrying(false);
    } finally {
      if (generationRef.current === generation) submittingRef.current = false;
    }
  }, [userId, replaceQr]);

  useEffect(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    submittingRef.current = false;
    replaceQr(null);
    setSession(null);
    setOwnerId(userId);
    setPhase('idle');
    setError('');
    setRetrying(false);
    if (userId) void run(false);
    const onFocus = () => { if (userId) void run(false); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === sessionChangedKey && event.newValue?.startsWith(`${userId}:`)) void run(false);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      submittingRef.current = false;
      if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
      qrUrlRef.current = null;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, run, replaceQr]);

  useEffect(() => {
    if (!session || phase === 'expired' || phase === 'failed') return;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp >= Date.parse(session.expiresAt)) {
        generationRef.current += 1;
        controllerRef.current?.abort();
        submittingRef.current = false;
        replaceQr(null);
        setPhase('expired');
        setRetrying(false);
      }
    };
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => clearInterval(interval);
  }, [session, phase, replaceQr]);

  function handleQrError() {
    replaceQr(null);
    setPhase('failed');
    setError('二维码图片加载失败，请重试。');
  }

  const currentOwner = Boolean(userId && ownerId === userId);
  const visiblePhase = currentOwner ? phase : 'idle';
  const visibleSession = currentOwner ? session : null;
  const pending = ['restoring', 'submitting', 'queued', 'starting_emulator', 'opening_game', 'preparing_qr'].includes(visiblePhase);
  const remainingSeconds = visibleSession ? Math.max(0, Math.ceil((Date.parse(visibleSession.expiresAt) - now) / 1_000)) : 0;
  const countdown = `${Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:${(remainingSeconds % 60).toString().padStart(2, '0')}`;

  return {
    phase: visiblePhase, session: visibleSession, qrUrl: currentOwner ? qrUrl : null,
    error: currentOwner ? error : '', retrying: currentOwner && retrying, pending,
    remainingSeconds, countdown, isError: visiblePhase === 'failed' || visiblePhase === 'expired',
    statusLabel: statusLabels[visiblePhase], startLogin: () => run(true), handleQrError,
  };
}
