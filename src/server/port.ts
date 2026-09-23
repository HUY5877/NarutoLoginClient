import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, normalize, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const commandOptions = { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 };

interface ProcessInfo {
  pid: number;
  parent: number;
  name?: string;
  command?: string;
}

async function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') accept(false);
      else reject(new Error(`无法检查端口 ${port}（${error.code ?? 'UNKNOWN'}）。`));
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close(error => error ? reject(new Error(`无法释放端口 ${port} 的检查监听。`)) : accept(true));
    });
  });
}

async function waitForPort(host: string, port: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  do {
    if (await isPortFree(host, port)) return true;
    await setTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

function ancestors(pid: number, processes: Map<number, ProcessInfo>): number[] {
  const result: number[] = [];
  while (pid > 0 && !result.includes(pid)) {
    result.push(pid);
    pid = processes.get(pid)?.parent ?? 0;
  }
  return result;
}

function checkPid(pid: number, protectedPids: Set<number>, port: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 4 || protectedPids.has(pid)) {
    throw new Error(`端口 ${port} 由受保护进程 ${pid} 占用，无法自动停止。`);
  }
}

function isClientWatcher(info: ProcessInfo | undefined, cli: string | undefined): boolean {
  if (!cli || info?.name?.toLowerCase() !== 'node.exe' || !info.command) return false;
  const args = [...info.command.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
  const index = args.findIndex(arg => normalize(arg).toLowerCase() === cli);
  if (index < 1 || args[index + 1] !== 'watch' || args[index + 3] !== '--dev' || args.length !== index + 4) return false;
  const entry = args[index + 2].replaceAll('\\', '/').replace(/^\.\//, '');
  const absoluteEntry = resolve(dirname(cli), '../../..', 'index.ts').toLowerCase();
  return entry === 'index.ts' || normalize(entry).toLowerCase() === absoluteEntry;
}

async function stopWindowsOwners(port: number): Promise<void> {
  // Return only the listener and current-process ancestor chains. Command lines
  // are used for identification only and must never appear in errors or logs.
  const script = `
$ErrorActionPreference = 'Stop'
$owners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique)
$all = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $all[[int]$_.ProcessId] = [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name; command = $_.CommandLine }
}
$selected = @{}
foreach ($ownerId in ($owners + @(${process.pid}))) {
  $cursorId = [int]$ownerId
  while ($cursorId -gt 0 -and $all.ContainsKey($cursorId) -and !$selected.ContainsKey($cursorId)) {
    $selected[$cursorId] = $all[$cursorId]
    $cursorId = $all[$cursorId].parent
  }
}
[pscustomobject]@{ owners = @($owners); processes = @($selected.Values) } | ConvertTo-Json -Depth 4 -Compress
`;
  let snapshot: { owners: number[]; processes: ProcessInfo[] };
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], commandOptions);
    snapshot = JSON.parse(stdout);
  } catch {
    throw new Error(`无法查询端口 ${port} 的占用进程。`);
  }
  const processes = new Map(snapshot.processes.map(info => [info.pid, info]));
  const protectedPids = new Set(ancestors(process.pid, processes));
  protectedPids.add(process.ppid);
  let cli: string | undefined;
  try {
    cli = normalize(createRequire(import.meta.url).resolve('tsx/cli')).toLowerCase();
  } catch {
    // Production installs may omit the development-only tsx package.
  }
  const targets = new Set<number>();
  for (const owner of snapshot.owners) {
    checkPid(owner, protectedPids, port);
    const watcher = ancestors(owner, processes).find(pid => isClientWatcher(processes.get(pid), cli));
    const target = watcher ?? owner;
    checkPid(target, protectedPids, port);
    targets.add(target);
  }
  for (const pid of targets) {
    try {
      // Killing the verified watch parent also prevents a later edit from
      // resurrecting its listener. Never terminate an npm or shell ancestor.
      await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], commandOptions);
      console.log(`端口 ${port}：已停止进程 ${pid}。`);
    } catch {
      // A listener can exit between discovery and termination. The caller
      // verifies the port itself, including failures caused by permissions.
    }
  }
}

async function posixOwners(port: number): Promise<number[]> {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], commandOptions);
    return [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    if (failure.code === 1 && !failure.stdout?.trim()) return [];
    throw new Error(`无法查询端口 ${port} 的占用进程，请确认已安装 lsof。`);
  }
}

async function stopPosixOwners(host: string, port: number): Promise<void> {
  let processes: Map<number, ProcessInfo>;
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid='], commandOptions);
    processes = new Map(stdout.trim().split('\n').map(line => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      return [pid, { pid, parent }];
    }));
  } catch {
    throw new Error(`无法检查端口 ${port} 的进程关系。`);
  }
  const protectedPids = new Set(ancestors(process.pid, processes));
  protectedPids.add(process.ppid);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const owners = await posixOwners(port);
    for (const pid of owners) checkPid(pid, protectedPids, port);
    for (const pid of owners) {
      try {
        process.kill(pid, signal);
        console.log(`端口 ${port}：已向进程 ${pid} 发送停止信号。`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new Error(`无法停止占用端口 ${port} 的进程 ${pid}。`);
        }
      }
    }
    if (signal === 'SIGTERM' && await waitForPort(host, port, 1500)) return;
  }
}

export async function releasePort(host: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1–65535 的整数。');
  }
  if (await isPortFree(host, port)) return;
  if (process.platform === 'win32') await stopWindowsOwners(port);
  else await stopPosixOwners(host, port);
  if (!await waitForPort(host, port, 5000)) {
    throw new Error(`端口 ${port} 仍被占用，无法停止占用进程，请检查进程权限后重试。`);
  }
}
