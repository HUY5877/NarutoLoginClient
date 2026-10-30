import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Cpu, FlaskConical, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { ModelChannel, ModelChannelKeyInput, ModelChannelTestResult } from '../../shared/model-channels';
import { useAdminData } from '@/hooks/use-admin';
import { adminRequest, AdminRequestError } from '@/lib/admin';
import { isModelChannel, isModelChannelsResponse, isModelChannelTestResult } from '@/lib/model-channels';
import { AdminError, AdminLoading } from '@/components/admin-common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

interface KeyDraft { rowId: number; id?: string; masked?: string; value: string }
interface ChannelActivity { busy: boolean; dirty: boolean }
const savedKeys = (channel: ModelChannel): KeyDraft[] => channel.keys.map((key, rowId) => ({ ...key, rowId, value: '' }));

function ChannelEditor({ channel, loading, onAccessLost, onActivity }: {
  channel: ModelChannel; loading: boolean; onAccessLost: () => void;
  onActivity: (id: string, activity: ChannelActivity) => void;
}) {
  const [version, setVersion] = useState(channel.version);
  const [configurationError, setConfigurationError] = useState(channel.configurationError ?? '');
  const [model, setModel] = useState(channel.model);
  const [enabled, setEnabled] = useState(channel.enabled);
  const [keys, setKeys] = useState(() => savedKeys(channel));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [results, setResults] = useState<Record<number, ModelChannelTestResult>>({});
  const request = useRef<AbortController | null>(null);
  const nextRowId = useRef(channel.keys.length);
  const disabled = loading || busy !== null;

  useEffect(() => {
    setVersion(channel.version); setConfigurationError(channel.configurationError ?? '');
    setModel(channel.model); setEnabled(channel.enabled); setKeys(savedKeys(channel));
    nextRowId.current = channel.keys.length;
    setDirty(false); setStale(false); setError(''); setNotice(''); setResults({});
  }, [channel]);
  useEffect(() => { onActivity(channel.id, { busy: busy !== null, dirty }); }, [channel.id, busy, dirty, onActivity]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  function edited() {
    setDirty(true); setNotice(''); setResults({});
    if (!stale) setError('');
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
        setDirty(false); setResults({});
        setNotice('已保存到 Cloudflare KV。请重启 worker 生效；KV 同步可能有短暂延迟。');
      }
    } catch (caught) {
      if (request.current !== controller) return;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) { onAccessLost(); return; }
      if (caught instanceof AdminRequestError && caught.status === 409) {
        setStale(true);
        setError('配置已被修改，当前配置版本已失效。草稿仍保留，请重新读取配置后再编辑；重新读取会丢弃未保存修改。');
      } else if (caught instanceof Error && ['AbortError', 'TimeoutError'].includes(caught.name)) {
        if (kind === 'save') setStale(true);
        setError(kind === 'save' ? '保存超时，结果尚未确认。请重新读取配置后再操作。' : '测试超时，请重试。');
      } else setError(caught instanceof Error ? caught.message : '请求失败，请重试。');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(null); }
    }
  }

  return <section role="group" aria-label={`${channel.name}渠道`} aria-busy={busy !== null}
    className="min-w-0 space-y-4 rounded-xl border border-foreground/10 bg-white/35 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><h3 className="font-semibold">{channel.name}</h3>{dirty && <Badge variant="secondary">未保存</Badge>}</div>
      <Button type="button" role="switch" aria-checked={enabled} aria-label={`启用${channel.name}渠道`}
        variant={enabled ? 'default' : 'outline'} size="sm" className="min-h-11 sm:min-h-0" disabled={disabled}
        onClick={() => { setEnabled(value => !value); edited(); }}>{enabled ? '已启用' : '已关闭'}</Button>
    </div>
    {configurationError && <Alert role="alert" className="border-amber-600/30 bg-amber-50/50">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{configurationError} 可重新填写模型和密钥，或关闭渠道并清空后保存修复；其他渠道不受影响。已有密钥需修复保存后再测试，新填密钥可直接测试。</AlertDescription>
    </Alert>}
    <div className="space-y-2">
      <Label htmlFor={`channel-${channel.id}-model`}>模型名称</Label>
      <Input id={`channel-${channel.id}-model`} value={model} maxLength={400} autoComplete="off" disabled={disabled}
        className="h-11 bg-white/40" onChange={event => { setModel([...event.target.value].slice(0, 200).join('')); edited(); }} />
    </div>
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">密钥 {keys.length}/20。已有密钥仅显示脱敏值；留空保留，填写新值可替换。每个密钥最多 512 个字符。</p>
      {keys.length === 0 && <p className="text-sm text-muted-foreground">尚未配置密钥。启用前请先新增密钥。</p>}
      {keys.map((key, index) => <div key={key.rowId} className="space-y-2 rounded-lg border border-foreground/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={`channel-${channel.id}-key-${key.rowId}`}>密钥 {index + 1}</Label>
          {key.masked && <span className="break-all font-mono text-xs text-muted-foreground">{key.masked}</span>}
        </div>
        <Input id={`channel-${channel.id}-key-${key.rowId}`} type="password" value={key.value} maxLength={1024}
          autoComplete="new-password" spellCheck={false} disabled={disabled} className="h-11 bg-white/40"
          placeholder={key.id ? '留空保留已有密钥' : '输入新密钥'}
          onChange={event => { const value = [...event.target.value].slice(0, 512).join(''); setKeys(current => current.map(item => item.rowId === key.rowId ? { ...item, value } : item)); edited(); }} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-0" aria-label={`测试密钥 ${index + 1}`}
            disabled={disabled || stale || Boolean(configurationError && key.id && !key.value.trim())} onClick={() => { void run('test', key); }}>
            {busy === `test-${key.rowId}` ? <Spinner aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}测试
          </Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-0" aria-label={`删除密钥 ${index + 1}`}
            disabled={disabled} onClick={() => {
              const remaining = keys.filter(item => item.rowId !== key.rowId); setKeys(remaining); edited();
              if (remaining.length === 0) { setEnabled(false); setNotice('最后一条密钥已删除，渠道已关闭，保存后生效。'); }
            }}><Trash2 aria-hidden="true" />删除</Button>
        </div>
        {results[key.rowId] && <p role={results[key.rowId].ok ? 'status' : 'alert'}
          className={`break-words text-xs leading-5 ${results[key.rowId].ok ? 'text-muted-foreground' : 'text-destructive'}`}>
          {results[key.rowId].ok ? '测试成功' : '测试失败'} · {Math.round(results[key.rowId].latencyMs)} ms · {results[key.rowId].message}
        </p>}
      </div>)}
      <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-0" disabled={disabled || keys.length >= 20}
        onClick={() => { const rowId = nextRowId.current++; setKeys(current => [...current, { rowId, value: '' }]); edited(); }}><Plus aria-hidden="true" />新增密钥</Button>
    </div>
    {channel.id === 'yuwan' && <p className="text-xs leading-5 text-muted-foreground">鱼玩存在本地配置时，以 worker 本地配置为准。</p>}
    <AdminError message={error} />
    {notice && <Alert role="status" className="border-primary/20 bg-white/40"><Check aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-foreground/10 pt-3">
      <p className="text-xs leading-5 text-muted-foreground">测试使用当前模型和所选密钥，不保存修改。</p>
      <Button type="button" size="sm" className="min-h-11 sm:min-h-0" disabled={disabled || stale} onClick={() => { void run('save'); }}>
        {busy === 'save' ? <Spinner aria-hidden="true" /> : <Save aria-hidden="true" />}保存渠道
      </Button>
    </div>
  </section>;
}

