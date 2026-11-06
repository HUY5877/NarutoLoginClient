import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, CircleCheck, CircleX, Clock3, FlaskConical, Info, KeyRound, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2, Waves, X } from 'lucide-react';
import type { ModelChannel, ModelChannelKeyInput, ModelChannelTestResult } from '../../shared/model-channels';
import { useAdminData } from '@/hooks/use-admin';
import { adminRequest, AdminRequestError } from '@/lib/admin';
import { isModelChannel, isModelChannelsResponse, isModelChannelTestResult } from '@/lib/model-channels';
import { AdminError, AdminLoading } from '@/components/admin-common';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import './admin-model-channels.css';

interface KeyDraft { rowId: number; id?: string; masked?: string; value: string; editing?: boolean }
interface ChannelActivity { busy: boolean; dirty: boolean }
const savedKeys = (channel: ModelChannel): KeyDraft[] => channel.keys.map((key, rowId) => ({ ...key, rowId, value: '' }));
const draftSignature = (model: string, enabled: boolean, keys: KeyDraft[]) => JSON.stringify({ model: model.trim(), enabled,
  keys: keys.map(key => key.value.trim() ? { value: key.value.trim() } : key.id ? { id: key.id } : { value: '' }) });

function KeyTestResult({ result, label }: { result: ModelChannelTestResult; label: string }) {
  const Icon = result.ok ? CircleCheck : CircleX;
  return <Alert role={result.ok ? 'status' : 'alert'} aria-label={label} aria-atomic="true"
    className={`model-key-result min-w-0 gap-y-1 px-3 py-2.5 has-[>svg]:grid-cols-[auto_minmax(0,1fr)] ${result.ok
      ? 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100'
      : 'border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-100'}`}>
    <Icon aria-hidden="true" className="size-4.5" />
    <AlertTitle className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
      <span>{result.ok ? '测试成功' : '测试失败'}</span>
      <Badge variant="outline" className="ml-auto h-6 gap-1 border-current/15 bg-white/60 font-mono font-normal text-inherit dark:bg-white/5">
        <Clock3 aria-hidden="true" />{Math.round(result.latencyMs)} ms
      </Badge>
    </AlertTitle>
    <AlertDescription className={`col-start-2 min-w-0 text-xs leading-5 [overflow-wrap:anywhere] ${result.ok
      ? 'text-emerald-800 dark:text-emerald-200' : 'text-rose-800 dark:text-rose-200'}`}>{result.message}</AlertDescription>
  </Alert>;
}

