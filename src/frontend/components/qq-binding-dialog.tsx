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
          <MessageCircle className="size-5 text-primary" aria-hidden="true" />QQ 机器人绑定
        </DialogTitle>
        <DialogDescription className="leading-6">将当前网站账号与自己的数字 QQ 号关联。在群里发送绑定码后自动完成绑定，无需再次确认。</DialogDescription>
      </DialogHeader>
      {loading && <div role="status" className="flex items-center gap-2 py-3 text-muted-foreground"><Spinner aria-hidden="true" />正在读取 QQ 绑定状态…</div>}
      {error && <Alert variant="destructive" role="alert" className="bg-white/60">
        <CircleAlert aria-hidden="true" /><AlertDescription className="space-y-2">
          <p>{error}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void binding.refresh(); }}>重试</Button>
        </AlertDescription>
      </Alert>}
      {message && <p role="status" className="flex items-center gap-2 text-sm text-primary"><CheckCheck className="size-4" aria-hidden="true" />{message}</p>}
      {!loading && status && (!status.enabled ? <div className="space-y-2 rounded-xl border bg-white/40 p-4">
        <p className="font-medium">暂未开启 QQ 机器人绑定</p>
        <p className="text-sm leading-6 text-muted-foreground">绑定服务暂不可用，请联系管理员配置后重试。</p>
      </div> : <>
        <div className="space-y-2 rounded-xl border bg-white/40 p-4">
          <p className="font-medium">{status.binding ? `已绑定 QQ：${status.binding.qq}` : '尚未绑定 QQ'}</p>
          <p className="text-sm leading-6 text-muted-foreground">{status.binding
            ? `绑定时间：${new Date(status.binding.boundAt).toLocaleString('zh-CN', { hour12: false })}`
            : '生成绑定码，用你自己的 QQ 在机器人所在群发送绑定命令。'}</p>
          {status.binding && candidate && <p className="text-sm leading-6 text-muted-foreground">新绑定成功前，原绑定继续生效。</p>}
        </div>
        {candidate && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="font-medium">{expired ? '绑定码已过期' : '等待机器人完成绑定'}</p>
          {!expired && <p className="text-sm text-muted-foreground">绑定码剩余有效时间：<span className="tabular-nums">{countdown}</span></p>}
          {expired ? <p className="text-sm leading-6 text-muted-foreground">绑定码已过期，请重新生成。</p> : <>
            {command ? <>
              <p className="text-sm leading-6 text-muted-foreground">当前机器人（QQ：3470367045）</p>
              <p className="text-sm leading-6 text-muted-foreground">在 QQ 群里发送这样的完整消息：</p>
              <code className="block break-all rounded-lg border bg-white/70 px-3 py-3 text-sm font-semibold"><span className="text-primary">@ 当前机器人 </span><span>{command}</span></code>
              <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                <li>在 QQ 群输入 @，从列表中选择当前机器人（QQ：3470367045）。</li>
                <li>点击「复制命令」，粘贴到 @ 后面并发送。</li>
              </ol>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void copyCommand(); }}><Copy aria-hidden="true" />复制命令</Button>
              {copyState !== 'idle' && <p role="status" className="text-xs leading-5 text-muted-foreground">{copyState === 'copied'
                ? `已复制「${command}」。请先在 QQ 群输入 @ 并选中机器人，再粘贴发送。`
                : `复制失败，请手动输入「${command}」；@ 仍需在 QQ 中选择机器人。`}</p>}
            </> : <p className="text-sm leading-6 text-muted-foreground">请发送此前保存的命令；如果已丢失绑定码，可重新生成。</p>}
          </>}
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
