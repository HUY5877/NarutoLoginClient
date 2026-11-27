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
  Settings2,
  ShieldCheck,
  Smartphone,
  TimerOff,
  UserRound,
} from 'lucide-react';
import { AuthDialog } from '@/components/auth-dialog';
import { RobotBindingMenu } from '@/components/robot-binding-menu';
import { McpBindingDialog } from '@/components/mcp-binding-dialog';
import { AdminMenu } from '@/components/admin-menu';
import { VillageParticles } from '@/components/village-particles';
import { MobileVillageHero } from '@/components/mobile-village-hero';
import { MobileTaskSheet } from '@/components/mobile-task-sheet';
import { TaskProgressCards } from '@/components/task-progress-cards';
import { SiteEnvironmentBadge } from '@/components/site-environment-badge';
import { SiteAchievement } from '@/components/site-achievement';
import { MainTaskSwitch } from '@/components/main-task-switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
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
import { deriveTaskProgress, hasCapturedScan, hasGameAuthorization, selectProgressRun } from '@/lib/task-progress';
import { isRunTerminal } from '@/lib/task-run';
import { deriveDailyCompletion } from '@/lib/daily-completion';
import { DEFAULT_USER_OPTIONS, getMainTask, parseUserOptions, type MainTask, type SecretRealmMode } from '../shared/user-options';
import { DEFAULT_LOGIN_TYPE, loginTypes, loginTypeLabels, loginScanApp, parseLoginType } from '../shared/login-types';

const secretRealmChoices: Array<{ value: SecretRealmMode; title: string }> = [
  { value: 'once', title: '仅刷一次' },
  { value: 'all', title: '消耗全部扫荡卷' },
  { value: 'skip', title: '不刷秘境' },
];

function ChannelBadge({ app }: { app: 'QQ' | '微信' }) {
  return <img className="ink-field-icon" src={app === 'QQ' ? '/icons/ink-qq.png' : '/icons/ink-wechat.png'}
    alt="" width="28" height="28" />;
}

const channelDevice = (type: string) => type.startsWith('ios_') ? 'iOS' : '安卓';