function ChannelEditor({ channel, expanded, loading, onAccessLost, onActivity, onExpand }: {
  channel: ModelChannel; expanded: boolean; loading: boolean; onAccessLost: () => void;
  onActivity: (id: string, activity: ChannelActivity) => void;
  onExpand: (id: string) => void;
}) {
  const [version, setVersion] = useState(channel.version);
  const [configurationError, setConfigurationError] = useState(channel.configurationError ?? '');
  const [model, setModel] = useState(channel.model);
  const [enabled, setEnabled] = useState(channel.enabled);
  const [keys, setKeys] = useState(() => savedKeys(channel));
  const [baseline, setBaseline] = useState(() => draftSignature(channel.model, channel.enabled, savedKeys(channel)));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [results, setResults] = useState<Record<number, ModelChannelTestResult>>({});
  const request = useRef<AbortController | null>(null);
  const nextRowId = useRef(channel.keys.length);
  const disabled = loading || busy !== null;
  const dirty = draftSignature(model, enabled, keys) !== baseline;
  const ProviderIcon = channel.id === 'openai' ? Sparkles : Waves;

  useEffect(() => {
    setVersion(channel.version); setConfigurationError(channel.configurationError ?? '');
    setModel(channel.model); setEnabled(channel.enabled); setKeys(savedKeys(channel));
    nextRowId.current = channel.keys.length;
    setBaseline(draftSignature(channel.model, channel.enabled, savedKeys(channel)));
    setStale(false); setError(''); setNotice(''); setResults({});
  }, [channel]);
  useEffect(() => { onActivity(channel.id, { busy: busy !== null, dirty }); }, [channel.id, busy, dirty, onActivity]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  function edited() {
    setNotice(''); setResults({});
    if (!stale) setError('');
  }
  function removeKey(key: KeyDraft) {
    const remaining = keys.filter(item => item.rowId !== key.rowId);
    setKeys(remaining); edited();
    if (remaining.length === 0) {
      setEnabled(false);
      if (key.id) setNotice('最后一条密钥已删除，渠道已关闭，保存后生效。');
    }
  }
  function cancelKeyEdit(key: KeyDraft) {
    if (!key.id) { removeKey(key); return; }
    setKeys(current => current.map(item => item.rowId === key.rowId ? { ...item, value: '', editing: false } : item));
    edited();
  }
  function keyInput(key: KeyDraft): ModelChannelKeyInput | null {
    const value = key.value.trim();
    if (value) return { value };
    return key.id ? { id: key.id } : null;
  }
  function validateModel(required: boolean) {
    if ((required && !model.trim()) || [...model.trim()].length > 200) { setError('启用或测试时必须填写模型名称，最多 200 个字符。'); return false; }
    return true;
  }
  function validateKey(key: KeyDraft) {
    if ([...key.value.trim()].length > 512) { setError('每个密钥最多 512 个字符。'); return false; }
    if (!keyInput(key)) { setError('请填写新增的密钥，或删除空白密钥。'); return false; }
    return true;
  }
  async function run(kind: 'save' | 'test', selected?: KeyDraft) {
    if (request.current || loading || stale || !validateModel(kind === 'test' || enabled)) return;
    if (kind === 'save' && (keys.length > 20 || !keys.every(validateKey))) return;
    if (kind === 'test' && (!selected || !validateKey(selected))) return;
    if (kind === 'test' && configurationError && selected?.id && !selected.value.trim()) {
      setError('请先保存修复配置，再测试已有密钥。'); return;
    }
    if (kind === 'save' && enabled && keys.length === 0) { setError('启用渠道前至少需要一个密钥。'); return; }
    const controller = new AbortController(); request.current = controller;
    const started = performance.now();
    onActivity(channel.id, { busy: true, dirty });
    setBusy(kind === 'save' ? 'save' : `test-${selected!.rowId}`); setError(''); setNotice('');
    if (selected) setResults(current => { const next = { ...current }; delete next[selected.rowId]; return next; });
    try {
      const result = await adminRequest(`/api/admin/model-channels/${channel.id}${kind === 'test' ? '/test' : ''}`,
        controller.signal, kind === 'test' ? 'POST' : 'PUT', kind === 'test'
          ? { model: model.trim(), key: keyInput(selected!) }
          : { version, model: model.trim(), enabled, keys: keys.map(keyInput) }, kind === 'test' ? 25_000 : 15_000);
      if (request.current !== controller) return;
      if (kind === 'test') {
        if (!isModelChannelTestResult(result)) throw new Error('测试结果异常，请重试。');
        setResults(current => ({ ...current, [selected!.rowId]: result }));
      } else {
        if (!isModelChannel(result) || result.id !== channel.id) {
          setStale(true);
          throw new Error('保存结果尚未确认。请重新读取配置后再操作。');
        }
        setVersion(result.version); setConfigurationError(result.configurationError ?? '');
        setModel(result.model); setEnabled(result.enabled); setKeys(savedKeys(result));
        nextRowId.current = result.keys.length;
        setBaseline(draftSignature(result.model, result.enabled, savedKeys(result))); setResults({});
        setNotice('更改已保存。重启 Worker 后生效。');
      }
    } catch (caught) {
      if (request.current !== controller) return;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) { onAccessLost(); return; }
      let message: string;
      if (caught instanceof AdminRequestError && caught.status === 409) {
        setStale(true);
        const conflictMessage = '配置已被修改，当前配置版本已失效。草稿仍保留，请重新读取配置后再编辑；重新读取会丢弃未保存修改。';
        setError(conflictMessage);
        message = kind === 'test' ? '当前配置已变更，请重新读取配置后再测试。' : conflictMessage;
      } else if (caught instanceof Error && ['AbortError', 'TimeoutError'].includes(caught.name)) {
        if (kind === 'save') setStale(true);
        message = kind === 'save' ? '保存超时，结果尚未确认。请重新读取配置后再操作。' : '测试超时，请重试。';
      } else message = caught instanceof Error ? caught.message : '请求失败，请重试。';
      if (kind === 'test' && selected) {
        setResults(current => ({ ...current, [selected.rowId]: { ok: false, latencyMs: performance.now() - started, message } }));
      } else setError(message);
    } finally {
      if (request.current === controller) { request.current = null; setBusy(null); }
    }
  }

  return <AccordionItem value={channel.id} role="group" aria-label={`${channel.name}渠道`} aria-busy={busy !== null}
    className="model-provider">
    <div className="model-provider-summary">
      <AccordionTrigger aria-label={`${channel.name}设置`} className="model-provider-trigger" disabled={loading}>
        <span className={`model-provider-icon model-provider-icon-${channel.id}`}><ProviderIcon aria-hidden="true" /></span>
        <span className="model-provider-identity">
          <span className="model-provider-name">{channel.name}{dirty && <span className="model-draft-dot" title="有未保存的修改"><span className="sr-only">未保存</span></span>}</span>
          <span className="model-provider-model">{model.trim() || '尚未配置模型'}</span>
        </span>
        <span className="model-provider-key-count">{keys.length} 个密钥</span>
      </AccordionTrigger>
      <label className="model-provider-toggle" htmlFor={`channel-${channel.id}-enabled`}>
        <span>{enabled ? '已启用' : '已关闭'}</span>
        <Switch id={`channel-${channel.id}-enabled`} aria-label={`启用${channel.name}渠道`} checked={enabled} disabled={disabled}
          onCheckedChange={value => { setEnabled(value); edited(); onExpand(channel.id); }} />
      </label>
    </div>
    <AccordionContent forceMount hidden={!expanded} className="model-channel-body">
      {configurationError && <Alert role="alert" className="model-config-warning border-amber-600/30 bg-amber-50">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{configurationError} 请重新填写模型或密钥后保存。已有密钥需修复保存后再测试，新填密钥可直接测试。</AlertDescription>
      </Alert>}
      <div className="model-field-row">
        <div><Label htmlFor={`channel-${channel.id}-model`}>模型名称</Label><p>用于该服务商的所有密钥</p></div>
        <Input id={`channel-${channel.id}-model`} value={model} maxLength={400} autoComplete="off" disabled={disabled}
          className="model-id-input" placeholder="输入模型 ID" onChange={event => { setModel([...event.target.value].slice(0, 200).join('')); edited(); }} />
      </div>
      <div className="model-keys-heading">
        <div><h4>API 密钥 <span>{keys.length} / 20</span></h4><p>密钥按顺序轮询，可单独测试连接。</p></div>
        <Button type="button" size="sm" variant="outline" disabled={disabled || keys.length >= 20}
          onClick={() => { const rowId = nextRowId.current++; setKeys(current => [...current, { rowId, value: '', editing: true }]); edited(); }}><Plus aria-hidden="true" />新增密钥</Button>
      </div>
      <div className="model-key-list">
        {keys.length === 0 && <div className="model-keys-empty"><KeyRound aria-hidden="true" /><p>尚未添加 API 密钥</p><span>添加密钥后即可测试连接</span></div>}
        {keys.map((key, index) => <div key={key.rowId} role="group" aria-label={`密钥 ${index + 1} 配置`} className="model-key-row">
          <div className={`model-key-row-main ${key.editing || !key.id ? 'is-editing' : ''}`}>
            <KeyRound aria-hidden="true" className="model-key-icon" />
            <div className="model-key-value">
              <Label className="sr-only" htmlFor={`channel-${channel.id}-key-${key.rowId}`}>密钥 {index + 1}</Label>
              {key.editing || !key.id ? <Input id={`channel-${channel.id}-key-${key.rowId}`} type="password" value={key.value} maxLength={1024}
                autoComplete="new-password" spellCheck={false} autoFocus disabled={disabled} placeholder={key.id ? '输入替换密钥，留空保留原值' : '输入新的 API 密钥'}
                onChange={event => { const value = [...event.target.value].slice(0, 512).join(''); setKeys(current => current.map(item => item.rowId === key.rowId ? { ...item, value } : item)); edited(); }} />
                : <code>{key.masked}</code>}
              <span className="model-key-caption">密钥 {index + 1}{key.value.trim() ? ' · 待保存' : key.id ? ' · 已保存' : ' · 新增'}</span>
            </div>
            <div className="model-key-actions">
              <Button type="button" size="icon-sm" variant="ghost" title="测试连接" aria-label={`测试密钥 ${index + 1}`}
                disabled={disabled || stale || Boolean(configurationError && key.id && !key.value.trim())} onClick={() => { void run('test', key); }}>
                {busy === `test-${key.rowId}` ? <Spinner aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}
              </Button>
              {key.editing || !key.id ? <Button type="button" size="icon-sm" variant="ghost" title="取消编辑" aria-label={`取消编辑密钥 ${index + 1}`}
                disabled={disabled} onClick={() => cancelKeyEdit(key)}><X aria-hidden="true" /></Button>
                : <Button type="button" size="icon-sm" variant="ghost" title="替换密钥" aria-label={`替换密钥 ${index + 1}`}
                  disabled={disabled} onClick={() => setKeys(current => current.map(item => item.rowId === key.rowId ? { ...item, editing: true } : item))}><Pencil aria-hidden="true" /></Button>}
              <Button type="button" size="icon-sm" variant="ghost" className="model-key-delete" title="删除密钥" aria-label={`删除密钥 ${index + 1}`}
                disabled={disabled} onClick={() => removeKey(key)}><Trash2 aria-hidden="true" /></Button>
            </div>
          </div>
          {results[key.rowId] && <KeyTestResult result={results[key.rowId]} label={`密钥 ${index + 1} 测试结果`} />}
        </div>)}
      </div>
      <AdminError message={error} />
      {notice && <Alert role="status" className="model-save-notice"><Check aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert>}
      <div className="model-channel-footer">
        <span>{dirty ? '有未保存的更改' : '测试连接不会保存配置'}</span>
        <Button type="button" size="sm" disabled={disabled || stale} onClick={() => { void run('save'); }}>
          {busy === 'save' ? <Spinner aria-hidden="true" /> : <Save aria-hidden="true" />}保存更改
        </Button>
      </div>
    </AccordionContent>
  </AccordionItem>;
}

