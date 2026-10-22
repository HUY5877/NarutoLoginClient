import { useRef, useState } from 'react';
import { Check, Eye, Pencil, Plus, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { MAX_USER_NOTE_LENGTH, type ManagedUser } from '../../shared/admin';
import { useAdminData, useAdminMutation } from '@/hooks/use-admin';
import { formatAdminDate, isUserResponse, isUsersPage } from '@/lib/admin';
import { AdminError, AdminLoading, AdminPagination } from '@/components/admin-common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Editor = { mode: 'create' } | { mode: 'view' | 'edit'; user: ManagedUser };
const accountLabel = (user: ManagedUser) => !user.isInvalid ? '已启用'
  : user.applicationStatus === 'pending' ? '待审核' : user.applicationStatus === 'rejected' ? '已拒绝' : '已停用';

function UserEditor({ editor, currentUserId, onClose, onSaved, onAccessLost, restoreFocus }: {
  editor: Editor; currentUserId: string; onClose: () => void; onSaved: (notice: string) => void;
  onAccessLost: () => void; restoreFocus: () => void;
}) {
  const creating = editor.mode === 'create', viewing = editor.mode === 'view';
  const user = editor.mode === 'create' ? null : editor.user;
  const { data, loading, error } = useAdminData(user ? `/api/admin/users/${encodeURIComponent(user.id)}` : null, isUserResponse, onAccessLost);
  const mutation = useAdminMutation(onAccessLost);
  const title = creating ? '新增用户' : viewing ? '查看用户' : '编辑用户';
  return <Dialog open onOpenChange={next => { if (!next && !mutation.busy) onClose(); }}>
    <DialogContent className="auth-dialog max-h-[88svh] overflow-y-auto p-5 sm:max-w-lg sm:p-6"
      showCloseButton={!mutation.busy} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <DialogHeader className="gap-2 pr-6">
        <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        <DialogDescription className="leading-6">{creating ? '管理员创建的启用账号可直接登录。' : viewing ? '查看账号备注、角色、状态与注册时间。' : '更新账号备注、登录信息、角色与状态。'}</DialogDescription>
      </DialogHeader>
      <AdminError message={error || mutation.error} />
      {loading && !data && <AdminLoading label="正在读取用户信息…" />}
      {(creating || data) && <UserForm key={data?.user.id ?? 'new'} user={data?.user ?? null} creating={creating} viewing={viewing}
        currentUserId={currentUserId} busy={mutation.busy} onCancel={onClose} onSave={async fields => {
          const ok = await mutation.run(creating ? '/api/admin/users' : `/api/admin/users/${encodeURIComponent(user!.id)}`,
            creating ? 'POST' : 'PATCH', fields, isUserResponse);
          if (ok) onSaved(`已${creating ? '新增' : '更新'}「${fields.username.trim()}」。`);
        }} />}
      {error && !data && <Button type="button" variant="outline" onClick={onClose}>关闭</Button>}
    </DialogContent>
  </Dialog>;
}

function UserForm({ user, creating, viewing, currentUserId, busy, onCancel, onSave }: {
  user: ManagedUser | null; creating: boolean; viewing: boolean; currentUserId: string; busy: boolean;
  onCancel: () => void; onSave: (fields: { username: string; note: string; password: string; isAdmin: boolean; isInvalid: boolean }) => Promise<void>;
}) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [note, setNote] = useState(user?.note ?? '');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [isInvalid, setIsInvalid] = useState(user?.isInvalid ?? false);
  const self = user?.id === currentUserId;
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (!viewing) void onSave({ username, note, password, isAdmin, isInvalid }); }}>
    <div className="space-y-2">
      <Label htmlFor="managed-username">用户名</Label>
      <Input id="managed-username" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={24}
        pattern="[\p{Script=Han}A-Za-z0-9_\-]{3,24}" readOnly={viewing} disabled={busy} autoComplete="off" className="h-10 bg-white/40"
        aria-describedby={viewing ? undefined : 'managed-username-hint'} />
      {!viewing && <p id="managed-username-hint" className="text-xs leading-5 text-muted-foreground">3–24 个汉字、字母、数字、下划线或短横线。</p>}
    </div>
    <div className="space-y-2">
      <Label htmlFor="managed-note">备注</Label>
      <Input id="managed-note" value={note} onChange={event => setNote([...event.target.value].slice(0, MAX_USER_NOTE_LENGTH).join(''))}
        maxLength={MAX_USER_NOTE_LENGTH * 2} readOnly={viewing} disabled={busy} autoComplete="off" className="h-10 bg-white/40"
        placeholder={viewing ? '暂无备注' : '例如：QQ群昵称，方便识别用户'} aria-describedby="managed-note-hint" />
      <p id="managed-note-hint" className="text-xs leading-5 text-muted-foreground">仅管理员可见，最多 {MAX_USER_NOTE_LENGTH} 个字符。用户登录仍使用原用户名，留空可清除备注。</p>
    </div>
    {!viewing && <div className="space-y-2">
      <Label htmlFor="managed-password">{creating ? '登录密码' : '重设密码（可选）'}</Label>
      <Input id="managed-password" type="password" value={password} onChange={event => setPassword(event.target.value)}
        required={creating} minLength={6} maxLength={128} disabled={busy} autoComplete="new-password" className="h-10 bg-white/40"
        placeholder={creating ? '设置登录密码' : '留空保留当前密码'} aria-describedby="managed-password-hint" />
      <p id="managed-password-hint" className="text-xs text-muted-foreground">密码为 6–128 个字符。</p>
    </div>}
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2"><Label htmlFor="managed-role">用户角色</Label>
        <Select value={isAdmin ? 'admin' : 'user'} onValueChange={value => setIsAdmin(value === 'admin')} disabled={busy || viewing || self}>
          <SelectTrigger id="managed-role" className="h-10! w-full bg-white/40"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectItem value="user">普通用户</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-2"><Label htmlFor="managed-status">账号状态</Label>
        <Select value={isInvalid ? 'disabled' : 'enabled'} onValueChange={value => setIsInvalid(value === 'disabled')} disabled={busy || viewing || self}>
          <SelectTrigger id="managed-status" className="h-10! w-full bg-white/40"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectItem value="enabled">启用</SelectItem><SelectItem value="disabled">停用</SelectItem></SelectContent>
        </Select>
      </div>
    </div>
    {self && !viewing && <p className="text-xs leading-5 text-muted-foreground">当前登录账号的管理员角色与启用状态不可修改。</p>}
    {user && <dl className="space-y-2 rounded-lg border bg-white/25 p-3 text-xs leading-5 text-muted-foreground">
      <div className="flex justify-between gap-3"><dt>注册时间</dt><dd className="tabular-nums">{formatAdminDate(user.createdAt)}</dd></div>
      <div className="flex justify-between gap-3"><dt>当前状态</dt><dd>{accountLabel(user)}</dd></div>
    </dl>}
    <div className="flex justify-end gap-2 border-t pt-4">
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{viewing ? '关闭' : '取消'}</Button>
      {!viewing && <Button type="submit" disabled={busy}>{busy ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" />}{creating ? '创建用户' : '保存修改'}</Button>}
    </div>
  </form>;
}

export function AdminUsers({ open, onOpenChange, currentUserId, onAccessLost, refreshAuth, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; currentUserId: string; onAccessLost: () => void; refreshAuth: () => Promise<void>; returnFocus: () => void;
}) {
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Editor | null>(null), [deleting, setDeleting] = useState<ManagedUser | null>(null);
  const [notice, setNotice] = useState('');
  const focusTarget = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const restoreFocus = () => (focusTarget.current?.isConnected ? focusTarget.current : searchInput.current)?.focus();
  const { data, loading, error, reload } = useAdminData(open ? `/api/admin/users?search=${encodeURIComponent(query)}&page=${page}` : null, isUsersPage, onAccessLost);
  const deletion = useAdminMutation(onAccessLost);
  function openEditor(value: Editor, target: HTMLButtonElement) { focusTarget.current = target; setEditor(value); setNotice(''); }
  return <Dialog open={open} onOpenChange={next => { if (!editor && !deleting) onOpenChange(next); }}>
    <DialogContent className="auth-dialog flex max-h-[88svh] flex-col gap-5 p-5 sm:max-w-4xl sm:p-6"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader className="shrink-0 gap-2 pr-7">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold"><Users className="size-5 text-primary" aria-hidden="true" />用户管理</DialogTitle>
        <DialogDescription className="leading-6">查看已注册用户，管理备注、登录信息、角色与账号状态。</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <form className="flex w-full gap-2 sm:w-auto" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); setNotice(''); }}>
          <Input ref={searchInput} aria-label="搜索用户名或备注" value={search}
            onChange={event => setSearch([...event.target.value].slice(0, MAX_USER_NOTE_LENGTH).join(''))} maxLength={MAX_USER_NOTE_LENGTH * 2}
            placeholder="搜索用户名或备注" className="h-9 min-w-0 bg-white/40 sm:w-52" />
          <Button type="submit" size="sm" variant="outline" disabled={loading}><Search aria-hidden="true" />搜索</Button>
        </form>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => { void reload(); }}>
            {loading ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}刷新
          </Button>
          <Button type="button" size="sm" onClick={event => openEditor({ mode: 'create' }, event.currentTarget)}><Plus aria-hidden="true" />新增用户</Button>
        </div>
      </div>
      <AdminError message={error} />
      {notice && <Alert role="status" className="border-primary/20 bg-white/40"><Check aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert>}
      <div className="min-h-0 overflow-y-auto" aria-busy={loading}>
        {loading && !data && <AdminLoading label="正在读取用户…" />}
        {data && data.items.length > 0 && <div className="overflow-hidden rounded-xl border bg-white/35">
          <Table className="min-w-160"><TableCaption className="sr-only">注册用户列表</TableCaption>
            <TableHeader className="bg-secondary/50"><TableRow><TableHead className="pl-4">用户名</TableHead><TableHead>角色</TableHead>
              <TableHead>账号状态</TableHead><TableHead>注册时间（北京时间）</TableHead><TableHead className="pr-4 text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>{data.items.map(user => <TableRow key={user.id}>
              <TableCell className="max-w-44 py-3 pl-4"><div className="truncate font-medium" title={user.username}>{user.username}</div>
                {user.note && <p className="mt-1 truncate text-xs text-muted-foreground" title={user.note}>备注：{user.note}</p>}
                {user.id === currentUserId && <span className="text-xs text-muted-foreground">当前账号</span>}</TableCell>
              <TableCell><Badge variant={user.isAdmin ? 'default' : 'outline'}>{user.isAdmin ? '管理员' : '普通用户'}</Badge></TableCell>
              <TableCell><Badge variant="secondary" className={user.isInvalid ? 'text-muted-foreground' : 'bg-primary/10 text-primary'}>{accountLabel(user)}</Badge></TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatAdminDate(user.createdAt)}</TableCell>
              <TableCell className="pr-3"><div className="flex justify-end gap-1">
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`查看 ${user.username}`} onClick={event => openEditor({ mode: 'view', user }, event.currentTarget)}><Eye aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`编辑 ${user.username}`} onClick={event => openEditor({ mode: 'edit', user }, event.currentTarget)}><Pencil aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" className="text-destructive" aria-label={`删除 ${user.username}`} disabled={user.id === currentUserId}
                  onClick={event => { focusTarget.current = event.currentTarget; setDeleting(user); deletion.clearError(); setNotice(''); }}><Trash2 aria-hidden="true" /></Button>
              </div></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>}
        {!loading && data?.items.length === 0 && <Empty className="py-12"><EmptyHeader>
          <EmptyMedia variant="icon" className="bg-white/40"><Users aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{query ? '没有匹配的用户' : data.total ? '本页暂无用户' : '暂无注册用户'}</EmptyTitle>
          <EmptyDescription>{query ? '修改用户名或备注关键词后重新搜索。' : data.total ? '返回上一页查看用户。' : '点击「新增用户」创建账号。'}</EmptyDescription>
        </EmptyHeader></Empty>}
      </div>
      {data && <AdminPagination page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPageChange={setPage} />}
      {editor && <UserEditor editor={editor} currentUserId={currentUserId} onAccessLost={onAccessLost} restoreFocus={restoreFocus}
        onClose={() => setEditor(null)} onSaved={message => {
          const selfEdited = editor.mode === 'edit' && editor.user.id === currentUserId;
          setEditor(null); setNotice(message); void reload(); if (selfEdited) void refreshAuth();
        }} />}
      <AlertDialog open={Boolean(deleting)} onOpenChange={next => { if (!next && !deletion.busy) setDeleting(null); }}>
        <AlertDialogContent className="auth-dialog" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
          <AlertDialogHeader><AlertDialogTitle>删除用户「{deleting?.username}」？</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">删除后，该用户无法登录，其注册申请和日常申请记录也会删除。此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AdminError message={deletion.error} />
          <AlertDialogFooter><AlertDialogCancel disabled={deletion.busy}>取消</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={deletion.busy} onClick={async () => {
              if (!deleting) return;
              const ok = await deletion.run(`/api/admin/users/${encodeURIComponent(deleting.id)}`, 'DELETE');
              if (ok) { setNotice(`已删除「${deleting.username}」。`); setDeleting(null); if (page > 1 && data?.items.length === 1) setPage(page - 1); else void reload(); }
            }}>{deletion.busy ? <Spinner aria-hidden="true" /> : <Trash2 aria-hidden="true" />}确认删除</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  </Dialog>;
}