export function AdminModelChannels({ open, onOpenChange, onAccessLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAccessLost: () => void; returnFocus: () => void;
}) {
  const { data, loading, error, reload } = useAdminData(open ? '/api/admin/model-channels' : null, isModelChannelsResponse, onAccessLost);
  const [activity, setActivity] = useState<Record<string, ChannelActivity>>({});
  const onActivity = useCallback((id: string, value: ChannelActivity) => setActivity(current => ({ ...current, [id]: value })), []);
  const busy = Object.values(activity).some(value => value.busy);
  const dirty = Object.values(activity).some(value => value.dirty);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="auth-dialog flex max-h-[88svh] flex-col gap-4 p-5 sm:max-w-3xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-7">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><Cpu aria-hidden="true" />大模型渠道</DialogTitle>
        <DialogDescription className="leading-6">管理模型、渠道开关和密钥。保存到 Cloudflare KV 后，请重启 worker 生效；KV 同步可能有短暂延迟。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        {data && <Badge variant="secondary">当前环境：{data.environment}</Badge>}
        <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-0" disabled={loading || busy} onClick={() => { void reload(); }}>
          {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{dirty ? '重新读取（丢弃未保存修改）' : '重新读取'}
        </Button>
      </div>
      <div className="min-h-0 space-y-4 overflow-y-auto px-1 -mx-1" aria-busy={loading}>
        <AdminError message={error} />
        {loading && !data && <AdminLoading label="正在读取大模型渠道…" />}
        {data?.channels.map(channel => <ChannelEditor key={channel.id} channel={channel} loading={loading}
          onAccessLost={onAccessLost} onActivity={onActivity} />)}
      </div>
    </DialogContent>
  </Dialog>;
}
