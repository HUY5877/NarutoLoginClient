import {
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  CircleHelp,
  Clock3,
  Gamepad2,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
  TimerOff,
} from 'lucide-react';
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

const preparationSteps = [
  { title: '提交登录申请', description: '为本次登录创建独立申请', icon: ArrowRight },
  { title: '准备游戏环境', description: '等待游戏进入二维码登录页', icon: Gamepad2 },
  { title: '获取登录二维码', description: '二维码准备好后会自动显示', icon: QrCode },
];

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
          <DialogDescription>每次生成都会创建一份独立的登录申请。</DialogDescription>
        </DialogHeader>
        <ItemGroup className="py-1">
          {[
            ['生成二维码', '点击「生成登录二维码」，提交本次登录申请。'],
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
          <AlertDescription>遇到连接中断时，页面会自动重试；仍然失败时，点击重新生成即可。</AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const {
    phase,
    session,
    qrUrl,
    error,
    retrying,
    pending,
    remainingSeconds,
    countdown,
    isError,
    statusLabel,
    startLogin,
    handleQrError,
  } = useLoginSession();

  const ready = phase === 'qr_ready' && Boolean(qrUrl);
  const activeStage = phase === 'submitting' ? 0
    : ['queued', 'starting_emulator', 'opening_game'].includes(phase) ? 1
      : phase === 'preparing_qr' ? 2
        : ready ? 3 : -1;

  return (
    <div className="login-shell min-h-svh text-foreground">
      <header className="border-b border-border/70 bg-white/85">
        <div className="mx-auto flex h-18 max-w-5xl items-center justify-between gap-3 px-5 sm:px-8">
          <div className="flex items-center gap-3" aria-label="忍者日常">
            <span className="headband-mark" aria-hidden="true">
              <img src="/icons/leaf-village.svg" alt="" width="32" height="32" />
            </span>
            <span className="text-base font-bold tracking-wide">忍者日常</span>
            <Separator orientation="vertical" className="mx-1 hidden h-5! sm:block" />
            <span className="hidden text-xs tracking-widest text-muted-foreground sm:block">木叶登录中心</span>
          </div>
          <LoginHelp />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
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
          <Card className="login-card gap-0 overflow-hidden shadow-sm">
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
              <div className="qr-frame w-full max-w-64" aria-busy={pending}>
                <AspectRatio ratio={1} className="overflow-hidden rounded-xl border border-dashed border-border bg-muted/35">
                  {ready && qrUrl ? (
                    <img
                      className="size-full object-contain"
                      src={qrUrl}
                      alt="本地模拟登录二维码，仅用于流程演示，不能登录真实账号"
                      onError={handleQrError}
                    />
                  ) : (
                    <>
                      {pending && <Skeleton className="absolute inset-0 size-full rounded-none motion-reduce:animate-none" />}
                      <Empty className="relative h-full gap-4 border-0 p-5 md:p-5">
                        <EmptyHeader className="gap-2.5">
                          <EmptyMedia variant="icon" className={`mb-1 size-16 rounded-2xl ${isError ? 'bg-destructive/10 text-destructive' : 'bg-white text-muted-foreground shadow-sm'}`}>
                            {pending ? <Spinner aria-hidden="true" className="size-6 motion-reduce:animate-none" />
                              : phase === 'expired' ? <TimerOff aria-hidden="true" />
                                : isError ? <CircleAlert aria-hidden="true" />
                                  : <img src="/icons/leaf-village.svg" alt="" width="42" height="42" aria-hidden="true" />}
                          </EmptyMedia>
                          <EmptyTitle className="text-base">
                            {phase === 'expired' ? '二维码已过期'
                              : isError ? '二维码准备失败'
                                : pending ? '正在准备二维码' : '你的木叶通行证'}
                          </EmptyTitle>
                          <EmptyDescription className="text-sm leading-6">
                            {isError ? '点击下方按钮重新生成'
                              : pending ? '请保持页面打开，准备好后会自动显示'
                                : '点击下方按钮，生成本次登录二维码'}
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
                  {retrying ? '连接暂时中断，正在重试…' : statusLabel}
                </span>
                {ready && (
                  <Badge variant="secondary" className="gap-1.5 font-mono tabular-nums" aria-label={`剩余 ${remainingSeconds} 秒`}>
                    <Clock3 aria-hidden="true" />
                    {countdown}
                  </Badge>
                )}
              </div>

              {error && phase === 'failed' && (
                <Alert variant="destructive" className="mt-5">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>暂时无法获取二维码</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                type="button"
                size="lg"
                className="mt-6 h-12 w-full max-w-sm gap-2 text-sm font-semibold shadow-sm"
                onClick={() => { void startLogin(); }}
                disabled={pending}
              >
                {pending ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
                  : phase === 'idle' ? <QrCode aria-hidden="true" />
                    : <RefreshCw aria-hidden="true" />}
                {pending ? '正在生成二维码…' : phase === 'idle' ? '生成登录二维码' : '重新生成二维码'}
                {phase === 'idle' && <ArrowRight className="ml-1" aria-hidden="true" />}
              </Button>
              <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                无需在此输入账号密码
              </p>
            </CardContent>

            <CardFooter className="flex-col items-stretch gap-4 border-t bg-muted/20 px-6 py-5 sm:px-8">
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
                      <p className="leading-6 text-muted-foreground">关闭页面后，可以重新生成新的登录二维码。</p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </CardFooter>
          </Card>

          <div className="space-y-5 lg:space-y-6">
            <Card className="gap-4 shadow-sm">
              <CardHeader className="gap-2">
                <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
                  <img src="/icons/shuriken.svg" alt="" width="19" height="19" aria-hidden="true" />
                  登录准备
                </CardTitle>
                <CardDescription className="text-sm">出发前，只需这三步。</CardDescription>
                <CardAction>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {ready ? '已就绪' : isError ? '已结束' : pending ? '准备中' : '待开始'}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ItemGroup aria-label="二维码准备进度" className="gap-1">
                  {preparationSteps.map(({ title, description, icon: StepIcon }, index) => {
                    const complete = activeStage > index;
                    const active = pending && activeStage === index;
                    return (
                      <Item key={title} role="listitem" size="sm" variant={active ? 'muted' : 'default'} className="items-start gap-3 px-2.5 py-3" aria-current={active ? 'step' : undefined}>
                        <ItemMedia variant="icon" className={`size-8 rounded-lg ${active || complete ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                          {complete ? <Check aria-hidden="true" />
                            : active ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
                              : <StepIcon aria-hidden="true" />}
                        </ItemMedia>
                        <ItemContent className="gap-1">
                          <ItemTitle className={active || complete ? 'text-sm' : 'text-sm text-muted-foreground'}>
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
                  {ready ? '模拟二维码已显示，可重新生成体验完整流程。'
                    : isError ? '本次申请已结束，重新生成即可再次尝试。'
                      : '准备时间可能稍有不同，无需手动刷新页面。'}
                </p>
              </CardContent>
            </Card>

            <Card className="gap-2 shadow-sm">
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
                  <AccordionItem value="expires" className="border-b-0">
                    <AccordionTrigger className="text-sm font-medium">二维码过期或生成失败怎么办？</AccordionTrigger>
                    <AccordionContent className="text-sm leading-6 text-muted-foreground">
                      点击「重新生成二维码」创建新的申请。如果持续失败，请确认本地登录服务已启动，再尝试生成。
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
          </div>
        </div>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-muted-foreground">
          <span className="flex items-center gap-2"><img src="/icons/leaf-village.svg" alt="" width="16" height="16" aria-hidden="true" />忍者日常 · 木叶相见</span>
          <span>模拟体验 · 非官方项目</span>
        </footer>
      </main>
    </div>
  );
}
