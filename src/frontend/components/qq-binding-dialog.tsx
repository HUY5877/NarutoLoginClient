import { useEffect, useState } from 'react';
import { CheckCheck, CircleAlert, Copy, MessageCircle, RefreshCw, Unlink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useQqBinding } from '@/hooks/use-qq-binding';

interface Props {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnauthorized: () => void;
}

export function QqBindingDialog({ userId, open, onOpenChange, onUnauthorized }: Props) {
  const binding = useQqBinding(userId, open, onUnauthorized);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => { setCopyState('idle'); }, [userId, open, binding.code]);
  const { status, busy, loading, error, message, code, expired, remainingSeconds } = binding;
  const candidate = status?.challenge;
  const command = code ? `绑定 ${code}` : '';
  const countdown = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;

  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="auth-dialog max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-6 sm:max-w-md sm:p-7">
      <DialogHeader className="gap-3 pr-6">
        <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
          <MessageCircle className="size-5 text-primary" aria-hidden="true" />QQ 群提醒
        </DialogTitle>
        <DialogDescription className="leading-6">绑定群内身份后，机器人会在二维码就绪和任务结束时 @你。</DialogDescription>
      </DialogHeader>
      {loading && <div role="status" className="flex items-center gap-2 py-3 text-muted-foreground"><Spinner aria-hidden="true" />正在读取群提醒状态…</div>}
      {error && <Alert variant="destructive" role="alert" className="bg-white/60">
        <CircleAlert aria-hidden="true" /><AlertDescription className="space-y-2">
          <p>{error}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void binding.refresh(); }}>重试</Button>
        </AlertDescription>
      </Alert>}
      {message && <p role="status" className="flex items-center gap-2 text-sm text-primary"><CheckCheck className="size-4" aria-hidden="true" />{message}</p>}
      {!loading && status && (!status.enabled ? <div className="space-y-2 rounded-xl border bg-white/40 p-4">
        <p className="font-medium">暂未开启 QQ 群提醒</p>
        <p className="text-sm leading-6 text-muted-foreground">管理员配置群机器人后，即可在这里绑定并接收提醒。</p>
      </div> : <>
        <div className="space-y-2 rounded-xl border bg-white/40 p-4">
          <p className="font-medium">{status.binding ? '已绑定 QQ 群提醒' : '尚未绑定 QQ 群提醒'}</p>
          <p className="text-sm leading-6 text-muted-foreground">{status.binding
            ? `绑定时间：${new Date(status.binding.boundAt).toLocaleString('zh-CN', { hour12: false })}`
            : '生成绑定码，用你自己的 QQ 在机器人所在群发送绑定命令。'}</p>
          {status.binding && candidate && <p className="text-sm leading-6 text-muted-foreground">确认新绑定前，原绑定继续生效。</p>}
        </div>
        {candidate && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="font-medium">{expired ? '绑定码已过期' : candidate.received ? '等待网页确认' : '等待群内验证'}</p>
          {!expired && <p className="text-sm text-muted-foreground">绑定码剩余有效时间：<span className="tabular-nums">{countdown}</span></p>}
          {expired ? <p className="text-sm leading-6 text-muted-foreground">绑定码已过期，请重新生成。</p> : <>
            {command ? <>
              <p className="text-sm leading-6 text-muted-foreground">先从 QQ 成员列表中选择机器人完成 @，再粘贴以下命令发送：</p>
              <code className="block break-all rounded-lg border bg-white/70 px-3 py-3 text-sm font-semibold">{command}</code>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void copyCommand(); }}><Copy aria-hidden="true" />复制命令</Button>
              {copyState !== 'idle' && <p role="status" className="text-xs leading-5 text-muted-foreground">{copyState === 'copied'
                ? '命令已复制。请先在 QQ 成员列表中选择机器人完成 @，再粘贴命令发送。' : '复制失败，请长按或选中上方命令复制。'}</p>}
            </> : !candidate.received && <p className="text-sm leading-6 text-muted-foreground">请发送此前保存的命令；如果已丢失绑定码，可重新生成。</p>}
            {candidate.received && <div className="space-y-2 text-sm leading-6">
              {candidate.senderName && <p>收到群成员消息：<strong className="break-all">{candidate.senderName}</strong></p>}
              <p>请确认这条群消息由你本人发送，再点击「确认绑定」。</p>
            </div>}
          </>}
          <Button className="w-full" disabled={busy || expired || !candidate.received} onClick={() => { void binding.confirm(); }}><CheckCheck aria-hidden="true" />确认绑定</Button>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button className="min-w-0 flex-1" variant={status.binding || candidate ? 'outline' : 'default'} disabled={busy}
            onClick={() => { void binding.generate(); }}>
            {busy ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {candidate ? '重新生成绑定码' : status.binding ? '重新绑定' : '生成绑定码'}
          </Button>
          {status.binding && <Button variant="outline" disabled={busy} onClick={() => { void binding.unbind(); }}><Unlink aria-hidden="true" />解除绑定</Button>}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">绑定码 5 分钟内有效。请勿转发；重新生成后，旧码立即失效。</p>
      </>)}
    </DialogContent>
  </Dialog>;
}
