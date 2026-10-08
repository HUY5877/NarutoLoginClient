import { useCallback, useState } from 'react';
import { Tooltip } from 'radix-ui';
import type { DailyTask, DailyTaskFailureDetails } from '../../shared/admin';
import { useAdminData } from '@/hooks/use-admin';
import { formatAdminDate, isDailyTaskFailureDetails } from '@/lib/admin';
import { Spinner } from '@/components/ui/spinner';

export function AdminTaskFailureDetails({ task, onAccessLost, portalContainer }: {
  task: DailyTask; onAccessLost: () => void; portalContainer: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const validate = useCallback((value: unknown): value is DailyTaskFailureDetails =>
    isDailyTaskFailureDetails(value) && value.taskId === task.id, [task.id]);
  const { data, loading, error } = useAdminData(open
    ? `/api/admin/daily-tasks/${encodeURIComponent(task.id)}/failure-details` : null, validate, onAccessLost);

  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger asChild>
      <button type="button" aria-label={`${task.username}的失败详情`}
        className="cursor-help rounded-sm text-xs text-destructive underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
        详情
      </button>
    </Tooltip.Trigger>
    {/* Keep long logs inside the modal's scroll boundary, outside the clipped table. */}
    <Tooltip.Portal container={portalContainer}>
      <Tooltip.Content side="top" align="end" sideOffset={6} collisionPadding={12}
        className="z-[60] max-h-[min(65vh,28rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-lg border bg-popover px-4 py-3 text-xs leading-5 text-popover-foreground shadow-md">
        {data?.actionName && <p className="mb-2 break-words font-medium">失败步骤：{data.actionName}
          {data.actionIndex !== undefined && data.actionTotal !== undefined && `（${data.actionIndex}/${data.actionTotal}）`}</p>}
        {!data?.actionName && data?.actionIndex !== undefined && data.actionTotal !== undefined &&
          <p className="mb-2 font-medium">失败步骤：第 {data.actionIndex} / {data.actionTotal} 个动作</p>}
        <p className="whitespace-pre-wrap break-words text-destructive">{data?.errorMessage || task.errorMessage?.trim() || '未记录具体错误原因。'}</p>
        {(data?.errorCode || task.errorCode) && <p className="mt-1 break-all text-muted-foreground">错误码：{data?.errorCode || task.errorCode}</p>}
        {loading && <p role="status" className="mt-3 flex items-center gap-2 text-muted-foreground"><Spinner aria-hidden="true" />正在读取错误日志…</p>}
        {error && <p role="alert" className="mt-3 text-destructive">{error} 将鼠标移开后重新悬停可重试。</p>}
        {data && <div className="mt-3 border-t pt-2">
          <p className="mb-2 font-medium">相关执行日志</p>
          {data.logs.length ? <ol className="space-y-2" aria-label="失败任务近期日志">
            {data.logs.map(log => <li key={log.id} className="border-l-2 border-border pl-2">
              <p className="text-[11px] text-muted-foreground">{formatAdminDate(log.time)} · {log.level}</p>
              <p className={`whitespace-pre-wrap break-words ${log.level === 'ERROR' ? 'text-destructive' : ''}`}>{log.message}</p>
            </li>)}
          </ol> : <p className="text-muted-foreground">未保留执行日志，无法还原具体失败过程。</p>}
          {data.truncated && <p className="mt-2 text-muted-foreground">日志可能不完整，仅展示已保留的近期记录。</p>}
        </div>}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
