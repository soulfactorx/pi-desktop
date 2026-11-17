import { open, readdir, readFile, readlink, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import type { Exec } from "../watchers";
import type { DiskSnapshot, FailedUnit } from "./types";

/**
 * 시스템 관찰의 수집기 (설계 DESIGN-MATE.md §10.1). 모델이 아니라 정해진 읽기 명령만 쓴다.
 * 결과는 그대로 남기지 않고 watch.ts가 요약·가림을 거쳐 남긴다.
 */

export type Platform = "win32" | "linux" | "darwin" | "unsupported";

/** 시스템 관찰을 쓸 수 있는 곳 (휴대폰 Termux는 시스템 로그·프로그램 목록을 볼 수 없다) */
export function systemPlatform(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Platform {
  if (env.PREFIX?.includes("com.termux") || platform === "android") return "unsupported";
  return platform === "win32" || platform === "linux" || platform === "darwin" ? platform : "unsupported";
}

/** 오류 로그 한 줄 (가리기 전) */
export interface RawEvent {
  source: string;
  id: string;
  level: "critical" | "error";
  at: number;
  message: string;
  /** 여러 줄 원문 (Windows 이벤트의 전체 메시지). 가리기 전 */
  detail?: string;
}

export interface HealthReading {
  events: RawEvent[];
  failed: Array<Pick<FailedUnit, "name" | "kind">>;
  /** 읽지 못한 이유 */
  problem?: string;
}

const PS_PREFIX = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';";

function powershell(exec: Exec, script: string, cwd: string) {
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_PREFIX + script], cwd);
}

/** Windows: 시스템·응용 프로그램 로그의 위험·오류, 실패한 예약 작업(사용자가 만든 것) */
export function windowsHealthScript(sinceMs: number): string {
  return [
    `$s=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(sinceMs)}).LocalDateTime;`,
    "$e=@(Get-WinEvent -FilterHashtable @{LogName=@('System','Application');Level=@(1,2);StartTime=$s} -MaxEvents 300 | ForEach-Object {",
    "[pscustomobject]@{p=$_.ProviderName;i=$_.Id;l=$_.Level;t=$_.TimeCreated.ToUniversalTime().ToString('o');m=(($_.Message -split \"`n\")[0]);d=$(if ($_.Message) { $_.Message.Substring(0,[Math]::Min(2000,$_.Message.Length)) })} });",
    "$t=@(Get-ScheduledTask -TaskPath '\\' | Where-Object {$_.State -ne 'Disabled'} | ForEach-Object { $i=$_ | Get-ScheduledTaskInfo;",
    "if ($i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009 -and $i.LastTaskResult -ne 267011 -and $i.LastRunTime -gt (Get-Date).AddDays(-7)) { $_.TaskName } });",
    "[pscustomobject]@{events=$e;tasks=$t} | ConvertTo-Json -Compress -Depth 3",
  ].join("");
}

export function parseWindowsHealth(stdout: string): HealthReading {
  const text = stdout.trim();
  if (!text) return { events: [], failed: [] };
  const raw = JSON.parse(text) as { events?: unknown; tasks?: unknown };
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v ? [v as T] : []);
  const events = list<{ p?: string; i?: number; l?: number; t?: string; m?: string; d?: string }>(raw.events).flatMap((e) => {
    const at = Date.parse(e.t ?? "");
    if (!e.p || !Number.isFinite(at)) return [];
    return [{ source: e.p, id: String(e.i ?? 0), level: e.l === 1 ? ("critical" as const) : ("error" as const), at, message: e.m ?? "", ...(e.d && e.d.trim() !== (e.m ?? "").trim() ? { detail: e.d } : {}) }];
  });
  const failed = list<string>(raw.tasks)
    .filter((n) => typeof n === "string" && n.trim())
    .map((name) => ({ name, kind: "task" as const }));
  return { events, failed };
}

/** Linux: journalctl JSON 줄 (오류 이상) */
export function parseJournal(stdout: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const priority = Number(e.PRIORITY ?? 3);
      const source = String(e._SYSTEMD_UNIT ?? e.SYSLOG_IDENTIFIER ?? e._COMM ?? "system");
      const message = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE as number[]).toString("utf8") : String(e.MESSAGE ?? "");
      const at = Math.floor(Number(e.__REALTIME_TIMESTAMP ?? 0) / 1000);
      if (!Number.isFinite(at) || at <= 0) continue;
      out.push({ source, id: priority <= 2 ? "crit" : "err", level: priority <= 2 ? "critical" : "error", at, message });
    } catch {
      // 한 줄이 깨져도 나머지는 읽는다
    }
  }
  return out;
}

/** systemctl --failed --no-legend --plain 출력의 유닛 이름 */
export function parseFailedUnits(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().replace(/^●\s*/, "").split(/\s+/)[0] ?? "")
    .filter((n) => /^[\w@.:-]+\.(service|timer|mount|socket|path|target)$/.test(n));
}

