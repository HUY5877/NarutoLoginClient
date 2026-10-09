import { ArrowRight, Check, CheckCheck, CircleAlert, CircleHelp, Clock3, ListChecks, QrCode } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import type { deriveTaskProgress } from '@/lib/task-progress';

const stepIcons = { submission: ArrowRight, qr: QrCode, script: ListChecks };

export function TaskProgressCards({ progress }: { progress: ReturnType<typeof deriveTaskProgress> }) {
  return (
    <>
      <Card className="village-glass preparation-card gap-4">
        <CardHeader className="gap-2">
          <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
            <img src="/icons/shuriken.svg" alt="" width="19" height="19" aria-hidden="true" />任务进度
          </CardTitle>
          <CardDescription className="text-sm">二维码准备到哪了、日常跑到哪了，都在这里看。</CardDescription>
          <CardAction>
            <Badge variant={progress.tone === 'danger' ? 'destructive' : 'outline'} className="font-normal" aria-label="任务整体状态">{progress.summary}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ItemGroup aria-label="任务执行进度" className="gap-1">
            {progress.steps.map(({ id, title, description, state }, index) => {
              const StepIcon = stepIcons[id];
              const complete = state === 'completed', active = state === 'active', failed = state === 'failed';
              return (
                <Item key={id} role="listitem" data-stage={id} data-state={state} size="sm" variant={active ? 'muted' : 'default'} className="items-start gap-3 px-2.5 py-3" aria-current={active ? 'step' : undefined}>
                  <ItemMedia variant="icon" className={`size-8 rounded-lg ${failed ? 'bg-destructive/10 text-destructive' : active || complete ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {failed ? <CircleAlert aria-hidden="true" /> : complete ? <Check aria-hidden="true" />
                      : active ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> : <StepIcon aria-hidden="true" />}
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-1">
                    <ItemTitle className={`line-clamp-none text-sm leading-6 ${failed ? 'text-destructive' : active || complete ? '' : 'text-muted-foreground'}`}>
                      {index + 1}. {title}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm leading-6">{description}</ItemDescription>
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
          <Separator className="my-4" />
          <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            {progress.tone === 'success' ? <CheckCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" /> : <Clock3 className="mt-1 size-4 shrink-0" aria-hidden="true" />}
            {progress.hint}
          </p>
        </CardContent>
      </Card>
      <Card className="village-glass faq-card gap-2">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base"><CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />常见问题</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible>
            <AccordionItem value="simulation">
              <AccordionTrigger className="text-sm font-medium">现在可以登录游戏吗？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                执行服务器生成游戏二维码后，使用手机 QQ 扫码并确认授权即可。授权完成后无需再次扫码，系统会继续进入游戏和执行日常脚本。
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="account">
              <AccordionTrigger className="text-sm font-medium">多个页面能同时获取二维码吗？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                同一账户同时只有一个有效申请。每个页面点击「生成登录二维码」后查询并复用已有申请，过期或准备失败后才能重新申请。
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="expires" className="border-b-0">
              <AccordionTrigger className="text-sm font-medium">二维码过期或生成失败怎么办？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                过期或准备失败后可点击「重新生成二维码」，服务端会先检查已有申请。网络中断时点击「重试查询」，继续查看本次申请。
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </>
  );
}
