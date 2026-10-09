import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarCheck, Check, ChevronDown, CircleAlert, ClipboardCheck, LogOut, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { AdminDailyTasks } from '@/components/admin-daily-tasks';
import { AdminUsers } from '@/components/admin-users';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

type ReviewStatus = 'pending' | 'approved' | 'rejected';
type Filter = ReviewStatus | 'all';
interface RegistrationApplication {
  id: string;
  userId: string;
  username: string;
  status: ReviewStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reason: string | null;
}
const statusLabels: Record<Filter, string> = { pending: '待审核', approved: '已通过', rejected: '已拒绝', all: '全部' };
const filters: Filter[] = ['pending', 'approved', 'rejected', 'all'];

function formatDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function validApplication(value: RegistrationApplication) {
  return typeof value?.id === 'string' && typeof value.username === 'string' &&
    ['pending', 'approved', 'rejected'].includes(value.status);
}

export function AdminMenu({ userId, refreshAuth, mobileAccount }: {
  userId: string;
  refreshAuth: () => Promise<void>;
  mobileAccount?: { username: string; busy: boolean; logout: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('pending');
  const [applications, setApplications] = useState<RegistrationApplication[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [accessLost, setAccessLost] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const reviewRequestRef = useRef<AbortController | null>(null);
  const reviewingRef = useRef(false);
  const mountedRef = useRef(true);
  const openingDialogRef = useRef(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = () => menuTriggerRef.current?.focus();

  const loseAccess = useCallback(() => {
    requestRef.current?.abort();
    setOpen(false);
    setDailyOpen(false);
    setUsersOpen(false);
    setApplications(null);
    setAccessLost(true);
    void refreshAuth();
  }, [refreshAuth]);

  const loadApplications = useCallback(async (clear = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    setError('');
    if (clear) setApplications(null);
    try {
      const response = await fetch(`/api/admin/registration-applications?status=${filter}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) { loseAccess(); return; }
      const body = await response.json() as { applications?: RegistrationApplication[]; error?: string };
      if (!response.ok) throw new Error(body.error || '注册申请暂时无法读取，请重试。');
      if (!Array.isArray(body.applications) || !body.applications.every(validApplication)) {
        throw new Error('注册申请返回信息异常，请重试。');
      }
      if (requestRef.current === controller && mountedRef.current) setApplications(body.applications);
    } catch (caught) {
      if (requestRef.current !== controller || !mountedRef.current) return;
      setError(caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : '读取申请超时，请检查网络后重试。');
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller && mountedRef.current) setLoading(false);
    }
  }, [filter, loseAccess]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      reviewRequestRef.current?.abort();
    };
  }, [userId]);

  useEffect(() => {
    setRejectingId(null);
    setReason('');
    setNotice('');
    if (open) void loadApplications(true);
    else {
      requestRef.current?.abort();
      requestRef.current = null;
      setApplications(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open, loadApplications]);

  async function review(application: RegistrationApplication, decision: 'approved' | 'rejected') {
    if (reviewingRef.current || loading) return;
    const reviewReason = decision === 'rejected' ? reason.trim() : '';
    if ([...reviewReason].length > 200) {
      setError('拒绝理由最多为 200 个字符。');
      return;
    }
    reviewingRef.current = true;
    setReviewingId(application.id);
    setError('');
    setNotice('');
    const controller = new AbortController();
    reviewRequestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/admin/registration-applications/${encodeURIComponent(application.id)}/review`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, ...(reviewReason ? { reason: reviewReason } : {}) }), signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) { loseAccess(); return; }
      const body = await response.json() as { application?: RegistrationApplication; error?: string };
      if (!response.ok) throw new Error(body.error || '审核未完成，请刷新列表后重试。');
      if (!body.application || !validApplication(body.application)) throw new Error('审核结果尚未确认，请刷新列表查看。');
      if (!mountedRef.current) return;
      const updated = body.application;
      setApplications(items => items?.flatMap(item => item.id !== updated.id ? [item]
        : filter === 'all' || filter === updated.status ? [updated] : []) ?? null);
      setRejectingId(null);
      setReason('');
      setNotice(`已${decision === 'approved' ? '通过' : '拒绝'}「${application.username}」的注册申请。`);
      await loadApplications();
    } catch (caught) {
      if (!mountedRef.current) return;
      await loadApplications();
      if (mountedRef.current) setError(caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : '审核请求超时，请根据刷新后的状态确认结果，再决定是否重试。');
    } finally {
      clearTimeout(timeout);
      reviewingRef.current = false;
      if (mountedRef.current) setReviewingId(null);
    }
  }

  if (accessLost) return <span role="alert" className="max-w-36 text-xs leading-5 text-destructive">管理员权限已变更，管理面板已关闭。</span>;

  return (
    <>
      {/* Keep the page scrollbar and fixed background stable while this menu is open. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={menuTriggerRef} type="button" variant="outline" size="sm" className="mobile-account-trigger gap-1.5 bg-white/45">
            <ShieldCheck aria-hidden="true" />
            <span className={mobileAccount ? 'hidden sm:inline' : undefined}>管理员</span>
            {mobileAccount && <span className="max-w-20 truncate sm:hidden">{mobileAccount.username}</span>}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44" onCloseAutoFocus={event => {
          if (openingDialogRef.current) { event.preventDefault(); openingDialogRef.current = false; }
        }}>
          <DropdownMenuItem className="py-2" onSelect={() => { openingDialogRef.current = true; setOpen(true); }}>
            <ClipboardCheck aria-hidden="true" />注册申请审核
          </DropdownMenuItem>
          <DropdownMenuItem className="py-2" onSelect={() => { openingDialogRef.current = true; setDailyOpen(true); }}>
            <CalendarCheck aria-hidden="true" />今日刷日常情况
          </DropdownMenuItem>
          <DropdownMenuItem className="py-2" onSelect={() => { openingDialogRef.current = true; setUsersOpen(true); }}>
            <Users aria-hidden="true" />用户管理
          </DropdownMenuItem>
          {mobileAccount && <>
            <DropdownMenuSeparator className="sm:hidden" />
            <DropdownMenuItem className="py-3 sm:hidden" disabled={mobileAccount.busy} onSelect={mobileAccount.logout}>
              <LogOut aria-hidden="true" />退出登录
            </DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={next => { if (!reviewingRef.current) setOpen(next); }}>
        <DialogContent className="auth-dialog flex max-h-[min(88svh,52rem)] flex-col gap-5 p-5 sm:max-w-3xl sm:p-6"
          onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
          <DialogHeader className="shrink-0 gap-2 pr-7">
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><ClipboardCheck aria-hidden="true" />注册申请审核</DialogTitle>
            <DialogDescription className="leading-6">审核通过后，申请人即可使用注册时的用户名和密码登录。</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div role="group" aria-label="申请状态筛选" className="flex flex-wrap gap-1.5">
              {filters.map(value => <Button key={value} type="button" size="sm"
                variant={filter === value ? 'default' : 'outline'} aria-pressed={filter === value}
                disabled={Boolean(reviewingId)} onClick={() => setFilter(value)}>{statusLabels[value]}</Button>)}
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={loading || Boolean(reviewingId)} onClick={() => { void loadApplications(); }}>
              {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
            </Button>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto px-1 -mx-1" aria-busy={loading}>
            {error && <Alert variant="destructive" role="alert" className="bg-white/45">
              <CircleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription>
            </Alert>}
            {notice && <Alert role="status" className="border-primary/20 bg-white/40">
              <Check aria-hidden="true" /><AlertDescription>{notice}</AlertDescription>
            </Alert>}
            {loading && !applications && <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground" role="status"><Spinner aria-hidden="true" />正在读取注册申请…</div>}
            {!loading && applications?.length === 0 && <Empty className="border-0 py-10">
              <EmptyHeader><EmptyMedia variant="icon" className="bg-white/35"><ClipboardCheck aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>暂无{filter === 'all' ? '' : statusLabels[filter]}注册申请</EmptyTitle>
                <EmptyDescription>新的注册申请会显示在「待审核」中。</EmptyDescription>
              </EmptyHeader>
            </Empty>}
            {applications?.map(application => <Card key={application.id} className="gap-0 bg-white/35 py-4 shadow-none" aria-label={`${application.username}的注册申请`}>
              <CardContent className="space-y-3 px-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-all font-semibold">{application.username}</p>
                  <Badge variant={application.status === 'approved' ? 'default' : application.status === 'rejected' ? 'destructive' : 'secondary'}>{statusLabels[application.status]}</Badge>
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs leading-6 text-muted-foreground sm:grid-cols-2">
                  <div><dt className="inline">申请时间：</dt><dd className="inline">{formatDate(application.createdAt)}</dd></div>
                  <div><dt className="inline">审核时间：</dt><dd className="inline">{formatDate(application.reviewedAt)}</dd></div>
                  {application.status !== 'pending' && <div className="break-words sm:col-span-2"><dt className="inline">审核理由：</dt><dd className="inline">{application.reason || '未填写'}</dd></div>}
                </dl>
                {application.status === 'pending' && (rejectingId === application.id ? <div className="space-y-3 border-t border-foreground/10 pt-3">
                  <div className="space-y-2">
                    <Label htmlFor={`review-reason-${application.id}`}>拒绝理由（可选）</Label>
                    <Input id={`review-reason-${application.id}`} value={reason} onChange={event => setReason(event.target.value)}
                      placeholder="填写拒绝理由" disabled={Boolean(reviewingId)} className="h-10 bg-white/35"
                      aria-invalid={[...reason.trim()].length > 200} aria-describedby={`review-reason-hint-${application.id}`} />
                    <p id={`review-reason-hint-${application.id}`} className={`text-xs ${[...reason.trim()].length > 200 ? 'text-destructive' : 'text-muted-foreground'}`}>{[...reason.trim()].length}/200 个字符</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="destructive" size="sm" disabled={loading || Boolean(reviewingId) || [...reason.trim()].length > 200}
                      onClick={() => { void review(application, 'rejected'); }}>{reviewingId === application.id ? <Spinner aria-hidden="true" /> : <X aria-hidden="true" />}确认拒绝</Button>
                    <Button type="button" variant="outline" size="sm" disabled={Boolean(reviewingId)} onClick={() => { setRejectingId(null); setReason(''); }}>取消</Button>
                  </div>
                </div> : <div className="flex flex-wrap gap-2 border-t border-foreground/10 pt-3">
                  <Button type="button" size="sm" disabled={loading || Boolean(reviewingId)} onClick={() => { void review(application, 'approved'); }}>
                    {reviewingId === application.id ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" />}通过
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={loading || Boolean(reviewingId)}
                    onClick={() => { setRejectingId(application.id); setReason(''); setError(''); }}>拒绝</Button>
                </div>)}
              </CardContent>
            </Card>)}
          </div>
        </DialogContent>
      </Dialog>
      {dailyOpen && <AdminDailyTasks open={dailyOpen} onOpenChange={setDailyOpen} onAccessLost={loseAccess} returnFocus={returnFocus} />}
      {usersOpen && <AdminUsers open={usersOpen} onOpenChange={setUsersOpen} currentUserId={userId} onAccessLost={loseAccess} refreshAuth={refreshAuth} returnFocus={returnFocus} />}
    </>
  );
}
