import { ArrowRight, Check, CircleAlert, CircleHelp, ListChecks, QrCode } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
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
          <CardAction>
            <Badge variant={progress.tone === 'danger' ? 'destructive' : 'outline'} className="font-normal" aria-label="任务整体状态">{progress.summary}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ItemGroup aria-label="任务执行进度" className="has-data-[size=sm]:gap-0">
            {progress.steps.map(({ id, title, description, state }, index) => {
              const StepIcon = stepIcons[id];
              const complete = state === 'completed', active = state === 'active', failed = state === 'failed';
              return (
                <Item key={id} role="listitem" data-stage={id} data-state={state} size="sm" variant={active ? 'muted' : 'default'}
                  className="relative items-start gap-3 px-2 py-2.5 after:absolute after:top-10 after:-bottom-3 after:left-[calc(0.5rem+0.875rem)] after:w-px after:bg-border last:after:hidden"
                  aria-current={active ? 'step' : undefined}>
                  <ItemMedia variant="icon" className={`relative z-1 size-7 rounded-full ${failed ? 'bg-destructive/10 text-destructive' : active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {failed ? <CircleAlert aria-hidden="true" /> : complete ? <Check aria-hidden="true" />
                      : active ? <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> : <StepIcon aria-hidden="true" />}
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0.5">
                    <ItemTitle className={`line-clamp-none text-sm leading-5 ${failed ? 'text-destructive' : active ? 'font-semibold' : complete ? '' : 'text-muted-foreground'}`}>
                      {index + 1}. {title}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm leading-5">{description}</ItemDescription>
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
        </CardContent>
      </Card>
      <Card className="village-glass faq-card gap-2">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base"><CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />常见问题</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible>
            <AccordionItem value="scan-app">
              <AccordionTrigger className="text-sm font-medium">我应该用哪个手机 App 扫码？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                QQ 区用手机 QQ，微信区用微信。扫码后在手机上确认登录。
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="account">
              <AccordionTrigger className="text-sm font-medium">刷新页面会开启新任务吗？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                同一账户的多个页面共用一个申请。刷新页面会自动查询原任务的进度。
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="expires">
              <AccordionTrigger className="text-sm font-medium">二维码失效了怎么办？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                实例仍可用时，点「刷新二维码」。实例已过期时，点「再次运行」。
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="connection" className="border-b-0">
              <AccordionTrigger className="text-sm font-medium">连接中断了怎么恢复？</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-muted-foreground">
                点「重试连接」查询状态。如果看到「继续本次申请」，点它恢复已保存的申请。
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </>
  );
}
