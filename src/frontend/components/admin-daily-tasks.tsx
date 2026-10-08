import { useState } from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { dailyStatusLabels, type DailyStatus } from '../../shared/admin';
import { useAdminData } from '@/hooks/use-admin';
import { formatAdminDate, isDailyPage } from '@/lib/admin';
import { AdminError, AdminLoading, AdminPagination } from '@/components/admin-common';
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
  const { data, loading, error, reload } = useAdminData(open ? `/api/admin/daily-tasks?page=${page}` : null, isDailyPage, onAccessLost);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="auth-dialog flex max-h-[88svh] flex-col gap-5 p-5 sm:max-w-5xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-7">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><CalendarCheck className="size-5 text-primary" aria-hidden="true" />今日刷日常情况</DialogTitle>
        <DialogDescription className="leading-6">查看今天申请的日常任务，每次申请单独展示。时间均为北京时间。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Badge variant="outline" className="bg-white/35 px-3 py-1.5 font-normal">{data?.date ?? '今日'} · {data ? `${data.total} 次申请` : '日常任务'}</Badge>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => { void reload(); }}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
        </Button>
      </div>
      <AdminError message={error} />
      <div className="min-h-0 overflow-y-auto" aria-busy={loading}>
        {loading && !data && <AdminLoading label="正在读取今日任务…" />}
        {data && data.items.length > 0 && <div className="overflow-hidden rounded-xl border bg-white/35">
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
                  {task.status === 'failed' && <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button type="button" aria-label={`${task.username}的失败详情`}
                        className="cursor-help rounded-sm text-xs text-destructive underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                        详情
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content side="top" align="end" sideOffset={6} collisionPadding={12}
                        className="z-[60] max-w-[min(22rem,calc(100vw-2rem))] rounded-lg border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-md">
                        <p className="whitespace-pre-wrap break-words">{task.errorMessage?.trim() || '未记录具体错误原因。'}</p>
                        {task.errorCode && <p className="mt-1 break-all text-muted-foreground">错误码：{task.errorCode}</p>}
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>}
                </span>
              </TableCell>
            </TableRow>)}</TableBody>
          </Table>
          </Tooltip.Provider>
        </div>}
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
