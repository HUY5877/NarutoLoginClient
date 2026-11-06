import { useEffect, useRef, useState } from 'react';
import { CheckCheck, CircleAlert, MessageCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { confirmMcpBinding, McpBindingUnauthorized, previewMcpBinding, type McpBindingPreview } from '@/lib/mcp-bindings';

interface Props {
  user: { id: string; username: string } | null;
  authLoading: boolean;
  loginOpen: boolean;
  onLogin: () => void;
  onUnauthorized: () => void;
}

function readToken() {
  const match = /^#mcp-bind=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

function clearHash(token: string | null) {
  if (token && window.location.hash === `#mcp-bind=${token}`) {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }
}

export function McpBindingDialog(props: Props) {
  const [token, setToken] = useState(readToken);
  const [success, setSuccess] = useState<{ userId: string; username: string; qq: string } | null>(null);
  useEffect(() => {
    const changed = () => { setToken(readToken()); setSuccess(null); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => { setSuccess(null); }, [props.user?.id]);
  const completed = success?.userId === props.user?.id ? success : null;
  const cancel = () => { clearHash(token); setToken(null); setSuccess(null); };
  const open = Boolean(token || completed) && !props.loginOpen;
  return <Dialog open={open} onOpenChange={value => { if (!value) cancel(); }}>
    <DialogContent className="auth-dialog max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-6 sm:max-w-md sm:p-7">
      <DialogHeader className="gap-3 pr-6">
        <DialogTitle className="flex items-center gap-2 text-xl font-semibold"><MessageCircle className="size-5 text-primary" aria-hidden="true" />确认 QQ 绑定</DialogTitle>
        <DialogDescription className="leading-6">确认后，机器人可通过此 QQ 号识别你的网站账号。请核对两个账号都属于你本人。</DialogDescription>
      </DialogHeader>
      {completed ? <>
        <p role="status" className="flex items-center gap-2 font-medium text-primary"><CheckCheck className="size-4" aria-hidden="true" />绑定成功</p>
        <p className="break-all leading-6">QQ {completed.qq} 已绑定到 {completed.username}。</p>
        <Button onClick={cancel}>完成</Button>
      </> : token && !props.loginOpen && <BindingConfirmation key={`${token}:${props.user?.id ?? ''}:${props.authLoading}`}
        {...props} token={token} onCancel={cancel} onSuccess={qq => {
          if (!props.user) return;
          clearHash(token); setToken(null);
          setSuccess({ userId: props.user.id, username: props.user.username, qq });
        }} />}
    </DialogContent>
  </Dialog>;
}

function BindingConfirmation({ user, authLoading, token, onLogin, onUnauthorized, onCancel, onSuccess }:
  Props & { token: string; onCancel: () => void; onSuccess: (qq: string) => void }) {
  const [preview, setPreview] = useState<McpBindingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  async function request(confirm = false) {
    if (!user || authLoading || unauthorized || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => mounted.current && active.current === controller && !controller.signal.aborted;
    setBusy(true); setError('');
    try {
      if (confirm) {
        const result = await confirmMcpBinding(token, user.id, controller.signal);
        if (!current()) return;
        if (result.userId !== user.id || result.qq !== preview?.qq) throw new Error('绑定结果与当前账号不一致，请重新核对。');
        onSuccess(result.qq);
      } else {
        const result = await previewMcpBinding(token, controller.signal);
        if (current()) setPreview(result);
      }
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof McpBindingUnauthorized) {
        setPreview(null); setUnauthorized(true); unauthorizedRef.current();
      } else setError(caught instanceof Error && caught.name !== 'TypeError' ? caught.message : '绑定服务连接失败，请重试。');
    } finally {
      if (current()) { active.current = null; setBusy(false); }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void request();
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, []);

  return <>
    {authLoading ? <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner aria-hidden="true" />正在确认登录状态…</p>
      : !user || unauthorized ? <div className="space-y-4">
        <p className="font-medium">登录网站账号后确认绑定</p>
        <Button className="w-full" onClick={onLogin}>登录网站账号</Button>
      </div> : <>
        {busy && !preview && <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner aria-hidden="true" />正在读取绑定信息…</p>}
        {error && <Alert variant="destructive" role="alert" className="bg-white/60"><CircleAlert aria-hidden="true" /><AlertDescription className="space-y-2">
          <p>{error}</p><Button variant="outline" size="sm" disabled={busy} onClick={() => { setPreview(null); void request(); }}>重试</Button>
        </AlertDescription></Alert>}
        {preview && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <dl className="space-y-3"><div><dt className="text-sm text-muted-foreground">QQ 号</dt><dd className="break-all font-medium">{preview.qq}</dd></div>
            <div><dt className="text-sm text-muted-foreground">当前网站账号</dt><dd className="break-all font-medium">{user.username}</dd></div></dl>
          <p className="text-xs leading-5 text-muted-foreground">链接有效期至 {new Date(preview.expiresAt).toLocaleString('zh-CN', { hour12: false })}。请勿转发此链接。</p>
          <Button className="w-full" disabled={busy || Boolean(error)} onClick={() => { void request(true); }}>{busy && <Spinner aria-hidden="true" />}确认绑定</Button>
        </div>}
      </>}
    <Button variant="outline" onClick={onCancel}>取消</Button>
  </>;
}
