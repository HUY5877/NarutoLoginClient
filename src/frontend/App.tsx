import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Clock3,
  LogIn,
  LogOut,
  ListChecks,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
  TimerOff,
  UserRound,
} from 'lucide-react';
import { AuthDialog } from '@/components/auth-dialog';
import { AdminMenu } from '@/components/admin-menu';
import { VillageParticles } from '@/components/village-particles';
import { ChakraSeal } from '@/components/chakra-seal';
import { MobileVillageHero } from '@/components/mobile-village-hero';
import { KonanPortrait } from '@/components/konan-portrait';
import { MobileTaskSheet } from '@/components/mobile-task-sheet';
import { TaskProgressCards } from '@/components/task-progress-cards';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { useLoginSession } from '@/hooks/use-login-session';
import { useAuth } from '@/hooks/use-auth';
import { useTaskRun } from '@/hooks/use-task-run';
import { TaskRunPanel } from '@/components/task-run-panel';
import { deriveTaskProgress, hasGameAuthorization, isUnclaimedQueueTimeout, selectProgressRun } from '@/lib/task-progress';
import { isRunTerminal } from '@/lib/task-run';
import { deriveDailyCompletion } from '@/lib/daily-completion';
import { DEFAULT_USER_OPTIONS, parseUserOptions } from '../shared/user-options';
import { DEFAULT_LOGIN_TYPE, loginTypes, loginTypeLabels, loginScanApp, parseLoginType } from '../shared/login-types';

