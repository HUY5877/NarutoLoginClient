import { useEffect, useState } from 'react';
import { CalendarCheck, Check, RefreshCw } from 'lucide-react';
import type { DailyStatus } from '../../shared/admin';
import { DEFAULT_LOGIN_TYPE, loginTypeLabels } from '../../shared/login-types';
import type { MainTask } from '../../shared/user-options';
import { useAdminData } from '@/hooks/use-admin';
import { useMediaQuery } from '@/hooks/use-media-query';
import { adminTaskStatusLabel, formatAdminDate, isDailyPage } from '@/lib/admin';
import { AdminError, AdminLoading, AdminPagination } from '@/components/admin-common';
import { AdminTaskLogDetails } from '@/components/admin-task-log-details';
import { AdminTaskInterrupt } from '@/components/admin-task-interrupt';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function statusVariant(status: DailyStatus) {
  return status === 'completed' ? 'default' : ['failed', 'interrupted'].includes(status) ? 'destructive' : 'secondary';
}
const beijingToday = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
export function AdminDailyTasks({ open, onOpenChange, onAccessLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAccessLost: () => void; returnFocus: () => void;
}) {
  const [page, setPage] = useState(1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [mainTask, setMainTask] = useState<MainTask>('daily');
  const [notice, setNotice] = useState('');
  const [today, setToday] = useState(beijingToday);
  const showTable = useMediaQuery('(min-width: 768px)');
  useEffect(() => {
    setNotice('');
    if (open) {
      const date = beijingToday();
      setToday(date); setSelectedDate(date); setMainTask('daily'); setPage(1);
    } else setSelectedDate(null);
  }, [open]);
  const { data: response, loading, error, reload } = useAdminData(open && selectedDate
    ? `/api/admin/daily-tasks?page=${page}${selectedDate === 'all' ? '' : `&date=${selectedDate}`}&mainTask=${mainTask}` : null, isDailyPage, onAccessLost);
  const data = response?.page === page && (response.selectedDate ?? 'all') === selectedDate
    && (response.mainTask ?? 'daily') === mainTask ? response : null;
  useEffect(() => { if (response?.date) setToday(response.date); }, [response?.date]);
  const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(today) - index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const dateLabel = selectedDate === 'all' ? `${dates[6]} — ${today}` : selectedDate ?? today;
  const taskLabel = mainTask === 'arena_weekly' ? '周胜' : '日常';
  function interruptionSubmitted(username: string) {
    setNotice(`已提交「${username}」的中断请求。执行端将在下一次状态更新时停止。`);
    void reload();
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="auth-dialog daily-tasks-dialog flex max-h-[88dvh] flex-col gap-5 p-5 sm:max-w-6xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-10">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><CalendarCheck className="size-5 text-primary" aria-hidden="true" />近七天扫码情况</DialogTitle>
        <DialogDescription className="leading-6">按日期和任务类型查看扫码申请。每次申请单独展示，时间均为北京时间。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="grid w-full grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-2 md:flex md:w-auto md:gap-3">
          <Select value={selectedDate ?? today} onValueChange={value => { setSelectedDate(value); setPage(1); setNotice(''); }}>
            <SelectTrigger aria-label="查看日期" className="min-h-11 w-full min-w-0 bg-white/35 md:min-h-0 md:w-46"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="all" className="min-h-11 md:min-h-0">全部七天</SelectItem>
              {dates.map((date, index) => <SelectItem key={date} value={date} className="min-h-11 md:min-h-0">
                {date}{index === 0 ? '（今天）' : index === 1 ? '（昨天）' : ''}
              </SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={mainTask} onValueChange={value => { setMainTask(value as MainTask); setPage(1); setNotice(''); }}>
            <SelectTrigger aria-label="任务类型" className="min-h-11 w-full min-w-0 bg-white/35 md:min-h-0 md:w-32"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="daily" className="min-h-11 md:min-h-0">刷日常</SelectItem>
              <SelectItem value="arena_weekly" className="min-h-11 md:min-h-0">刷周胜</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground" aria-live="polite">{dateLabel} · {data ? `${data.total} 次申请` : `刷${taskLabel}`}</span>
        <Button type="button" variant="outline" size="sm" className="ml-auto min-h-11 px-3 md:min-h-0" disabled={loading} onClick={() => { void reload(); }}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
        </Button>
      </div>
      <AdminError message={error} />
      {notice && <Alert role="status" className="shrink-0 border-primary/20 bg-white/40"><Check aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading}>
        {loading && !data && <AdminLoading label={selectedDate === 'all' ? '正在读取近七天任务…' : '正在读取当天任务…'} />}
        {data && data.items.length > 0 && (showTable ? <div className="overflow-hidden rounded-xl border bg-white/35">
          <Table className="min-w-260">
            <TableCaption className="sr-only">近七天扫码情况 · 刷{taskLabel}，所有时间均为北京时间</TableCaption>
            <TableHeader className="bg-secondary/50"><TableRow>
              <TableHead className="pl-4">用户</TableHead><TableHead>登录渠道</TableHead><TableHead>申请时间</TableHead>
              <TableHead>扫描完成时间</TableHead><TableHead>脚本执行完成时间</TableHead><TableHead>任务状态</TableHead><TableHead className="pr-4">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>{data.items.map(task => <TableRow key={task.id}>
              <TableCell className="max-w-44 py-4 pl-4">
                <div className="truncate font-medium" title={task.note?.trim() || task.username}>{task.note?.trim() || task.username}</div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">{loginTypeLabels[task.loginType ?? DEFAULT_LOGIN_TYPE]}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.requestedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.scannedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(task.completedAt)}</TableCell>
              <TableCell><Badge variant={statusVariant(task.status)}>{adminTaskStatusLabel(task.status, task.mainTask)}</Badge></TableCell>
              <TableCell className="pr-4"><div className="flex items-center gap-2">
                <AdminTaskLogDetails task={task} onAccessLost={onAccessLost} />
                <AdminTaskInterrupt task={task} onAccessLost={onAccessLost} onSubmitted={() => interruptionSubmitted(task.username)} />
              </div></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div> : <ul aria-label="近七天任务列表" className="space-y-3">
          {data.items.map(task => <li key={task.id} className="rounded-xl border bg-white/45 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <span className="min-w-0 break-all text-sm font-semibold">{task.note?.trim() || task.username}</span>
              <Badge variant={statusVariant(task.status)} className="shrink-0">{adminTaskStatusLabel(task.status, task.mainTask)}</Badge>
            </div>
            <dl className="space-y-2 text-xs leading-5">
              <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">登录渠道</dt>
                <dd className="text-right">{loginTypeLabels[task.loginType ?? DEFAULT_LOGIN_TYPE]}</dd>
              </div>
              {([
                ['申请时间', task.requestedAt], ['扫码完成', task.scannedAt], ['执行完成', task.completedAt],
              ] as const).map(([label, value]) => <div key={label} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums [overflow-wrap:anywhere]">{value ? <time dateTime={value}>{formatAdminDate(value)}</time> : '—'}</dd>
              </div>)}
            </dl>
            <div className="mt-3 grid gap-2 border-t pt-3">
              <AdminTaskLogDetails task={task} onAccessLost={onAccessLost} />
              <AdminTaskInterrupt task={task} onAccessLost={onAccessLost} onSubmitted={() => interruptionSubmitted(task.username)} />
            </div>
          </li>)}
        </ul>)}
        {!loading && data?.items.length === 0 && <Empty className="py-12">
          <EmptyHeader><EmptyMedia variant="icon" className="bg-white/40"><CalendarCheck aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{data.total ? '本页暂无任务' : selectedDate === 'all' ? `近七天还没有${taskLabel}申请` : `这一天没有${taskLabel}申请`}</EmptyTitle>
            <EmptyDescription>{data.total ? '返回上一页查看任务。' : '用户申请后，刷新即可查看扫码与执行情况。'}</EmptyDescription>
          </EmptyHeader>
        </Empty>}
      </div>
      {data && <AdminPagination page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPageChange={setPage} />}
    </DialogContent>
  </Dialog>;
}
