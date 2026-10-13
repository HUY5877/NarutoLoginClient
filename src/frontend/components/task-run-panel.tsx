import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, Clock3, ListChecks, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import type { RunStatus, TaskRunView } from '@/lib/task-run';
import { taskFailureMessage } from '../../shared/task-errors';
import { deriveDailyCompletion } from '@/lib/daily-completion';

const labels: Record<RunStatus, string> = {
  starting_emulator: '准备游戏环境', opening_game: '打开游戏', preparing_qr: '获取二维码',
  waiting_scan: '等待扫码登录', finishing_login: '授权完成，正在进入游戏', running_daily: '正在刷日常', completed: '任务已完成',
  failed: '执行失败', interrupted: '执行已中断', expired: '等待登录超时',
};
const levelLabels = { INFO: '信息', WARNING: '注意', ERROR: '错误' };
const timeLabel = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });

export function TaskRunPanel({ view, retry }: { view: TaskRunView; retry: () => void }) {
  const detailsId = useId();
  const taskId = view.task?.id ?? '';
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const expanded = expandedTaskId === taskId;
  const scrollArea = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => { following.current = true; }, [view.task?.id]);
  const lastLog = view.logs.at(-1)?.id;
  useEffect(() => {
    if (expanded && following.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [expanded, lastLog, view.task?.id]);
  const initialCompletion = deriveDailyCompletion(view.run, view.task?.userOptions);
  const bad = view.run && ['failed', 'interrupted', 'expired'].includes(view.run.status) && !initialCompletion?.timedOut;
  const label = initialCompletion?.summary ?? (view.run ? labels[view.run.status] : view.unavailable ? '无执行记录'
    : view.loading ? '正在读取' : view.task ? '等待任务开始' : '待开始');
  const hasSummary = Boolean(initialCompletion || view.error || bad && view.run?.errorCode || view.run?.actionIndex !== undefined);
  return (
    <Card className="village-glass mt-5 gap-4 sm:mt-6">
      <CardHeader className="gap-2">
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
          <ListChecks className="size-5 text-primary" aria-hidden="true" />任务执行记录
        </CardTitle>
        <CardDescription>本次登录和日常的运行记录，刷新页面也能继续看。</CardDescription>
        <CardAction className="flex flex-wrap items-center justify-between gap-2 max-sm:w-full sm:justify-end">
          <Badge variant={bad ? 'destructive' : 'secondary'} className="gap-1.5">
            {view.polling && <Spinner className="size-3 motion-reduce:animate-none" aria-hidden="true" />}{label}
          </Badge>
          <Button type="button" variant="outline" size="sm" className="h-11 gap-1.5 px-3 sm:h-9"
            aria-expanded={expanded} aria-controls={detailsId} onClick={() => {
              following.current = true;
              setExpandedTaskId(expanded ? null : taskId);
            }}>
            {expanded ? '收起记录' : '展开记录'}
            <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4" hidden={!expanded && !hasSummary}>
        {initialCompletion && <p className="text-sm leading-6" role="status">{initialCompletion.description}</p>}
        {view.error && <Alert variant="destructive"><CircleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{view.error}</span><Button variant="outline" size="sm" onClick={retry} className="gap-1.5"><RefreshCw aria-hidden="true" />重试更新</Button>
          </AlertDescription>
        </Alert>}
        {bad && view.run?.errorCode && <Alert variant="destructive" aria-label="任务失败原因">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{taskFailureMessage(view.run.errorCode)}</AlertDescription>
        </Alert>}
        {view.run?.actionIndex !== undefined && <p className="text-sm font-medium" role="status">
          当前动作 {view.run.actionIndex}{view.run.actionTotal !== undefined ? ` / ${view.run.actionTotal}` : ''}
        </p>}
        <div id={detailsId} hidden={!expanded} className="space-y-4">
          {expanded && <>
            {view.task && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 break-all">任务 <code>{view.task.id}</code></span>
              {view.run && <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" aria-hidden="true" />
                更新于 <time dateTime={view.run.updatedAt}>{new Date(view.run.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time>
              </span>}
            </div>}
            {view.unavailable && <p className="text-sm leading-6 text-muted-foreground">{view.logs.length ? '本次登录申请已结束，暂未收到执行状态。已有日志保留在下方。' : '本次登录申请已结束，暂无可查看的执行记录。'}</p>}
            {view.truncated && <p className="text-xs leading-5 text-muted-foreground">较早日志已省略，页面最多保留最近 2000 条记录。</p>}
            {view.logs.length > 0 ? <div ref={scrollArea} role="log" aria-label="任务执行日志" aria-live="off" tabIndex={0}
              onScroll={() => { const area = scrollArea.current; if (area) following.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48; }}
              className="max-h-80 overflow-y-auto rounded-lg border border-border/70 bg-background/55 p-3 text-xs leading-6 sm:p-4">
              {view.logs.map(log => <div key={log.id} className="flex items-start gap-2 font-mono">
                <time dateTime={log.time} className="shrink-0 tabular-nums text-muted-foreground">{timeLabel(log.time)}</time>
                <span className={`shrink-0 ${log.level === 'ERROR' ? 'text-destructive' : log.level === 'WARNING' ? 'text-amber-700' : 'text-muted-foreground'}`}>{levelLabels[log.level]}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{log.message}</span>
              </div>)}
            </div> : !view.unavailable && <p className="rounded-lg border border-dashed p-5 text-center text-sm leading-6 text-muted-foreground">
              {view.loading ? '正在读取执行记录…' : bad ? '本次任务未留下详细执行日志。' : view.task ? '任务开始后，执行进度和日志会显示在这里。' : '生成登录二维码后，在这里查看本次任务的执行进度。'}
            </p>}
            {view.run?.status === 'running_daily' && <p className="text-xs leading-5 text-muted-foreground">二维码到期不会停止已开始的日常任务，执行记录会继续更新。</p>}
          </>}
        </div>
      </CardContent>
    </Card>
  );
}
