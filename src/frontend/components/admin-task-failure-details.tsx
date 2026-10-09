import { useCallback, useState } from 'react';
import { Tooltip } from 'radix-ui';
import { ChevronRight, X } from 'lucide-react';
import type { DailyTask, DailyTaskFailureDetails } from '../../shared/admin';
import { useAdminData } from '@/hooks/use-admin';
import { useMediaQuery } from '@/hooks/use-media-query';
import { formatAdminDate, isDailyTaskFailureDetails } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

export function AdminTaskFailureDetails({ task, onAccessLost, portalContainer }: {
  task: DailyTask; onAccessLost: () => void; portalContainer: HTMLElement | null;
}) {
  const hoverDetails = useMediaQuery('(min-width: 768px) and (hover: hover) and (pointer: fine)');
  // Remount when the interaction mode changes, releasing focus and pending reads.
  return <FailureDetails key={String(hoverDetails)} task={task} onAccessLost={onAccessLost}
    portalContainer={portalContainer} hoverDetails={hoverDetails} />;
}

function FailureDetails({ task, onAccessLost, portalContainer, hoverDetails }: {
  task: DailyTask; onAccessLost: () => void; portalContainer: HTMLElement | null; hoverDetails: boolean;
}) {
  const [open, setOpen] = useState(false);
  const validate = useCallback((value: unknown): value is DailyTaskFailureDetails =>
    isDailyTaskFailureDetails(value) && value.taskId === task.id, [task.id]);
  const { data, loading, error, reload } = useAdminData(open
    ? `/api/admin/daily-tasks/${encodeURIComponent(task.id)}/failure-details` : null, validate, onAccessLost);

  const contents = <>
    {data?.actionName && <p className="mb-2 font-medium [overflow-wrap:anywhere]">失败步骤：{data.actionName}
      {data.actionIndex !== undefined && data.actionTotal !== undefined && `（${data.actionIndex}/${data.actionTotal}）`}</p>}
    {!data?.actionName && data?.actionIndex !== undefined && data.actionTotal !== undefined &&
      <p className="mb-2 font-medium">失败步骤：第 {data.actionIndex} / {data.actionTotal} 个动作</p>}
    <p className="whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{data?.errorMessage || task.errorMessage?.trim() || '未记录具体错误原因。'}</p>
    {(data?.errorCode || task.errorCode) && <p className="mt-2 break-all text-xs text-muted-foreground">错误码：{data?.errorCode || task.errorCode}</p>}
    {loading && <p role="status" className="mt-4 flex items-center gap-2 text-muted-foreground"><Spinner aria-hidden="true" />正在读取错误日志…</p>}
    {error && <div className="mt-4 space-y-2">
      <p role="alert" className="text-destructive">{error}</p>
      <Button type="button" variant="outline" className="min-h-11" disabled={loading} onClick={() => { void reload(); }}>重试读取</Button>
    </div>}
    {data && <div className="mt-4 border-t pt-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">相关执行日志</p>
        {data.logs.length > 0 && <span className="text-xs text-muted-foreground">最近 {data.logs.length} 条</span>}
      </div>
      {data.logs.length ? <ol className="space-y-3" aria-label="失败任务近期日志">
        {data.logs.map(log => <li key={log.id} className="min-w-0 border-l-2 border-border pl-3">
          <p className="mb-1 text-xs text-muted-foreground">{formatAdminDate(log.time)} · {log.level}</p>
          <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${log.level === 'ERROR' ? 'text-destructive' : ''}`}>{log.message}</p>
        </li>)}
      </ol> : <p className="text-muted-foreground">未保留执行日志，无法还原具体失败过程。</p>}
      {data.truncated && <p className="mt-3 text-xs text-muted-foreground">日志可能不完整，仅展示已保留的近期记录。</p>}
    </div>}
  </>;

  if (!hoverDetails) return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button type="button" variant="outline" aria-label={`${task.username}的失败详情`}
        className="min-h-11 w-full justify-between border-destructive/20 bg-transparent px-3 text-destructive md:w-auto">
        查看失败详情<ChevronRight aria-hidden="true" />
      </Button>
    </DialogTrigger>
    <DialogContent showCloseButton={false} className="task-failure-dialog flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogHeader className="shrink-0 border-b px-4 py-4 pr-16">
        <DialogTitle className="text-base font-semibold">失败详情</DialogTitle>
        <DialogDescription className="text-xs [overflow-wrap:anywhere]">{task.username} · {formatAdminDate(task.requestedAt)} 申请</DialogDescription>
      </DialogHeader>
      <DialogClose asChild>
        <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2 size-11" aria-label="关闭失败详情"><X aria-hidden="true" /></Button>
      </DialogClose>
      <div data-slot="failure-details-scroll" tabIndex={0} role="region" aria-label="失败详情与最近日志"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm leading-6">
        {contents}
      </div>
    </DialogContent>
  </Dialog>;

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
        {contents}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
