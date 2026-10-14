import { useState } from 'react';
import { FileText, X } from 'lucide-react';
import { dailyStatusLabels, type DailyTask } from '../../shared/admin';
import { useAdminTaskLogs } from '@/hooks/use-admin-task-logs';
import { formatAdminDate } from '@/lib/admin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

export function AdminTaskLogDetails({ task, onAccessLost }: { task: DailyTask; onAccessLost: () => void }) {
  const [open, setOpen] = useState(false);
  const { status, logs, loading, error, loadMore, hasMore, truncated } = useAdminTaskLogs(task.id, open, onAccessLost);
  const currentStatus = status ?? task.status;
  const failed = ['failed', 'interrupted', 'expired'].includes(currentStatus);
  const failureMessage = failed ? task.errorMessage : undefined;
  const errorCode = failed ? task.errorCode : undefined;

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button type="button" variant="outline" aria-label={`${task.username}的日志详情`}
        className="min-h-11 w-full gap-2 bg-transparent px-3 md:w-auto md:text-xs">
        <FileText className="size-4" aria-hidden="true" />查看日志
      </Button>
    </DialogTrigger>
    <DialogContent showCloseButton={false}
      className="task-log-dialog flex h-[min(44rem,90dvh)] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <DialogHeader className="shrink-0 border-b px-4 py-4 pr-16">
        <DialogTitle className="text-base font-semibold">日志详情</DialogTitle>
        <DialogDescription className="text-xs [overflow-wrap:anywhere]">{task.username} · {formatAdminDate(task.requestedAt)} 申请</DialogDescription>
        <div className="pt-1"><Badge variant={failed ? 'destructive' : 'secondary'}>{dailyStatusLabels[currentStatus]}</Badge></div>
      </DialogHeader>
      <DialogClose asChild>
        <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2 z-10 size-11" aria-label="关闭日志详情"><X aria-hidden="true" /></Button>
      </DialogClose>
      <div data-slot="task-log-details-scroll" tabIndex={0} role="region" aria-label="任务执行日志"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm leading-6">
        {failureMessage && <p className="whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{failureMessage}</p>}
        {errorCode && <p className="mt-2 break-all text-xs text-muted-foreground">错误码：{errorCode}</p>}
        {loading && !logs.length && <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner aria-hidden="true" />正在读取执行日志…</p>}
        {error && <div className="mt-4 space-y-2">
          <p role="alert" className="text-destructive">{error}</p>
          <Button type="button" variant="outline" className="min-h-11" disabled={loading} onClick={loadMore}>重试读取</Button>
        </div>}
        {logs.length > 0 && <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2"><p className="font-medium">执行日志</p><span className="text-xs text-muted-foreground">已加载 {logs.length} 条</span></div>
          <ol className="space-y-3" aria-label="任务执行日志记录">
            {logs.map(log => <li key={log.id} className="min-w-0 border-l-2 border-border pl-3">
              <p className="mb-1 text-xs text-muted-foreground">{formatAdminDate(log.time)} · {log.level}</p>
              <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${log.level === 'ERROR' ? 'text-destructive' : log.level === 'WARNING' ? 'text-amber-700' : ''}`}>{log.message}</p>
            </li>)}
          </ol>
        </div>}
        {!loading && !error && !logs.length && <p className="text-muted-foreground">暂无已保留的执行日志，记录可能尚未上报或已过期。</p>}
        {truncated && <p className="mt-3 text-xs text-muted-foreground">部分记录可能已过期、被裁剪或无法读取。</p>}
        {hasMore && !error && <Button type="button" variant="outline" className="mt-4 min-h-11 w-full" disabled={loading} onClick={loadMore}>
          {loading && <Spinner aria-hidden="true" />}{logs.length ? '加载更多' : '读取日志'}
        </Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