export async function readHealth(platform: Platform, exec: Exec, sinceMs: number, cwd: string): Promise<HealthReading> {
  if (platform === "win32") {
    const { code, stdout } = await powershell(exec, windowsHealthScript(sinceMs), cwd);
    if (code !== 0 && !stdout.trim()) return { events: [], failed: [], problem: "Windows 이벤트 로그를 읽지 못했습니다 (PowerShell)" };
    try {
      return parseWindowsHealth(stdout);
    } catch {
      return { events: [], failed: [], problem: "Windows 이벤트 로그 결과를 읽지 못했습니다" };
    }
  }
  if (platform === "linux") {
    const since = `@${Math.floor(sinceMs / 1000)}`;
    const journal = await exec("journalctl", ["-p", "3", "--since", since, "-o", "json", "--no-pager", "-q", "-n", "500"], cwd);
    const system = await exec("systemctl", ["--failed", "--no-legend", "--plain", "--no-pager"], cwd);
    const user = await exec("systemctl", ["--user", "--failed", "--no-legend", "--plain", "--no-pager"], cwd);
    const failed = [
      ...(system.code === 0 ? parseFailedUnits(system.stdout).map((name) => ({ name, kind: "service" as const })) : []),
      ...(user.code === 0 ? parseFailedUnits(user.stdout).map((name) => ({ name, kind: "user-service" as const })) : []),
    ];
    if (journal.code !== 0)
      return { events: [], failed, problem: "시스템 로그(journalctl)를 읽지 못했습니다. systemd가 없거나, 사용자를 systemd-journal 그룹에 넣어야 할 수 있습니다" };
    return { events: parseJournal(journal.stdout), failed };
  }
  if (platform === "darwin") return { events: [], failed: [], problem: "macOS 시스템 로그는 아직 읽지 않습니다 (디스크만 봅니다)" };
  return { events: [], failed: [], problem: "이 기기에서는 시스템 로그를 볼 수 없습니다" };
}

