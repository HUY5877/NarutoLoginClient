import { useState } from 'react';
import { RefreshCw, Trophy } from 'lucide-react';
import type { MonthlySort } from '../../shared/admin';
import { useAdminData } from '@/hooks/use-admin';
import { isMonthlyStatsPage } from '@/lib/admin';
import { AdminError, AdminLoading, AdminPagination } from '@/components/admin-common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminMonthlyStats({ open, onOpenChange, onAccessLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAccessLost: () => void; returnFocus: () => void;
}) {
  const [month, setMonth] = useState(() => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7));
  const [sort, setSort] = useState<MonthlySort>('requests');
  const [page, setPage] = useState(1);
  const validMonth = /^[2-9]\d{3}-(0[1-9]|1[0-2])$/.test(month);
  const { data, loading, error, reload } = useAdminData(open && validMonth
    ? `/api/admin/monthly-stats?month=${month}&sort=${sort}&page=${page}` : null, isMonthlyStatsPage, onAccessLost);
  const result = data?.month === month && data.sort === sort && data.page === page ? data : null;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="auth-dialog flex max-h-[88dvh] flex-col gap-4 p-5 sm:max-w-2xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-8">
        <DialogTitle className="flex items-center gap-2 text-lg"><Trophy className="size-5 text-primary" aria-hidden="true" />月度排行榜</DialogTitle>
        <DialogDescription className="leading-6">提交申请就计入，不要求执行成功。同一天多次申请，日常天数只计 1 天。按北京时间统计。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Label htmlFor="ranking-month">统计月份</Label>
          <Input id="ranking-month" type="month" min="2000-01" max="9999-12" value={month} className="w-44 bg-white/40"
            onChange={event => { setMonth(event.target.value); setPage(1); }} />
        </div>
        <Button type="button" variant="outline" size="sm" className="min-h-10" disabled={loading || !validMonth} onClick={() => void reload()}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
        </Button>
      </div>
      <div role="group" aria-label="排行榜排序" className="flex shrink-0 gap-2">
        {([['requests', '请求次数榜'], ['days', '日常天数榜']] as const).map(([value, label]) =>
          <Button key={value} type="button" size="sm" className="min-h-10 flex-1" variant={sort === value ? 'default' : 'outline'}
            aria-pressed={sort === value} onClick={() => { setSort(value); setPage(1); }}>{label}</Button>)}
      </div>
      <div className="min-h-0 overflow-y-auto" aria-busy={loading}>
        <AdminError message={!validMonth ? '请选择统计月份。' : error} />
        {loading && !result && <AdminLoading label="正在统计本月申请…" />}
        {result && <>
          <p className="mb-3 text-sm text-muted-foreground">{result.total} 人参与 · 共 {result.totalRequests.toLocaleString('zh-CN')} 次申请</p>
          {result.items.length > 0 ? <div className="overflow-hidden rounded-xl border bg-white/30">
            <Table className="table-fixed">
              <TableCaption className="sr-only">{month} 月度排行榜</TableCaption>
              <TableHeader><TableRow>
                <TableHead className="w-12 pl-3 text-xs">名次</TableHead><TableHead className="text-xs">用户</TableHead>
                <TableHead className="w-20 whitespace-normal text-right text-xs">请求总次数</TableHead>
                <TableHead className="w-[4.5rem] whitespace-normal pr-3 text-right text-xs">日常天数</TableHead>
              </TableRow></TableHeader>
              <TableBody>{result.items.map(user => <TableRow key={user.userId}>
                <TableCell className={`pl-3 tabular-nums ${user.rank <= 3 ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>{user.rank}</TableCell>
                <TableCell className="whitespace-normal break-all py-4 text-sm">
                  <span className="font-medium">{user.username}</span>
                  {user.note && <p className="mt-1 text-xs leading-5 text-muted-foreground">备注：{user.note}</p>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{user.requestCount.toLocaleString('zh-CN')}</TableCell>
                <TableCell className="pr-3 text-right tabular-nums">{user.requestDays} 天</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div> : <p role="status" className="py-12 text-center text-sm text-muted-foreground">{result.total ? '本页暂无记录，请返回上一页。' : '这个月还没有日常申请。'}</p>}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">同分并列排名。刷新二维码、重复提交同一申请不增加次数。</p>
        </>}
      </div>
      {result && <AdminPagination page={result.page} pageSize={result.pageSize} total={result.total} disabled={loading} onPageChange={setPage} />}
    </DialogContent>
  </Dialog>;
}
