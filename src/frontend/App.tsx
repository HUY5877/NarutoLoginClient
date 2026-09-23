import { useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  CircleHelp,
  Clock3,
  LogIn,
  LogOut,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
  TimerOff,
} from 'lucide-react';
import { AuthDialog } from '@/components/auth-dialog';
import { AdminMenu } from '@/components/admin-menu';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AspectRatio } from '@/components/ui/aspect-ratio';
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
import { Spinner } from '@/components/ui/spinner';
import { useLoginSession } from '@/hooks/use-login-session';
import { useAuth } from '@/hooks/use-auth';

function LoginHelp() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
          <CircleHelp aria-hidden="true" />
          使用帮助
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>如何准备登录二维码</DialogTitle>
          <DialogDescription>先登录忍者日常账户，再准备游戏登录二维码。</DialogDescription>
        </DialogHeader>
        <ItemGroup className="py-1">
          {[
            ['登录并获取二维码', '注册申请审批通过后，登录账户并点击「生成登录二维码」。同账户的多个页面共用一份有效申请。'],
            ['等待准备完成', '保持页面打开，页面会自动更新准备进度和二维码。'],
            ['查看本次二维码', '当前是模拟环境，只能预览流程，扫描后不能登录真实账号。'],
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
          <AlertTitle>二维码过期后可以重新生成</AlertTitle>
          <AlertDescription>刷新后会继续查询同一份申请。连接中断时可重试查询；申请结束后再获取新的二维码。</AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const auth = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
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
    retryQuery,
    handleQrError,
  } = useLoginSession(auth.user?.id ?? null, auth.handleUnauthorized);

  function openLogin() {
    auth.clearError();
    setAuthOpen(true);
  }

  const ready = phase === 'qr_ready' && Boolean(qrUrl);
  const submitted = Boolean(session);
  const preparationSteps = [
    {
      id: 'submission',
      title: '提交登录申请',
      description: submitted ? '登录申请已提交'
        : phase === 'submitting' ? '正在提交本次登录申请'
          : phase === 'restoring' ? '正在检查本账户的有效申请'
            : canRetryQuery ? '申请状态尚未确认，请重试查询'
              : isError ? '本次申请已结束，可以重新获取' : '登录账户后提交本次申请',
      icon: ArrowRight,
      complete: submitted,
      active: phase === 'submitting' || phase === 'restoring',
      failed: isError && !submitted,
    },
    {
      id: 'qr',
      title: ready ? '获取成功'
        : canRetryQuery ? '等待查询确认' : isError && submitted ? '获取失败' : '正在唤醒服务器进程并获取二维码',
      description: ready ? '二维码已显示，请在有效期内扫码'
        : canRetryQuery ? '申请会保留，恢复连接后继续查询'
          : isError && submitted ? phase === 'expired' ? '二维码已过期，可重新获取' : '二维码获取失败，可重新获取'
          : submitted ? '请稍候，获取成功后会自动显示' : '提交申请后开始获取二维码',
      icon: QrCode,
      complete: ready,
      active: submitted && !ready && !isError,
      failed: isError && submitted,
    },
  ];

  return (
    <div className="login-shell min-h-svh text-foreground">
      <div className="village-backdrop" aria-hidden="true">
        <picture>
          <source media="(max-width: 639px)" srcSet="/images/konoha-background-mobile.webp" />
          <img src="/images/konoha-background.webp" alt="" width="1536" height="1024" fetchPriority="high" />
        </picture>
      </div>
      <header className="village-header border-b border-white/50">
        <div className="mx-auto flex min-h-18 max-w-5xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 sm:px-8">
          <div className="flex items-center gap-3" aria-label="忍者日常">
            <span className="headband-mark" aria-hidden="true">
              <img src="/icons/leaf-village.svg" alt="" width="32" height="32" />
            </span>
            <span className="text-base font-bold tracking-wide">忍者日常</span>
            <Separator orientation="vertical" className="mx-1 hidden h-5! sm:block" />
            <span className="hidden text-xs tracking-widest text-muted-foreground sm:block">木叶登录中心</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-3">
            {auth.loading ? <Spinner aria-label="正在读取账户状态" className="size-4" /> : auth.user ? (
              <>
                {auth.user.isAdmin === true && <AdminMenu key={auth.user.id} userId={auth.user.id} refreshAuth={auth.refresh} />}
                <span className="max-w-24 truncate text-sm font-medium sm:max-w-40" title={auth.user.username}>{auth.user.username}</span>
                <Button variant="ghost" size="sm" disabled={auth.busy} onClick={() => { void auth.logout(); }} className="gap-1.5">
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

      <main className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        {auth.error && !authOpen && (
          <Alert variant="destructive" className="village-glass mb-5" role="alert">
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
            <Badge variant="outline" className="mb-4 gap-1.5 border-primary/20 bg-white/75 px-2.5 py-1 text-xs font-medium text-primary">
              <img src="/icons/shuriken.svg" alt="" width="12" height="12" aria-hidden="true" />
              木叶集合 · 安卓 QQ 区
            </Badge>
            <h1 id="welcome-title" className="village-title">准备好，<br className="sm:hidden" />回到木叶。</h1>
            <p className="mt-3 max-w-70 text-sm leading-6 text-muted-foreground sm:max-w-none">
              生成登录二维码，<span className="inline-block">和安卓好友一起出发。</span>
            </p>
          </div>
          <img className="hero-seal" src="/icons/leaf-village.svg" alt="" width="240" height="240" aria-hidden="true" />
          <img className="village-portrait" src="/images/naruto-welcome.webp" alt="鸣人戴着木叶护额，握拳微笑" width="600" height="832" fetchPriority="high" />
        </section>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
          <Card className="village-glass login-card gap-0 overflow-hidden shadow-sm">
            <CardHeader className="gap-2 px-6 pb-6 sm:px-8">
              <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-lg font-semibold">
                <ScanLine className="size-5 text-primary" aria-hidden="true" />
                扫码登录
              </CardTitle>
              <CardDescription className="text-sm">火影忍者手游 · 与安卓好友玩</CardDescription>
              <CardAction>
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Smartphone aria-hidden="true" />
                  安卓 QQ 区
                </Badge>
              </CardAction>
            </CardHeader>
            <Separator />

            <CardContent className="flex flex-col items-center px-6 py-8 sm:px-8 sm:py-9">
              <div className="qr-frame w-full max-w-64" data-ready={ready ? 'true' : undefined} aria-busy={pending}>
                <AspectRatio ratio={1} className="overflow-hidden rounded-xl border border-dashed border-foreground/20 bg-transparent">
                  {ready && qrUrl ? (
                    <img
                      className="size-full object-contain"
                      src={qrUrl}
                      alt="本地模拟登录二维码，仅用于流程演示，不能登录真实账号"
                      onError={handleQrError}
                    />
                  ) : (
                    <>
                      {pending && <Skeleton className="absolute inset-0 size-full rounded-none bg-white/20 motion-reduce:animate-none" />}
                      <Empty className="relative h-full gap-4 border-0 p-5 md:p-5">
                        <EmptyHeader className="gap-2.5">
                          <EmptyMedia variant="icon" className={`mb-1 size-16 rounded-2xl ${isError ? 'bg-destructive/10 text-destructive' : 'bg-white/45 text-muted-foreground shadow-sm'}`}>
                            {pending ? <Spinner aria-hidden="true" className="size-6 motion-reduce:animate-none" />
                              : phase === 'expired' ? <TimerOff aria-hidden="true" />
                                : isError ? <CircleAlert aria-hidden="true" />
                                  : <img src="/icons/leaf-village.svg" alt="" width="42" height="42" aria-hidden="true" />}
                          </EmptyMedia>
                          <EmptyTitle className="text-base">
                            {phase === 'expired' ? '二维码已过期'
                              : canRetryQuery ? '等待查询确认' : isError ? '二维码准备失败'
                                : phase === 'restoring' ? '正在查询登录申请' : pending ? '正在准备二维码' : '你的木叶通行证'}
                          </EmptyTitle>
                          <EmptyDescription className="text-sm leading-6">
                            {canRetryQuery ? canResumePending ? '点击「继续本次申请」恢复已保存的申请' : '点击「重试查询」继续查看本次申请'
                              : isError ? '确认本次申请结束后，可以重新获取'
                              : pending ? '刷新或重新打开页面也会继续本次申请'
                                : auth.user ? '点击下方按钮，生成本次登录二维码' : '先登录忍者日常账户，再获取二维码'}
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </>
                  )}
                </AspectRatio>
              </div>

              <div className="mt-5 flex min-h-6 flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm" role="status" aria-live="polite" aria-atomic="true">
                <span className={`inline-flex items-center gap-2 ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {pending ? <Spinner aria-hidden="true" className="size-3.5 motion-reduce:animate-none" />
                    : ready ? <Check className="size-4 text-primary" aria-hidden="true" />
                      : <Clock3 className="size-3.5" aria-hidden="true" />}
                  {auth.loading ? '正在读取账户状态' : !auth.user ? '登录后即可获取二维码' : retrying ? '连接暂时中断，正在重试…' : statusLabel}
                </span>
                {auth.user && remainingSeconds > 0 && !showGetButton && (
                  <Badge variant="secondary" className="gap-1.5 font-mono tabular-nums" aria-label={`剩余 ${remainingSeconds} 秒`}>
                    <Clock3 aria-hidden="true" />
                    {countdown}
                  </Badge>
                )}
              </div>

              {error && (phase === 'failed' || canRetryQuery) && (
                <Alert variant="destructive" className="mt-5">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{canRetryQuery ? '申请状态暂时无法确认' : '本次二维码准备失败'}</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {!auth.loading && (!auth.user || showGetButton) && <Button
                type="button"
                size="lg"
                className="mt-6 h-12 w-full max-w-sm gap-2 text-sm font-semibold shadow-sm"
                onClick={() => { if (auth.user) void startLogin(); else openLogin(); }}
                disabled={auth.busy || pending}
              >
                {!auth.user ? <LogIn aria-hidden="true" /> : phase === 'idle' ? <QrCode aria-hidden="true" />
                    : <RefreshCw aria-hidden="true" />}
                {!auth.user ? '登录后获取二维码' : phase === 'idle' ? '生成登录二维码' : '重新生成二维码'}
                {phase === 'idle' && !auth.loading && <ArrowRight className="ml-1" aria-hidden="true" />}
              </Button>}
              {canRetryQuery && auth.user && (
                <Button type="button" variant="outline" size="lg" className="mt-6 h-12 w-full max-w-sm gap-2 bg-white/40"
                  disabled={auth.busy || pending} onClick={() => { void retryQuery(); }}>
                  <RefreshCw aria-hidden="true" />{canResumePending ? '继续本次申请' : '重试查询'}
                </Button>
              )}
              {auth.user && ready && <p className="mt-5 text-sm font-medium text-primary">二维码有效，请在倒计时结束前扫码</p>}
              <p className="mt-3 flex items-start gap-1.5 text-center text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                同一账户的多个页面共用一个有效二维码
              </p>
            </CardContent>

            <CardFooter className="login-card-footer flex-col items-stretch gap-4 border-t px-6 py-5 sm:px-8">
              <Alert className="border-0 bg-transparent p-0 text-muted-foreground">
                <CircleAlert aria-hidden="true" />
                <AlertTitle className="text-sm font-medium text-foreground">当前为模拟登录演示</AlertTitle>
                <AlertDescription className="text-sm leading-6">
                  二维码仅用于预览登录流程，不能授权或登录真实账号。
                </AlertDescription>
              </Alert>
              {session && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="session" className="border-b-0 border-t">
                    <AccordionTrigger className="py-3 text-sm font-normal text-muted-foreground">本次申请详情</AccordionTrigger>
                    <AccordionContent className="space-y-3 pb-1 text-sm">
                      <div className="space-y-1.5">
                        <p className="text-muted-foreground">申请编号</p>
                        <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">{session.id}</code>
                      </div>
                      <p className="leading-6 text-muted-foreground">刷新或重新打开页面会继续本次申请；二维码过期后可重新生成。</p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </CardFooter>
          </Card>

          <div className="space-y-5 lg:space-y-6">
            <Card className="village-glass gap-4 shadow-sm">
              <CardHeader className="gap-2">
                <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
                  <img src="/icons/shuriken.svg" alt="" width="19" height="19" aria-hidden="true" />
                  登录准备
                </CardTitle>
                <CardDescription className="text-sm">提交申请，等待二维码。</CardDescription>
                <CardAction>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {ready ? '获取成功' : canRetryQuery ? '待确认' : isError ? '获取失败' : phase !== 'idle' ? '获取中' : '待开始'}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ItemGroup aria-label="二维码准备进度" className="gap-1">
                  {preparationSteps.map(({ id, title, description, icon: StepIcon, complete, active, failed }) => {
                    return (
                      <Item key={id} role="listitem" size="sm" variant={active ? 'muted' : 'default'} className="items-start gap-3 px-2.5 py-3" aria-current={active ? 'step' : undefined}>
                        <ItemMedia variant="icon" className={`size-8 rounded-lg ${failed ? 'bg-destructive/10 text-destructive' : active || complete ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                          {failed ? <CircleAlert aria-hidden="true" />
                            : complete ? <Check aria-hidden="true" />
                            : active ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
                              : <StepIcon aria-hidden="true" />}
                        </ItemMedia>
                        <ItemContent className="min-w-0 gap-1">
                          <ItemTitle className={`line-clamp-none text-sm leading-6 ${failed ? 'text-destructive' : active || complete ? '' : 'text-muted-foreground'}`}>
                            {title}
                          </ItemTitle>
                          <ItemDescription className="line-clamp-none text-sm leading-6">{description}</ItemDescription>
                        </ItemContent>
                      </Item>
                    );
                  })}
                </ItemGroup>
                <Separator className="my-4" />
                <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                  {ready ? <CheckCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
                    : <Clock3 className="mt-1 size-4 shrink-0" aria-hidden="true" />}
                  {ready ? '获取成功，二维码已自动显示。'
                    : canRetryQuery ? canResumePending ? '继续提交已保存的申请，刷新后也会使用同一份申请。' : '点击「重试查询」恢复状态，不会创建新的申请。'
                      : isError ? '本次申请结束后，可以重新获取二维码。'
                        : '申请进度会持续保留，刷新页面后会自动继续查询。'}
                </p>
              </CardContent>
            </Card>

            <Card className="village-glass gap-2 shadow-sm">
              <CardHeader>
                <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
                  <CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />
                  常见问题
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Accordion type="single" collapsible>
                  <AccordionItem value="simulation">
                    <AccordionTrigger className="text-sm font-medium">现在可以登录游戏吗？</AccordionTrigger>
                    <AccordionContent className="text-sm leading-6 text-muted-foreground">
                      暂时不可以。当前提供模拟二维码，用于体验申请、等待和显示二维码的完整流程。
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="account">
                    <AccordionTrigger className="text-sm font-medium">多个页面能同时获取二维码吗？</AccordionTrigger>
                    <AccordionContent className="text-sm leading-6 text-muted-foreground">
                      同一账户同时只有一个有效申请。刷新、重新登录或打开新页面都会恢复已有二维码，过期或准备失败后才能重新申请。
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="expires" className="border-b-0">
                    <AccordionTrigger className="text-sm font-medium">二维码过期或生成失败怎么办？</AccordionTrigger>
                    <AccordionContent className="text-sm leading-6 text-muted-foreground">
                      页面确认没有有效申请后，会显示「重新生成二维码」。网络中断时先点击「重试查询」，继续查看已有申请。
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
          </div>
        </div>

        <footer className="village-footer mt-6 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-muted-foreground">
          <span className="flex items-center gap-2"><img src="/icons/leaf-village.svg" alt="" width="16" height="16" aria-hidden="true" />忍者日常 · 木叶相见</span>
          <span>模拟体验 · 非官方项目</span>
        </footer>
      </main>
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} busy={auth.busy}
        error={auth.error} clearError={auth.clearError} authenticate={auth.authenticate} />
    </div>
  );
}