/** 디스크 남은 용량 (시스템 드라이브와 홈이 있는 드라이브) */
export async function readDisks(platform: Platform, now: number, home = homedir()): Promise<DiskSnapshot[]> {
  const mounts = platform === "win32" ? [`${process.env.SystemDrive ?? "C:"}\\`, parse(home).root] : ["/", home];
  const out: DiskSnapshot[] = [];
  for (const mount of [...new Set(mounts)]) {
    try {
      const s = await statfs(mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      // 같은 저장소를 두 번 보이지 않는다 (/와 홈이 같은 디스크)
      if (total > 0 && !out.some((d) => d.total === total && Math.abs(d.free - free) < 64 * 1024 * 1024)) out.push({ mount, total, free, at: now });
    } catch {
      // 못 읽는 곳은 건너뛴다
    }
  }
  return out;
}

// ── 켜져 있는 프로그램 (이름만) ──

/** 늘 떠 있어 뜻이 없는 프로그램 */
const BACKGROUND = new Set([
  "applicationframehost", "textinputhost", "systemsettings", "shellexperiencehost", "searchhost", "searchapp", "startmenuexperiencehost",
  "explorer", "lockapp", "widgets", "gamebar", "nvidia share",
  "bash", "zsh", "sh", "fish", "dash", "sshd", "ssh-agent", "gpg-agent", "systemd", "dbus-daemon", "dbus-broker", "pipewire", "pipewire-pulse",
  "wireplumber", "pulseaudio", "xdg-desktop-portal", "xdg-document-portal", "xdg-permission-store", "at-spi-bus-launcher", "at-spi2-registryd",
  "gvfsd", "gnome-keyring-daemon", "tmux: server", "tmux", "screen", "node", "python", "python3", "sleep", "cat",
]);

export function appName(name: string): string | undefined {
  const clean = name.trim().replace(/\.exe$/i, "");
  if (!clean || clean.length > 60) return undefined;
  if (BACKGROUND.has(clean.toLowerCase())) return undefined;
  if (/^(kworker|gvfs|evolution-|gsd-|xdg-|ibus|fcitx|at-spi|tracker-)/i.test(clean)) return undefined;
  return clean;
}

/** macOS ps의 실행 파일 경로 → 앱 이름 (.app 안의 것만) */
export function macAppName(path: string): string | undefined {
  const m = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(path);
  return m?.[1];
}

export async function readApps(platform: Platform, exec: Exec, cwd: string): Promise<{ names: string[]; problem?: string }> {
  if (platform === "win32") {
    // 창이 있는 프로그램만 (창 제목은 읽지 않는다)
    const { code, stdout } = await powershell(exec, "Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -ExpandProperty ProcessName", cwd);
    if (code !== 0 && !stdout.trim()) return { names: [], problem: "프로그램 목록을 읽지 못했습니다 (PowerShell)" };
    return { names: uniq(stdout.split(/\r?\n/).flatMap((n) => appName(n) ?? [])) };
  }
  if (platform === "darwin") {
    const { code, stdout } = await exec("ps", ["-x", "-o", "comm="], cwd);
    if (code !== 0) return { names: [], problem: "프로그램 목록을 읽지 못했습니다 (ps)" };
    return { names: uniq(stdout.split("\n").flatMap((p) => macAppName(p) ?? [])) };
  }
  if (platform === "linux") return { names: await linuxApps() };
  return { names: [], problem: "이 기기에서는 프로그램 목록을 볼 수 없습니다" };
}

/** Linux: 내 프로세스 중 시스템 폴더 밖의 실행 파일 이름 (/proc의 comm·exe만 읽는다. 인자는 읽지 않는다) */
async function linuxApps(): Promise<string[]> {
  const uid = process.getuid?.();
  const names: string[] = [];
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  for (const pid of pids) {
    try {
      const info = await stat(`/proc/${pid}`);
      if (uid !== undefined && info.uid !== uid) continue;
      const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
      if (!exe || /^\/(usr\/)?(lib|libexec|sbin|lib64)\//.test(exe) || exe.startsWith("/usr/sbin/")) continue;
      const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      const name = appName(comm);
      if (name) names.push(name);
    } catch {
      // 사라진 프로세스
    }
  }
  return uniq(names);
}

function uniq(names: string[]): string[] {
  return [...new Set(names)];
}

// ── 셸 기록 ──

export type HistoryFormat = "bash" | "zsh" | "fish" | "pwsh";

/** 이 기기의 셸 기록 파일 (있는 것만) */
export async function historyFiles(platform: Platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<Array<{ path: string; format: HistoryFormat }>> {
  const candidates: Array<{ path: string; format: HistoryFormat }> = [
    { path: join(home, ".bash_history"), format: "bash" },
    { path: join(home, ".zsh_history"), format: "zsh" },
    { path: join(home, ".histfile"), format: "zsh" },
    { path: join(home, ".local", "share", "fish", "fish_history"), format: "fish" },
    { path: join(home, ".local", "share", "powershell", "PSReadLine", "ConsoleHost_history.txt"), format: "pwsh" },
  ];
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    candidates.push({ path: join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"), format: "pwsh" });
  }
  const out: Array<{ path: string; format: HistoryFormat }> = [];
  for (const c of candidates) if (await stat(c.path).then((s) => s.isFile(), () => false)) out.push(c);
  return out;
}

/** 기록 줄들을 명령과 시각으로 (시각이 없으면 undefined) */
export function parseHistory(text: string, format: HistoryFormat): Array<{ command: string; at?: number }> {
  const out: Array<{ command: string; at?: number }> = [];
  const lines = text.split(/\r?\n/);
  if (format === "fish") {
    let current: { command: string; at?: number } | undefined;
    for (const line of lines) {
      const cmd = /^- cmd: (.*)$/.exec(line);
      if (cmd) {
        if (current) out.push(current);
        current = { command: cmd[1]!.replace(/\\n/g, " ") };
        continue;
      }
      const when = /^\s+when: (\d+)$/.exec(line);
      if (when && current) current.at = Number(when[1]) * 1000;
    }
    if (current) out.push(current);
    return out;
  }
  let pendingAt: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (format === "bash" && /^#\d{9,11}$/.test(line)) {
      pendingAt = Number(line.slice(1)) * 1000;
      continue;
    }
    if (format === "zsh") {
      const m = /^: (\d{9,11}):\d+;(.*)$/.exec(line);
      if (m) {
        out.push({ command: m[2]!, at: Number(m[1]) * 1000 });
        continue;
      }
    }
    // 이어지는 줄(\·`로 끝남)의 뒷부분은 앞 명령의 인자라 버린다
    if (i > 0 && /[\\`]$/.test(lines[i - 1] ?? "")) continue;
    out.push({ command: line, ...(pendingAt !== undefined ? { at: pendingAt } : {}) });
    pendingAt = undefined;
  }
  return out;
}

/** 파일의 offset 뒤를 읽는다 (최대 1MB). 줄 중간에서 끊기지 않게 마지막 줄바꿈까지만 */
export async function readTail(path: string, offset: number, maxBytes = 1024 * 1024): Promise<{ text: string; offset: number; size: number }> {
  const size = (await stat(path)).size;
  if (size <= offset) return { text: "", offset: size < offset ? size : offset, size };
  const start = Math.max(offset, size - maxBytes);
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { text: "", offset, size };
    let text = buf.subarray(0, end + 1).toString("utf8");
    // 1MB만 읽었으면 첫 줄은 잘렸을 수 있다
    if (start > offset) text = text.slice(text.indexOf("\n") + 1);
    return { text, offset: start + end + 1, size };
  } finally {
    await handle.close();
  }
}
