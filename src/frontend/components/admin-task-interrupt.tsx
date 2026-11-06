import { useState } from 'react';
import { CircleStop } from 'lucide-react';
import type { DailyTask } from '../../shared/admin';
import { useAdminMutation } from '@/hooks/use-admin';
import { canInterruptDailyTask, formatAdminDate, isTaskInterruptResponse } from '@/lib/admin';
import { AdminError } from '@/components/admin-common';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function AdminTaskInterrupt({ task, onAccessLost, onSubmitted }: {
  task: DailyTask; onAccessLost: () => void; onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const mutation = useAdminMutation(onAccessLost);
  if (!canInterruptDailyTask(task.status)) return null;
  if (submitted) return <span className="self-center text-xs text-muted-foreground" role="status">中断请求已提交</span>;

  return <AlertDialog open={open} onOpenChange={next => {
    if (!mutation.busy) { setOpen(next); if (next) mutation.clearError(); }
  }}>
    <AlertDialogTrigger asChild>
      <Button type="button" variant="destructive" disabled={mutation.busy}
        aria-label={`${task.username}的中断任务`} className="min-h-11 w-full gap-2 px-3 md:w-auto md:text-xs">
        <CircleStop className="size-4" aria-hidden="true" />中断任务
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent className="auth-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>中断「{task.username}」的任务？</AlertDialogTitle>
        <AlertDialogDescription className="leading-6">
          申请时间：{formatAdminDate(task.requestedAt)}。中断请求提交后，执行端将在下一次状态更新时停止。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AdminError message={mutation.error} />
      <AlertDialogFooter>
        <AlertDialogCancel disabled={mutation.busy}>取消</AlertDialogCancel>
        <Button type="button" variant="destructive" disabled={mutation.busy} onClick={async () => {
          if (submitted || !canInterruptDailyTask(task.status)) return;
          const ok = await mutation.run(`/api/admin/daily-tasks/${encodeURIComponent(task.id)}/interrupt`, 'POST',
            undefined, result => isTaskInterruptResponse(result, task.id));
          if (ok) { setOpen(false); setSubmitted(true); onSubmitted(); }
        }}>
          {mutation.busy ? <Spinner aria-hidden="true" /> : <CircleStop aria-hidden="true" />}确认中断
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