function LoginHelp({ mainTask = 'daily' }: { mainTask?: MainTask }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="使用帮助" title="使用帮助" className="scene-nav-button gap-2">
          <CircleHelp aria-hidden="true" />
          <span>使用帮助</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="login-help-dialog sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>扫码登录指南</DialogTitle>
          <DialogDescription>QQ 区用手机 QQ，微信区用微信。</DialogDescription>
        </DialogHeader>
        <ItemGroup className="py-1">
          {[
            ['获取授权二维码', '登录后选择账号归属和任务配置。二维码准备好后会自动显示。'],
            ['扫码并确认', '用对应的手机应用扫描二维码，在手机上确认登录。'],
            ['等待自动登录游戏', `进入游戏后自动执行${mainTask === 'arena_weekly' ? '决斗场周胜' : '日常任务'}，可在执行记录中查看进度。`],
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
          <AlertDescription>实例分配后保留 10 分钟供扫码，刷新不会延长占用时间。超时未扫码成功会自动关闭实例。扫码成功后继续执行{mainTask === 'arena_weekly' ? '周胜任务' : '日常'}。</AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const auth = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
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
    statusLabel,
    startLogin,
    refreshQr,
    retryQuery,
    handleQrError,
    acceptedRevision,
    confirmLogin,
    userOptions,
    canEditUserOptions,
    setMainTask,
    setEquipmentStamina,
    setSecretRealmMode,
    loginType,
    setLoginType,
    restoreTask,
    failTaskRestore,
  } = useLoginSession(auth.user?.id ?? null, auth.handleUnauthorized);
  const taskRun = useTaskRun(auth.user?.id ?? null, session, auth.handleUnauthorized);
  useEffect(() => {
    if (!auth.user) return;
    if (taskRun.restored) restoreTask(taskRun.task, taskRun.run);
    else if (taskRun.error) failTaskRestore();
  }, [auth.user?.id, taskRun.restored, taskRun.task, taskRun.run, taskRun.error, restoreTask, failTaskRestore]);
  useEffect(() => { setSubmissionRevision(null); setMobileDetailsOpen(false); setOptionsOpen(false); }, [auth.user?.id]);
  const resumeSaved = canResumePending && showGetButton;
  useEffect(() => {
    if (resumeSaved) setSubmissionRevision(acceptedRevision);
  }, [resumeSaved, acceptedRevision]);
  const awaitingSubmission = resumeSaved || (submissionRevision !== null && acceptedRevision === submissionRevision);

  function openLogin() {
    auth.clearError();
    setAuthOpen(true);
  }

  const progressInput = { phase, session, qrReady: phase === 'qr_ready' && Boolean(qrUrl), view: taskRun, awaitingSubmission };
  const visibleRun = selectProgressRun(progressInput);
  const currentRun = visibleRun.run;
  const initialDailyCompletion = deriveDailyCompletion(currentRun, visibleRun.task?.userOptions);
  const authorizedRun = hasGameAuthorization(currentRun) && (session?.id === currentRun?.taskId
    || !session && phase === 'idle' && ['finishing_login', 'running_daily'].includes(currentRun?.status ?? ''));
  const authorizationComplete = phase === 'login_confirmed' || authorizedRun;
  const scanCaptured = hasCapturedScan(progressInput);
  const scanComplete = authorizationComplete || scanCaptured;
  const terminalRun = Boolean(currentRun && isRunTerminal(currentRun.status));
  const restoringAuthorizedRun = !session && (authorizedRun || scanCaptured) && !terminalRun;
  const displayedUserOptions = restoringAuthorizedRun
    ? parseUserOptions(visibleRun.task?.userOptions) ?? DEFAULT_USER_OPTIONS : userOptions;
  const mainTask = getMainTask(displayedUserOptions);
  const isArenaWeekly = mainTask === 'arena_weekly';
  const canEditShownOptions = canEditUserOptions && !restoringAuthorizedRun;
  const displayedLoginType = restoringAuthorizedRun ? parseLoginType(visibleRun.task?.loginType) ?? DEFAULT_LOGIN_TYPE : loginType;
  const scanApp = loginScanApp(displayedLoginType);
  const ready = progressInput.qrReady && !scanComplete;
  const qrPending = pending && !scanComplete;
  const progress = deriveTaskProgress({ ...progressInput, qrReady: ready, mainTask });
  const ended = !pending && !canRetryQuery && (
    terminalRun || (!authorizedRun && (phase === 'expired' || phase === 'failed'))
  );
  const canStart = showGetButton && taskRun.restored && !pending && !canRetryQuery
    && (!scanComplete || ended);
  const canRefresh = !ended && !scanComplete && session && progress.taskId === session.id && remainingSeconds > 0
    && (ready || (canRetryQuery && session.status === 'qr_ready'));
  const resultTask = progress.taskId ? session ?? visibleRun.task : null;
  const resultTone = initialDailyCompletion ? 'partial' : progress.tone;
  const resultExpired = currentRun?.status === 'expired' || (!currentRun && phase === 'expired');
  const ResultIcon = resultTone === 'success' ? Check : resultExpired ? TimerOff : CircleAlert;
  const secretRealmTitle = secretRealmChoices.find(choice => choice.value === displayedUserOptions.secretRealmMode)!.title;
  const settingsPreview = [
    isArenaWeekly ? '决斗场周胜' : '日常任务', loginTypeLabels[displayedLoginType],
    ...(isArenaWeekly ? [] : [displayedUserOptions.equipmentStamina ? '已开启自动刷取装备' : '已停止自动刷取装备', secretRealmTitle]),
  ].join(' · ');
  useEffect(() => {
    if (session && currentRun?.taskId === session.id && hasGameAuthorization(currentRun)) {
      confirmLogin(session.id, isRunTerminal(currentRun.status));
    }
  }, [session?.id, currentRun?.taskId, currentRun?.status, currentRun?.authorizedAt, currentRun?.startedAt, confirmLogin]);
  const lockedSettings = Boolean(auth.user && !ended && !canEditShownOptions);

  return (
    <div className="login-shell min-h-svh text-foreground" data-main-task={mainTask} data-running={lockedSettings}>
      <div className="village-backdrop" aria-hidden="true">
        <picture>
          <source media="(max-width: 639px)" srcSet="/images/konoha-background-mobile.webp" />
          <img src="/images/konoha-background.webp" alt="" width="1536" height="1024" fetchPriority="high" />
        </picture>
        <VillageParticles />
      </div>
      <header className="village-header">
        <div className="village-header-inner">
          <div className="village-brand" aria-label="忍者日常">
            <img src="/icons/ink-leaf.png" alt="" width="34" height="34" />
            <span className="text-base font-bold tracking-wide">忍者日常<SiteEnvironmentBadge /></span>
          </div>
          <div className="scene-resources">
            <Button type="button" variant="ghost" size="sm" className="scene-nav-button scene-record-link"
              aria-label="打开任务记录" title="打开任务记录" onClick={() => setMobileDetailsOpen(true)}>
              <ListChecks aria-hidden="true" /><span>任务记录</span>
            </Button>
            <LoginHelp mainTask={mainTask} />
          </div>
          <div className="village-account">
            {auth.loading ? <Spinner aria-label="正在读取账户状态" className="size-4" /> : auth.user ? (
              <>
                <RobotBindingMenu key={`binding-${auth.user.id}`} userId={auth.user.id} busy={auth.busy} onUnauthorized={auth.handleUnauthorized} />
                {auth.user.isAdmin === true ? <AdminMenu key={`admin-${auth.user.id}`} userId={auth.user.id} refreshAuth={auth.refresh}
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
          </div>
        </div>
      </header>

      <main className="village-main" data-mobile-qr-ready={ready}>
        <h1 className="sr-only">任务中心</h1>
        <div className="village-achievement"><SiteAchievement /></div>
        <MobileVillageHero />
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
        <MainTaskSwitch value={mainTask} disabled={auth.loading || auth.busy || Boolean(auth.user && !canEditShownOptions)}
          locked={Boolean(auth.user && !canEditShownOptions)} onChange={setMainTask}>
          <Card className="login-card gap-0" data-authorized={authorizationComplete} data-phase={ended ? 'result' : ready ? 'qr_ready' : authorizationComplete ? 'authorized' : scanCaptured ? 'scan_captured' : phase}>
            <CardHeader className="gap-2 px-6 pb-5 sm:px-8">
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-lg font-semibold">
                任务工作台
              </CardTitle>
              {phase === 'idle' && !ended && !scanComplete && !resumeSaved && <CardDescription className="text-sm">
                {auth.user ? '选择区服及策略，再获取授权二维码。' : '先登录忍者日常账户，再获取二维码。'}
              </CardDescription>}
              {auth.user && !ended && !lockedSettings && <CardAction>
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Smartphone aria-hidden="true" />
                  {loginTypeLabels[displayedLoginType]}
                </Badge>
              </CardAction>}
            </CardHeader>
            <Separator />

            <CardContent className="flex flex-col items-center px-6 py-8 sm:px-8 sm:py-9">
              {ended ? (
                <section className="task-result" data-tone={resultTone} role="status" aria-live="polite" aria-atomic="true">
                  <span className="task-result-icon"><ResultIcon aria-hidden="true" /></span>
                  <h3>{progress.summary}</h3>
                  {resultTask && <p className="task-result-meta">
                    {progress.mainTask === 'arena_weekly' ? '决斗场周胜' : '日常任务'} · {loginTypeLabels[parseLoginType(resultTask.loginType) ?? DEFAULT_LOGIN_TYPE]}
                  </p>}
                  {(resultTone !== 'success' || !hasGameAuthorization(currentRun)) &&
                    <p className="task-result-detail">{progress.hint}</p>}
                </section>
              ) : !canRetryQuery && (phase !== 'idle' || scanComplete) && <div key={ready ? 'qr' : authorizationComplete ? 'authorized' : scanCaptured ? 'scan_captured' : phase} className="qr-frame w-full max-w-64" data-ready={ready ? 'true' : undefined} aria-busy={qrPending}>
                <div className="qr-content relative aspect-square overflow-hidden rounded-xl border border-dashed border-foreground/20 bg-transparent">
                  {ready && qrUrl ? (
                    <img
                      className="size-full object-contain"
                      src={qrUrl}
                      alt={`火影忍者 ${loginTypeLabels[displayedLoginType]}登录二维码，请使用手机${scanApp}扫码授权`}
                      onError={handleQrError}
                    />
                  ) : (
                    <div className="workbench-status">
                      <div className="workbench-status-icon" aria-hidden="true">
                        {scanComplete ? <CheckCheck /> : qrPending ? <Spinner className="motion-reduce:animate-none" />
                          : <img src="/icons/ink-leaf.png" alt="" width="26" height="26" />}
                      </div>
                      <div className="qr-copy" role="status">
                        <h3>{scanComplete ? progress.summary : statusLabel}</h3>
                        <p>{scanComplete ? progress.hint : '二维码准备好后会自动显示。'}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>}

              {!ended && !scanComplete && !canRetryQuery && (ready || retrying || remainingSeconds > 0) && <div className="login-status mt-5 flex min-h-6 flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm" role="status" aria-live="polite" aria-atomic="true">
                {(ready || retrying) && <span className="inline-flex items-center gap-2 text-muted-foreground">
                  {ready ? <Check className="size-4 text-primary" aria-hidden="true" /> : <Spinner aria-hidden="true" className="size-3.5 motion-reduce:animate-none" />}
                  {ready ? `请用手机${scanApp}扫码，并在${scanApp}中确认登录。` : '连接暂时中断，正在重试…'}
                </span>}
                {remainingSeconds > 0 && !showGetButton && (
                  <Badge variant="secondary" className="gap-1.5 font-mono tabular-nums" aria-label={`剩余 ${remainingSeconds} 秒`}>
                    <Clock3 aria-hidden="true" />
                    {countdown}
                  </Badge>
                )}
              </div>}

              {canRetryQuery && error && (
                <Alert variant="destructive" className="mt-5">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>申请状态暂时无法确认</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {canRetryQuery && auth.user && (
                <Button type="button" size="lg" className="login-action mt-6 h-12 w-full max-w-sm gap-2"
                  disabled={auth.busy} onClick={() => { if (!taskRun.restored) taskRun.retry(); else void retryQuery(); }}>
                  <RefreshCw aria-hidden="true" />{taskRun.restored && canResumePending ? '继续本次申请' : '重试连接'}
                </Button>
              )}
              {canRefresh && <Button type="button" size="lg" variant={ready ? 'default' : 'outline'}
                className={`qr-refresh-action mt-3 h-11 w-full max-w-sm gap-2 ${ready ? 'login-action' : ''}`}
                disabled={auth.busy} onClick={() => { void refreshQr(); }}>
                <RefreshCw aria-hidden="true" />刷新二维码
              </Button>}

              {auth.user && ended && canStart && <div className="next-run-config">
                <div className="next-run-heading">
                  <h3>下次运行计划</h3>
                  <Button variant="ghost" type="button" size="sm" aria-expanded={optionsOpen} aria-controls="run-options"
                    onClick={() => setOptionsOpen(open => !open)}>
                    <Settings2 aria-hidden="true" />{optionsOpen ? '隐藏配置' : '修改配置'}
                  </Button>
                </div>
                {!optionsOpen && <p>{settingsPreview}</p>}
              </div>}
              {lockedSettings && (progress.taskId || awaitingSubmission || canResumePending) && (
                <section className="locked-config" aria-label="本次任务配置">
                  <Settings2 aria-hidden="true" />
                  <div><h3>本次任务配置</h3><p>{settingsPreview}</p></div>
                </section>
              )}
              <div id="run-options" className="run-options w-full max-w-sm" hidden={lockedSettings || (ended && (!canStart || !optionsOpen))}>
              {auth.user && (
                <div className="login-channel mt-6 w-full max-w-sm space-y-2">
                  <label id="login-channel-label" htmlFor="login-channel-trigger" className="text-sm font-medium">账号归属</label>
                  {/* 非模态菜单保持页面滚动、固定背景和玻璃面板稳定。 */}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button id="login-channel-trigger" type="button" variant="outline"
                        aria-labelledby="login-channel-label" aria-describedby="login-channel-help"
                        disabled={auth.busy || !canEditShownOptions}
                        className="login-channel-trigger w-full justify-between font-normal">
                        <span className="login-channel-selection">
                          <ChannelBadge app={loginScanApp(displayedLoginType)} />
                          <span className="login-channel-copy">
                            <strong>{loginTypeLabels[displayedLoginType]}</strong>
                            <span>{loginScanApp(displayedLoginType)}扫码 · {channelDevice(displayedLoginType)}账号</span>
                          </span>
                        </span>
                        <span className="channel-chevron"><ChevronDown aria-hidden="true" className="size-4" /></span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" collisionPadding={8} className="login-channel-menu">
                      <DropdownMenuRadioGroup value={displayedLoginType} aria-labelledby="login-channel-label"
                        onValueChange={value => { const type = parseLoginType(value); if (type) setLoginType(type); }}>
                        {loginTypes.map(type => <DropdownMenuRadioItem key={type} value={type} aria-label={loginTypeLabels[type]} className="login-channel-option">
                          <ChannelBadge app={loginScanApp(type)} />
                          <span className="login-channel-copy">
                            <strong>{loginTypeLabels[type]}</strong>
                            <span>{loginScanApp(type)}扫码 · {channelDevice(type)}账号</span>
                          </span>
                        </DropdownMenuRadioItem>)}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <p id="login-channel-help" className="text-xs leading-5 text-muted-foreground">{canEditShownOptions ? '请选择游戏账号所在的区服。' : '本次申请的渠道已保存，刷新二维码会沿用此渠道。'}</p>
                </div>
              )}

              {auth.user && !isArenaWeekly && (
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
                    <span id="equipment-stamina-label" className="block text-sm font-medium">自动消耗体力刷取装备</span>
                    <span id="equipment-stamina-help" className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {canEditShownOptions ? '开启后，本次日常会进行装备栏体力刷取。' : '本次申请的选择已保存，重新申请时可修改。'}
                    </span>
                  </span>
                </label>
              )}

              {auth.user && !isArenaWeekly && (
                <div className="secret-realm-options mt-4 w-full max-w-sm space-y-2">
                  <label id="secret-realm-mode-label" htmlFor="secret-realm-mode-trigger" className="text-sm font-medium">秘境探险</label>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button id="secret-realm-mode-trigger" type="button" variant="outline"
                        aria-labelledby="secret-realm-mode-label" aria-describedby="secret-realm-mode-value" disabled={auth.busy || !canEditShownOptions}
                        className="login-channel-trigger w-full justify-between font-normal">
                        <span className="login-channel-selection">
                          <img className="ink-field-icon" src="/icons/ink-scroll.png" alt="" width="28" height="28" />
                          <span className="login-channel-copy"><strong id="secret-realm-mode-value">{secretRealmTitle}</strong></span>
                        </span>
                        <span className="channel-chevron"><ChevronDown aria-hidden="true" className="size-4" /></span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" collisionPadding={8} className="login-channel-menu secret-realm-menu">
                      <DropdownMenuRadioGroup value={displayedUserOptions.secretRealmMode} aria-labelledby="secret-realm-mode-label"
                        onValueChange={value => { const choice = secretRealmChoices.find(choice => choice.value === value); if (choice) setSecretRealmMode(choice.value); }}>
                        {secretRealmChoices.map(choice => <DropdownMenuRadioItem key={choice.value} value={choice.value}
                          className="login-channel-option">{choice.title}</DropdownMenuRadioItem>)}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

              </div>
              {!auth.loading && (!auth.user || canStart) && <Button
                type="button"
                size="lg"
                className="login-action mt-6 h-12 w-full max-w-sm gap-2 text-sm font-semibold"
                onClick={() => { if (auth.user) { setOptionsOpen(false); setSubmissionRevision(acceptedRevision); startLogin(); } else openLogin(); }}
                disabled={auth.busy}
              >
                {!auth.user ? <LogIn aria-hidden="true" /> : phase === 'idle' ? <QrCode aria-hidden="true" />
                    : <RefreshCw aria-hidden="true" />}
                {!auth.user ? '登录后获取二维码' : resumeSaved ? '继续本次申请' : ended ? '再次运行' : '获取授权二维码'}
                {phase === 'idle' && !auth.loading && <ArrowRight className="ml-1" aria-hidden="true" />}
              </Button>}
              {!ended && !scanComplete && <p className="qr-sharing-note mt-3 flex items-start gap-1.5 text-center text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {session?.loginStartedAt ? '实例保留 10 分钟供扫码，刷新不会延长占用' : '同一账户共用一个实例，分配后有 10 分钟扫码时间'}
              </p>}
              <MobileTaskSheet open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen} mainTask={progress.mainTask}>
                <TaskProgressCards progress={progress}>
                  {auth.user && (visibleRun.task || visibleRun.error) && <TaskRunPanel view={visibleRun} retry={taskRun.retry} />}
                  {progress.taskId && <p className="task-sheet-session">申请编号 <code>{progress.taskId}</code></p>}
                </TaskProgressCards>
              </MobileTaskSheet>
            </CardContent>
          </Card>
        </MainTaskSwitch>
      </main>
      <McpBindingDialog user={auth.user} authLoading={auth.loading} loginOpen={authOpen}
        onLogin={openLogin} onUnauthorized={auth.handleUnauthorized} />
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} busy={auth.busy}
        error={auth.error} clearError={auth.clearError} authenticate={auth.authenticate} />
    </div>
  );
}
