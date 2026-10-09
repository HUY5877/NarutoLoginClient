import { useState } from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { dailyStatusLabels, type DailyStatus } from '../../shared/admin';
import { useAdminData } from '@/hooks/use-admin';
import { useMediaQuery } from '@/hooks/use-media-query';
import { formatAdminDate, isDailyPage } from '@/lib/admin';
import { AdminError, AdminLoading, AdminPagination } from '@/components/admin-common';
import { AdminTaskFailureDetails } from '@/components/admin-task-failure-details';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function statusVariant(status: DailyStatus) {
  return status === 'completed' ? 'default' : ['failed', 'interrupted'].includes(status) ? 'destructive' : 'secondary';
}
export function AdminDailyTasks({ open, onOpenChange, onAccessLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAccessLost: () => void; returnFocus: () => void;
}) {
  const [page, setPage] = useState(1);
  const [dialogContent, setDialogContent] = useState<HTMLDivElement | null>(null);
  const showTable = useMediaQuery('(min-width: 768px)');
  const { data, loading, error, reload } = useAdminData(open ? `/api/admin/daily-tasks?page=${page}` : null, isDailyPage, onAccessLost);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent ref={setDialogContent} className="auth-dialog daily-tasks-dialog flex max-h-[88dvh] flex-col gap-5 p-5 sm:max-w-5xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-10">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><CalendarCheck className="size-5 text-primary" aria-hidden="true" />今日刷日常情况</DialogTitle>
        <DialogDescription className="leading-6">查看今天申请的日常任务，每次申请单独展示。时间均为北京时间。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Badge variant="outline" className="bg-white/35 px-3 py-1.5 font-normal">{data?.date ?? '今日'} · {data ? `${data.total} 次申请` : '日常任务'}</Badge>
        <Button type="button" variant="outline" size="sm" className="min-h-11 px-3 md:min-h-0" disabled={loading} onClick={() => { void reload(); }}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
        </Button>
      </div>
      <AdminError message={error} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading}>
        {loading && !data && <AdminLoading label="正在读取今日任务…" />}
        {data && data.items.length > 0 && (showTable ? <div className="overflow-hidden rounded-xl border bg-white/35">
          <Tooltip.Provider delayDuration={200}>
          <Table className="min-w-190">
            <TableCaption className="sr-only">今日刷日常情况，所有时间均为北京时间</TableCaption>
            <TableHeader className="bg-secondary/50"><TableRow>
              <TableHead className="pl-4">用户名</TableHead><TableHead>申请时间</TableHead>
              <TableHead>扫描完成时间</TableHead><TableHead>脚本执行完成时间</TableHead><TableHead className="pr-4">任务状态</TableHead>
            </TableRow></TableHeader>
            <TableBody>{data.items.map(task => <TableRow key={task.id}>
              <TableCell className="max-w-44 truncate py-4 pl-4 font-medium" title={task.username}>{task.username}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.requestedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.scannedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.completedAt)}</TableCell>
              <TableCell className="pr-4">
                <span className="inline-flex items-center gap-1.5">
                  <Badge variant={statusVariant(task.status)}>{dailyStatusLabels[task.status]}</Badge>
                  {task.status === 'failed' && <AdminTaskFailureDetails task={task} onAccessLost={onAccessLost} portalContainer={dialogContent} />}
                </span>
              </TableCell>
            </TableRow>)}</TableBody>
          </Table>
          </Tooltip.Provider>
        </div> : <ul aria-label="今日任务列表" className="space-y-3">
          {data.items.map(task => <li key={task.id} className="rounded-xl border bg-white/45 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <span className="min-w-0 break-all text-sm font-semibold">{task.username}</span>
              <Badge variant={statusVariant(task.status)} className="shrink-0">{dailyStatusLabels[task.status]}</Badge>
            </div>
            <dl className="space-y-2 text-xs leading-5">
              {([
                ['申请时间', task.requestedAt], ['扫码完成', task.scannedAt], ['执行完成', task.completedAt],
              ] as const).map(([label, value]) => <div key={label} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums [overflow-wrap:anywhere]">{value ? <time dateTime={value}>{formatAdminDate(value)}</time> : '—'}</dd>
              </div>)}
            </dl>
            {task.status === 'failed' && <div className="mt-3 border-t pt-3">
              <AdminTaskFailureDetails task={task} onAccessLost={onAccessLost} portalContainer={dialogContent} />
            </div>}
          </li>)}
        </ul>)}
        {!loading && data?.items.length === 0 && <Empty className="py-12">
          <EmptyHeader><EmptyMedia variant="icon" className="bg-white/40"><CalendarCheck aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{data.total ? '本页暂无任务' : '今天还没有日常申请'}</EmptyTitle>
            <EmptyDescription>{data.total ? '返回上一页查看任务。' : '用户申请后，刷新即可查看扫码与执行情况。'}</EmptyDescription>
          </EmptyHeader>
        </Empty>}
      </div>
      {data && <AdminPagination page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPageChange={setPage} />}
    </DialogContent>
  </Dialog>;
}