export function AdminModelChannels({ open, onOpenChange, onAccessLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAccessLost: () => void; returnFocus: () => void;
}) {
  const { data, loading, error, reload } = useAdminData(open ? '/api/admin/model-channels' : null, isModelChannelsResponse, onAccessLost);
  const [activity, setActivity] = useState<Record<string, ChannelActivity>>({});
  const [expanded, setExpanded] = useState('');
  const [confirmReload, setConfirmReload] = useState(false);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const dialogContent = useRef<HTMLDivElement>(null);
  const onActivity = useCallback((id: string, value: ChannelActivity) => setActivity(current => ({ ...current, [id]: value })), []);
  const busy = Object.values(activity).some(value => value.busy);
  const dirty = Object.values(activity).some(value => value.dirty);
  useEffect(() => { if (!open) { setExpanded(''); setActivity({}); setConfirmReload(false); } }, [open]);
  return <><Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent ref={dialogContent} className="model-settings-dialog"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="model-settings-header">
        <div className="model-settings-title-row"><DialogTitle>大模型渠道</DialogTitle>
          {data && <Badge variant="outline" className="model-environment-badge">{data.environment === 'prod' ? '正式环境' : '测试环境'}</Badge>}
        </div>
        <DialogDescription>配置服务商、模型与 API 密钥</DialogDescription>
      </DialogHeader>
      <div className="model-settings-toolbar">
        <span>服务商 <span className="model-provider-total">{data?.channels.length ?? '—'}</span></span>
        <Button ref={reloadButton} type="button" size="sm" variant="ghost" disabled={loading || busy} onClick={() => { if (dirty) setConfirmReload(true); else void reload(); }}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}重新读取
        </Button>
      </div>
      <div className="model-settings-scroll" aria-busy={loading}>
        <AdminError message={error} />
        {loading && !data && <AdminLoading label="正在读取大模型渠道…" />}
        <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
          {data?.channels.map(channel => <ChannelEditor key={channel.id} channel={channel} expanded={expanded === channel.id} loading={loading}
            onAccessLost={onAccessLost} onActivity={onActivity} onExpand={setExpanded} />)}
        </Accordion>
      </div>
      <div className="model-settings-note"><Info aria-hidden="true" /><span>保存后需重启 Worker 生效。</span></div>
    </DialogContent>
  </Dialog>
    <AlertDialog open={confirmReload} onOpenChange={setConfirmReload}>
      <AlertDialogContent className="model-settings-confirm" onCloseAutoFocus={event => {
        event.preventDefault();
        if (open) (reloadButton.current?.disabled ? dialogContent.current : reloadButton.current)?.focus();
      }}>
        <AlertDialogHeader><AlertDialogTitle>重新读取配置？</AlertDialogTitle>
          <AlertDialogDescription>这会丢弃所有服务商未保存的修改。已保存的配置不受影响。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { void reload(); }}>重新读取</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
