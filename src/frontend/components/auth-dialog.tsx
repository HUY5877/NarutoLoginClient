import { useState, type FormEvent } from 'react';
import { CircleAlert, LogIn, UserPlus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { AuthMode } from '@/hooks/use-auth';

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string;
  clearError: () => void;
  authenticate: (mode: AuthMode, username: string, password: string) => Promise<boolean>;
}

export function AuthDialog({ open, onOpenChange, busy, error, clearError, authenticate }: AuthDialogProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState('');
  const registering = mode === 'register';

  function changeOpen(next: boolean) {
    if (busy) return;
    setPassword('');
    setValidationError('');
    clearError();
    onOpenChange(next);
  }

  function switchMode() {
    setMode(registering ? 'login' : 'register');
    setPassword('');
    setValidationError('');
    clearError();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setValidationError('');
    clearError();
    if (!/^[\p{Script=Han}A-Za-z0-9_-]{3,24}$/u.test(username.trim())) {
      setValidationError('用户名需为 3–24 个汉字、英文字母、数字、下划线或连字符。');
      return;
    }
    const passwordLength = [...password].length;
    if (passwordLength < 8 || passwordLength > 128) {
      setValidationError('密码需为 8–128 个字符。');
      return;
    }
    if (await authenticate(mode, username, password)) {
      setPassword('');
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="auth-dialog gap-6 p-6 sm:max-w-md sm:p-7">
        <DialogHeader className="gap-3 pr-6">
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <img src="/icons/leaf-village.svg" alt="" width="25" height="25" aria-hidden="true" />
            {registering ? '注册忍者日常账户' : '登录忍者日常'}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {registering ? '创建你的专属用户名，注册成功后自动登录。' : '登录后即可获取二维码，重新打开页面也能继续本次申请。'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={(event) => { void submit(event); }}>
          <div className="space-y-2">
            <Label htmlFor="account-username">用户名</Label>
            <Input id="account-username" name="username" value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username" autoCapitalize="none" spellCheck={false}
              required disabled={busy}
              placeholder="输入用户名" aria-describedby="username-hint" className="h-11 bg-white/70" />
            <p id="username-hint" className="text-xs leading-5 text-muted-foreground">3–24 个汉字、字母、数字、下划线或连字符</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-password">密码</Label>
            <Input id="account-password" name="password" type="password" value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={registering ? 'new-password' : 'current-password'}
              required disabled={busy}
              placeholder="输入密码" aria-describedby="password-hint" className="h-11 bg-white/70" />
            <p id="password-hint" className="text-xs leading-5 text-muted-foreground">8–128 个字符，请勿使用游戏账号密码</p>
          </div>
          {(validationError || error) && (
            <Alert variant="destructive" role="alert" className="bg-white/60">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{validationError || error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" size="lg" disabled={busy} className="h-11 w-full">
            {busy ? <Spinner aria-hidden="true" /> : registering ? <UserPlus aria-hidden="true" /> : <LogIn aria-hidden="true" />}
            {busy ? '正在处理…' : registering ? '注册并登录' : '登录'}
          </Button>
        </form>
        <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
          <span>{registering ? '已有账户？' : '还没有账户？'}</span>
          <Button type="button" variant="link" size="sm" className="px-1" disabled={busy} onClick={switchMode}>
            {registering ? '去登录' : '注册账户'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