function LoginHelp() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
          <CircleHelp aria-hidden="true" />
          使用帮助
        </Button>
      </DialogTrigger>
      <DialogContent className="login-help-dialog sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>如何准备登录二维码</DialogTitle>
          <DialogDescription>先登录忍者日常账户，再准备游戏登录二维码。</DialogDescription>
        </DialogHeader>
        <ItemGroup className="py-1">
          {[
            ['启动模拟器', '登录账户，选择登录渠道并点击「启动模拟器获取二维码」。同账户的多个页面共用一个实例。'],
            ['等待准备完成', '保持页面打开，页面会自动更新准备进度和二维码。'],
            ['扫码授权并执行', 'QQ 区使用手机 QQ，微信区使用微信扫描二维码并确认授权；进入游戏后自动继续执行日常脚本。'],
          ].map(([title, description], index) => (
            <Item key={title} role="listitem" size="sm" className="items-start px-0">
              <ItemMedia variant="icon" className="size-8 rounded-lg bg-primary/10 text-primary">
                <span className="text-sm font-semibold">{index + 1}</span>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription className="line-clamp-none leading-6">{description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        <Alert>
          <Clock3 aria-hidden="true" />
          <AlertTitle>二维码失效后，点击「刷新二维码」</AlertTitle>
          <AlertDescription>实例分配后保留 10 分钟供扫码，刷新不会延长占用时间。超时未扫码成功会自动关闭实例；扫码成功后继续执行日常。</AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const auth = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [submissionRevision, setSubmissionRevision] = useState<number | null>(null);
  const {
    phase,
    session,
    qrUrl,
    error,
    retrying,
    pending,
    showGetButton,
    canRetryQuery,
    canResumePending,
    remainingSeconds,
    countdown,
    isError,
    statusLabel,
    startLogin,
    refreshQr,
    retryQuery,
    handleQrError,
    acceptedRevision,
    confirmLogin,
    userOptions,
    canEditUserOptions,
    setEquipmentStamina,
    loginType,
    setLoginType,
  } = useLoginSession(auth.user?.id ?? null, auth.handleUnauthorized);
  const taskRun = useTaskRun(auth.user?.id ?? null, session, auth.handleUnauthorized);
  useEffect(() => { setSubmissionRevision(null); setMobileDetailsOpen(false); }, [auth.user?.id]);
  const awaitingSubmission = submissionRevision !== null && acceptedRevision === submissionRevision;

  function openLogin() {
    auth.clearError();
    setAuthOpen(true);
  }

  const progressInput = { phase, session, qrReady: phase === 'qr_ready' && Boolean(qrUrl), view: taskRun, awaitingSubmission };
  const visibleRun = selectProgressRun(progressInput);
  const currentRun = visibleRun.run;
  const initialDailyCompletion = deriveDailyCompletion(currentRun);
  const authorizedRun = hasGameAuthorization(currentRun) && (session?.id === currentRun?.taskId
    || !session && phase === 'idle' && ['finishing_login', 'running_daily'].includes(currentRun?.status ?? ''));
  const authorizationComplete = phase === 'login_confirmed' || authorizedRun;
  const restoringAuthorizedRun = !session && authorizedRun;
  const displayedUserOptions = restoringAuthorizedRun
    ? parseUserOptions(visibleRun.task?.userOptions) ?? DEFAULT_USER_OPTIONS : userOptions;
  const canEditShownOptions = canEditUserOptions && !restoringAuthorizedRun;
  const displayedLoginType = restoringAuthorizedRun ? parseLoginType(visibleRun.task?.loginType) ?? DEFAULT_LOGIN_TYPE : loginType;
  const scanApp = loginScanApp(displayedLoginType);
  const queueTimedOut = phase === 'expired' && isUnclaimedQueueTimeout(session, currentRun);
  const ready = progressInput.qrReady && !authorizationComplete;
  const qrPending = pending && !authorizationComplete;
  const qrError = isError && !authorizationComplete;
  const progress = deriveTaskProgress({ ...progressInput, qrReady: ready });
  useEffect(() => {
    if (session && currentRun?.taskId === session.id && hasGameAuthorization(currentRun)) {
      confirmLogin(session.id, isRunTerminal(currentRun.status));
    }
  }, [session?.id, currentRun?.taskId, currentRun?.status, currentRun?.authorizedAt, currentRun?.startedAt, confirmLogin]);
  const stepIcons = { submission: ArrowRight, qr: QrCode, script: ListChecks };

  return (
    <div className="login-shell min-h-svh text-foreground">
      <div className="village-backdrop" aria-hidden="true">
        <picture>
          <source media="(max-width: 639px)" srcSet="/images/konoha-background-mobile.webp" />
          <img src="/images/konoha-background.webp" alt="" width="1536" height="1024" fetchPriority="high" />
        </picture>
        <VillageParticles />
      </div>
      <header className="village-header border-b border-white/50">
        <div className="village-header-inner mx-auto flex min-h-18 max-w-5xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 sm:px-8">
          <div className="flex items-center gap-3" aria-label="忍者日常">
            <span className="headband-mark" aria-hidden="true">
              <img src="/icons/leaf-village.svg" alt="" width="32" height="32" />
            </span>
            <span className="text-base font-bold tracking-wide">忍者日常</span>
            <Separator orientation="vertical" className="mx-1 hidden h-5! sm:block" />
            <span className="hidden text-xs text-muted-foreground sm:block">扫码清日常</span>
          </div>
          <div className="village-account flex flex-wrap items-center justify-end gap-1.5 sm:gap-3">
            {auth.loading ? <Spinner aria-label="正在读取账户状态" className="size-4" /> : auth.user ? (
              <>
                {auth.user.isAdmin === true ? <AdminMenu key={auth.user.id} userId={auth.user.id} refreshAuth={auth.refresh}
                  mobileAccount={{ username: auth.user.username, busy: auth.busy, logout: () => { void auth.logout(); } }} /> : (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="mobile-account-trigger gap-1.5 sm:hidden" aria-label={`${auth.user.username} 账户菜单`}>
                        <UserRound aria-hidden="true" /><span className="max-w-20 truncate">{auth.user.username}</span><ChevronDown aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="village-account-menu min-w-36">
                      <DropdownMenuItem className="py-3" disabled={auth.busy} onSelect={() => { void auth.logout(); }}>
                        <LogOut aria-hidden="true" />退出登录
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <span className="hidden max-w-24 truncate text-sm font-medium sm:block sm:max-w-40" title={auth.user.username}>{auth.user.username}</span>
                <Button variant="ghost" size="sm" disabled={auth.busy} onClick={() => { void auth.logout(); }} className="hidden gap-1.5 sm:inline-flex">
                  <LogOut aria-hidden="true" />退出
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" disabled={auth.busy} onClick={openLogin} className="gap-1.5 bg-white/50">
                <LogIn aria-hidden="true" />登录 / 注册
              </Button>
            )}
            <span className="hidden sm:block"><LoginHelp /></span>
          </div>
        </div>
      </header>

      <main className="village-main mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8" data-mobile-qr-ready={ready}>
        {auth.error && !authOpen && (
          <Alert variant="destructive" className="village-glass auth-notice mb-5" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{auth.error}</span>
              <Button variant="outline" size="sm" disabled={auth.busy} onClick={() => {
                if (auth.logoutFailed) void auth.logout(); else void auth.refresh();
              }}>{auth.logoutFailed ? '重试退出' : '重试'}</Button>
            </AlertDescription>
          </Alert>
        )}
        <section className="village-hero mb-6" aria-labelledby="welcome-title">
          <div className="village-hero-copy">
            <Badge variant="outline" className="mb-4 gap-1.5 border-primary/20 bg-card/80 px-2.5 py-1 text-xs font-medium text-primary">
              <Smartphone className="size-3" aria-hidden="true" />
              火影忍者手游 · {loginTypeLabels[displayedLoginType]}
            </Badge>
            <h1 id="welcome-title" className="village-title">上号，<span className="desktop-hero-accent">清日常。</span></h1>
            <p className="mt-3 max-w-70 text-sm leading-6 text-muted-foreground sm:max-w-none">
              用手机{scanApp}扫码登录，<span className="inline-block">日常任务会自动接着跑。</span>
            </p>
          </div>
          <img className="hero-seal" src="/icons/leaf-village.svg" alt="" width="240" height="240" aria-hidden="true" />
          <KonanPortrait className="village-portrait" />
        </section>
        <MobileVillageHero loginType={displayedLoginType} />

        <div className="village-workspace grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
          <Card className="village-glass login-card gap-0 overflow-hidden shadow-sm" data-authorized={authorizationComplete} data-phase={ready ? 'qr_ready' : authorizationComplete ? 'authorized' : phase}>
            <CardHeader className="gap-2 px-6 pb-6 sm:px-8">
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-lg font-semibold">
                <ScanLine className="size-5 text-primary" aria-hidden="true" />
                <span className="hidden sm:inline">扫码登录</span>
                <span className="sm:hidden">{authorizationComplete ? '本次登录' : '扫码登录'}</span>
              </CardTitle>
              <CardDescription className="text-sm">
                <span className="hidden sm:inline">生成二维码后，用手机{scanApp}扫一扫。</span>
                <span className="sm:hidden">{authorizationComplete ? '进入游戏后，日常任务会自动接着跑。' : `用手机${scanApp}扫码，再确认登录。`}</span>
              </CardDescription>
              <CardAction>
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Smartphone aria-hidden="true" />
                  {loginTypeLabels[displayedLoginType]}
                </Badge>
              </CardAction>
            </CardHeader>
            <Separator />

            <CardContent className="flex flex-col items-center px-6 py-8 sm:px-8 sm:py-9">
              <div key={ready ? 'qr' : authorizationComplete ? 'authorized' : phase} className="qr-frame w-full max-w-64" data-ready={ready ? 'true' : undefined} aria-busy={qrPending}>
                <div className="qr-content relative aspect-square overflow-hidden rounded-xl border border-dashed border-foreground/20 bg-transparent">
                  {ready && qrUrl ? (
                    <img
                      className="size-full object-contain"
                      src={qrUrl}
                      alt={`火影忍者 ${loginTypeLabels[displayedLoginType]}登录二维码，请使用手机${scanApp}扫码授权`}
                      onError={handleQrError}
                    />
                  ) : (
                    <>
                      {qrPending && <Skeleton className="absolute inset-0 size-full rounded-none bg-white/20 motion-reduce:animate-none" />}
                      <Empty className="relative h-full gap-4 border-0 p-5 md:p-5">
                        <EmptyHeader className="gap-2.5">
                          <EmptyMedia variant="icon" className={`mb-1 size-16 rounded-2xl ${qrError ? 'bg-destructive/10 text-destructive' : 'qr-emblem text-muted-foreground'}`}>
                            <ChakraSeal active={qrPending || authorizationComplete} complete={authorizationComplete} />
                            {authorizationComplete ? <CheckCheck className="text-primary" aria-hidden="true" />
                              : qrPending ? <Spinner aria-hidden="true" className="size-6 motion-reduce:animate-none" />
                              : phase === 'expired' ? <TimerOff aria-hidden="true" />
                                : isError ? <CircleAlert aria-hidden="true" />
                                  : <img src="/icons/leaf-village.svg" alt="" width="42" height="42" aria-hidden="true" />}
                          </EmptyMedia>
                          <div className="qr-copy">
                            <EmptyTitle className="text-base">
                              {authorizationComplete ? <>
                                <span className="hidden sm:inline">扫码授权已完成</span>
                                <span className="sm:hidden" role="status" aria-live="polite">{progress.summary}</span>
                              </> : queueTimedOut ? '排队超时' : phase === 'expired' ? '二维码已过期'
                                : canRetryQuery ? '等待查询确认' : isError ? '二维码准备失败'
                                  : phase === 'restoring' ? '正在查询登录申请' : pending ? '正在准备二维码' : '登录二维码'}
                            </EmptyTitle>
                            <EmptyDescription className="text-sm leading-6">
                              {authorizationComplete ? <>
                                <span className="hidden sm:inline">{currentRun?.status === 'finishing_login' ? '正在进入游戏，无需再次扫码' : '无需再次扫码，请在执行记录中查看后续进度'}</span>
                                <span className="sm:hidden">{currentRun && isRunTerminal(currentRun.status) ? progress.hint : '扫码已完成，无需再次扫码'}</span>
                              </>
                                : queueTimedOut ? '本次申请未被领取，请稍后重新生成二维码'
                                : canRetryQuery ? canResumePending ? '点击「继续本次申请」恢复已保存的申请' : '点击「重试查询」继续查看本次申请'
                                : isError ? '确认本次申请结束后，可以重新获取'
                                : pending ? '保持页面打开，二维码准备好后会自动显示'
                                  : auth.user ? '点击下方按钮，生成本次登录二维码' : '先登录忍者日常账户，再获取二维码'}
                            </EmptyDescription>
                          </div>
                        </EmptyHeader>
                      </Empty>
                    </>
                  )}
                </div>
              </div>

              <div className="login-status mt-5 flex min-h-6 flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm" role="status" aria-live="polite" aria-atomic="true">
                <span className={`inline-flex items-center gap-2 ${qrError ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {qrPending ? <Spinner aria-hidden="true" className="size-3.5 motion-reduce:animate-none" />
                    : ready || authorizationComplete ? <Check className="size-4 text-primary" aria-hidden="true" />
                      : <Clock3 className="size-3.5" aria-hidden="true" />}
                  {auth.loading ? '正在读取账户状态' : !auth.user ? '登录后即可获取二维码' : authorizationComplete ? progress.summary : queueTimedOut ? '排队等待超时' : retrying ? '连接暂时中断，正在重试…' : statusLabel}
                </span>
                {auth.user && !authorizationComplete && remainingSeconds > 0 && !showGetButton && (
                  <Badge variant="secondary" className="gap-1.5 font-mono tabular-nums" aria-label={`剩余 ${remainingSeconds} 秒`}>
                    <Clock3 aria-hidden="true" />
                    {countdown}
                  </Badge>
                )}
              </div>

              {!authorizationComplete && error && (phase === 'failed' || canRetryQuery || queueTimedOut) && (
                <Alert variant="destructive" className="mt-5">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{canRetryQuery ? '申请状态暂时无法确认' : queueTimedOut ? '排队等待超时' : '本次二维码准备失败'}</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {auth.user && (
                <div className="login-channel mt-6 w-full max-w-sm space-y-2">
                  <label id="login-channel-label" htmlFor="login-channel-trigger" className="text-sm font-medium">登录渠道</label>
                  {/* 非模态菜单保持页面滚动、固定背景和玻璃面板稳定。 */}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button id="login-channel-trigger" type="button" variant="outline"
                        aria-labelledby="login-channel-label" aria-describedby="login-channel-help"
                        disabled={auth.busy || !canEditShownOptions}
                        className="login-channel-trigger h-11 min-h-11 w-full justify-between bg-white/40 font-normal">
                        <span>{loginTypeLabels[displayedLoginType]}</span>
                        <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" collisionPadding={8} className="login-channel-menu">
                      <DropdownMenuRadioGroup value={displayedLoginType} aria-labelledby="login-channel-label"
                        onValueChange={value => { const type = parseLoginType(value); if (type) setLoginType(type); }}>
                        {loginTypes.map(type => <DropdownMenuRadioItem key={type} value={type} className="min-h-11 px-3">
                          {loginTypeLabels[type]}
                        </DropdownMenuRadioItem>)}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <p id="login-channel-help" className="text-xs leading-5 text-muted-foreground">{canEditShownOptions ? '请选择游戏账号所在的区服。' : '本次申请的渠道已保存，刷新二维码会沿用此渠道。'}</p>
                </div>
              )}

              {auth.user && (
                <label className="equipment-options mt-6 flex w-full max-w-sm items-start gap-3 rounded-xl border border-primary/15 bg-white/40 px-4 py-3" data-editable={canEditShownOptions}>
                  <span className="equipment-switch">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
                      checked={displayedUserOptions.equipmentStamina}
                      disabled={auth.busy || !canEditShownOptions}
                      onChange={event => setEquipmentStamina(event.target.checked)}
                      aria-labelledby="equipment-stamina-label"
                      aria-describedby="equipment-stamina-help"
                    />
                    <span className="equipment-switch-track" aria-hidden="true" />
                  </span>
                  <span>
                    <span id="equipment-stamina-label" className="block text-sm font-medium">装备栏体力刷取</span>
                    <span className="mobile-option-caption" aria-hidden="true">本次任务设置</span>
                    <span id="equipment-stamina-help" className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {canEditShownOptions ? '开启后，本次日常会进行装备栏体力刷取。' : '本次申请的选择已保存，重新申请时可修改。'}
                    </span>
                  </span>
                </label>
              )}

              {!auth.loading && <Button
                type="button"
                size="lg"
                className="login-action mt-6 h-12 w-full max-w-sm gap-2 text-sm font-semibold"
                onClick={() => { if (auth.user) { setSubmissionRevision(acceptedRevision); void startLogin(); } else openLogin(); }}
                disabled={auth.busy || pending || Boolean(auth.user && (!showGetButton || authorizationComplete && !(currentRun && isRunTerminal(currentRun.status))))}
              >
                {!auth.user ? <LogIn aria-hidden="true" /> : phase === 'idle' ? <QrCode aria-hidden="true" />
                    : <RefreshCw aria-hidden="true" />}
                {!auth.user ? '登录后获取二维码' : '启动模拟器获取二维码'}
                {phase === 'idle' && !auth.loading && <ArrowRight className="ml-1" aria-hidden="true" />}
              </Button>}
              {!auth.loading && auth.user && <Button type="button" variant="outline" size="lg"
                className="qr-refresh-action mt-3 h-11 w-full max-w-sm gap-2"
                disabled={auth.busy || pending || !session || !['qr_ready', 'query_failed'].includes(phase) || authorizationComplete || remainingSeconds <= 0}
                onClick={() => { void refreshQr(); }}>
                <RefreshCw aria-hidden="true" />刷新二维码
              </Button>}
              {!authorizationComplete && canRetryQuery && auth.user && (
                <Button type="button" variant="outline" size="lg" className="mt-6 h-12 w-full max-w-sm gap-2 bg-white/40"
                  disabled={auth.busy || pending} onClick={() => { void retryQuery(); }}>
                  <RefreshCw aria-hidden="true" />{canResumePending ? '继续本次申请' : '重试查询'}
                </Button>
              )}
              {auth.user && ready && <p className="qr-ready-note mt-5 text-sm font-medium text-primary">请用手机{scanApp}扫码，二维码失效可刷新</p>}
              <p className="qr-sharing-note mt-3 flex items-start gap-1.5 text-center text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {session?.loginStartedAt ? '实例保留 10 分钟供扫码，刷新不会延长占用' : '同一账户共用一个实例，分配后有 10 分钟扫码时间'}
              </p>
              {auth.user && <>
                <div className="mobile-progress-overview sm:hidden" aria-label="任务进度概览">
                  {progress.steps.map(({ id, title, description, state }) => {
                    const waitingForScan = id === 'qr' && ready;
                    const scanned = id === 'qr' && authorizationComplete;
                    const label = scanned ? '已扫码' : waitingForScan ? '待扫码'
                      : id === 'submission' ? state === 'completed' ? '已提交' : '提交申请'
                        : id === 'qr' ? '二维码'
                          : currentRun?.status === 'finishing_login' ? '进入游戏'
                            : initialDailyCompletion?.tone === 'success' ? '初步完成' : state === 'completed' ? '已完成' : '清日常';
                    const stateLabel = waitingForScan ? 'active' : state;
                    const StepIcon = stepIcons[id];
                    return <span key={id} data-stage={id} data-state={stateLabel} aria-label={`${title}：${description}`}>
                      <span className="progress-step-symbol">
                        {state === 'failed' ? <CircleAlert aria-hidden="true" />
                          : waitingForScan ? <QrCode aria-hidden="true" />
                            : scanned || state === 'completed' ? <Check aria-hidden="true" />
                              : state === 'active' ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
                                : <StepIcon aria-hidden="true" />}
                      </span>
                      <span>{label}</span>
                    </span>;
                  })}
                </div>
                <MobileTaskSheet open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}>
                  <div className="task-sheet-progress space-y-4"><TaskProgressCards progress={progress} /></div>
                  <TaskRunPanel view={visibleRun} retry={taskRun.retry} />
                  {session && <p className="task-sheet-session">申请编号 <code>{session.id}</code></p>}
                </MobileTaskSheet>
              </>}
            </CardContent>

            <CardFooter className="login-card-footer flex-col items-stretch gap-4 border-t px-6 py-5 sm:px-8">
              <Alert className="login-explanation border-0 bg-transparent p-0 text-muted-foreground">
                <CircleAlert aria-hidden="true" />
                <AlertTitle className="text-sm font-medium text-foreground">确认登录后，日常会接着跑</AlertTitle>
                <AlertDescription className="text-sm leading-6">
                  在手机{scanApp}上确认登录就好。进入游戏后会自动清日常，下方可以查看进度。
                </AlertDescription>
              </Alert>
              {session && (
                <Accordion type="single" collapsible className="login-session-details">
                  <AccordionItem value="session" className="border-b-0 border-t">
                    <AccordionTrigger className="py-3 text-sm font-normal text-muted-foreground">本次申请详情</AccordionTrigger>
                    <AccordionContent className="space-y-3 pb-1 text-sm">
                      <div className="space-y-1.5">
                        <p className="text-muted-foreground">申请编号</p>
                        <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">{session.id}</code>
                      </div>
                      <p className="leading-6 text-muted-foreground">重新打开页面后，点击「启动模拟器获取二维码」可恢复当前实例。二维码失效时点击「刷新二维码」；占用超时后再启动新实例。</p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
              <div className="mobile-login-help flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:hidden">
                <LoginHelp />
                {auth.user && !canEditShownOptions && <span className="text-xs text-muted-foreground">{displayedUserOptions.equipmentStamina ? '装备栏体力刷取已开启' : '装备栏体力刷取未开启'}</span>}
              </div>
            </CardFooter>
          </Card>

          <div id="login-progress-details" className="village-side-panels space-y-5 lg:space-y-6">
            <TaskProgressCards progress={progress} />
          </div>
        </div>
        <div id="task-run-details" className="task-run-details">
          {auth.user && <TaskRunPanel view={visibleRun} retry={taskRun.retry} />}
        </div>
      </main>
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} busy={auth.busy}
        error={auth.error} clearError={auth.clearError} authenticate={auth.authenticate} />
    </div>
  );
}
