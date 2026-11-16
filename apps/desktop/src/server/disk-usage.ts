import { randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { LargeFile, UsageItem, UsageSnapshot } from "../shared/web-files";

/**
 * 파일 관리자의 "용량 보기" (설계 §5.10). 폴더를 끝까지 훑어 하위 폴더마다 디스크에서 차지하는 크기를 센다.
 *
 * 목록은 그대로 빠르게 두고, 사용자가 [용량]을 켰을 때만 센다. 큰 폴더(node_modules, ~/storage의 사진)는 오래 걸리므로
 * - 화면은 계산을 시작하고 지금까지 센 것을 몇 번이고 받아 간다 (usagePoll). 다른 폴더로 가면 멈춘다
 * - 링크는 따라가지 않는다 (~/storage는 공용 저장소로 가는 링크 묶음: 두 번 세거나 끝없이 돌 수 있다). 다른 저장소로 넘어가지도 않는다
 * - 크기는 파일 길이가 아니라 디스크 블록 수로 센다 (du와 같다)
 * - 한 번에 읽는 파일 수를 줄여 계산하는 동안에도 Pi 대화가 느려지지 않게 한다
 * - 다 센 폴더는 하위 폴더까지 기억해 두어, 들어가면 바로 보인다. 지우면 그만큼 위 폴더들에서 뺀다
 */

const CONCURRENCY = 8;
/** 기억해 둘 폴더 수 (넘으면 더 기억하지 않는다) */
const MAX_CACHED_DIRS = 200_000;
/** 큰 파일 후보를 이만큼 들고 있는다 (하위 폴더에 들어가 걸러 볼 수 있게) */
const MAX_LARGE_FILES = 500;
const SHOW_LARGE_FILES = 30;
/** 끝난 계산은 이만큼 뒤에 잊는다 */
const JOB_KEEP_MS = 5 * 60_000;

interface DirInfo {
  size: number;
  count: number;
  at: number;
}

interface Job {
  id: string;
  path: string;
  startedAt: number;
  endedAt?: number;
  items: UsageItem[];
  done: boolean;
  partial: boolean;
  cancelled: boolean;
  skipped: number;
  deadline: number;
}

class Stop extends Error {}

export interface DiskUsageOptions {
  /** 한 폴더를 세는 시간 상한 (밀리초) */
  maxMs: () => number;
  now?: () => number;
}

export class DiskUsage {
  private readonly jobs = new Map<string, Job>();
  private readonly dirs = new Map<string, DirInfo>();
  /** 센 뒤에 안이 바뀐 폴더 */
  private readonly stale = new Set<string>();
  private large: LargeFile[] = [];
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: DiskUsageOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 계산을 시작한다. 이미 다 센 폴더면 기억한 것으로 바로 답한다 (refresh면 다시 센다) */
  async start(path: string, refresh = false): Promise<UsageSnapshot> {
    // 화면은 한 번에 한 폴더만 본다: 앞의 계산은 멈춘다
    for (const job of this.jobs.values()) if (!job.done) job.cancelled = true;
    this.forgetOldJobs();
    if (!refresh && this.dirs.has(path)) {
      const cached = await this.fromCache(path).catch(() => undefined);
      if (cached) return cached;
    }
    const job: Job = {
      id: randomBytes(9).toString("base64url"),
      path,
      startedAt: this.now(),
      items: [],
      done: false,
      partial: false,
      cancelled: false,
      skipped: 0,
      deadline: this.now() + this.options.maxMs(),
    };
    this.jobs.set(job.id, job);
    // 다시 세므로 이 폴더 아래의 큰 파일 기억은 새로 모은다 (그 사이 다른 곳에서 지운 파일이 남지 않게)
    const prefix = path.endsWith(sep) ? path : path + sep;
    this.large = this.large.filter((f) => !f.path.startsWith(prefix));
    // 목록(바로 아래)은 먼저 읽어 두어 첫 답에 바로 보이게 한다
    const children = await this.children(path);
    const rootDev = (await lstat(path)).dev;
    job.items = children.map(({ name, info }) => ({
      name,
      path: join(path, name),
      dir: info.isDirectory(),
      link: info.isSymbolicLink(),
      size: diskSize(info),
      count: 1,
      done: !info.isDirectory(),
      mtime: info.mtimeMs,
    }));
    for (const item of job.items) if (!item.dir && !item.link) this.noteFile(item.path, item.size, item.mtime);
    void this.run(job, rootDev);
    return this.snapshot(job);
  }

  poll(id: string): UsageSnapshot {
    const job = this.jobs.get(id);
    if (!job) throw new Error("용량 계산이 이미 끝났거나 멈췄습니다. 다시 계산하세요");
    return this.snapshot(job);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job && !job.done) job.cancelled = true;
  }

  /** 지우기 전에 부른다: 기억한 크기 (모르면 undefined) */
  async sizeOf(path: string): Promise<number | undefined> {
    const cached = this.dirs.get(path);
    if (cached) return cached.size;
    const info = await lstat(path).catch(() => undefined);
    if (!info) return undefined;
    return info.isDirectory() ? undefined : diskSize(info);
  }

  /** 지웠다: 아는 크기면 위 폴더들에서 빼고, 모르면 위 폴더들을 "바뀜"으로 둔다 */
  removed(path: string, size: number | undefined, count = 1): void {
    const cached = this.dirs.get(path);
    const n = cached?.count ?? count;
    this.dropUnder(path);
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const info = this.dirs.get(dir);
      if (info && size !== undefined) {
        info.size = Math.max(0, info.size - size);
        info.count = Math.max(0, info.count - n);
      } else if (info) this.stale.add(dir);
      if (dirname(dir) === dir) break;
    }
  }

  /** 만들기·옮기기·복사·올리기·저장: 그 곳의 위 폴더들을 "바뀜"으로 둔다 (옮긴 곳의 기억은 지운다) */
  changed(paths: string[], moved: string[] = [], dirs: string[] = []): void {
    for (const path of moved) this.dropUnder(path);
    const mark = (start: string) => {
      for (let dir = start; ; dir = dirname(dir)) {
        if (this.dirs.has(dir)) this.stale.add(dir);
        if (dirname(dir) === dir) break;
      }
    };
    for (const path of [...paths, ...moved]) mark(dirname(path));
    // 안이 바뀐 폴더 (그 폴더부터)
    for (const dir of dirs) mark(dir);
  }

  private async run(job: Job, rootDev: number): Promise<void> {
    try {
      await Promise.all(
        job.items.map(async (item) => {
          if (!item.dir || item.link) return;
          try {
            const { size, count } = await this.walk(item.path, rootDev, job, (bytes, files) => {
              item.size += bytes;
              item.count += files;
            });
            item.size = size;
            item.count = count;
            item.done = true;
          } catch (error) {
            if (error instanceof Stop) throw error;
            job.skipped++;
            item.done = true;
          }
        }),
      );
      // 다 셌다: 이 폴더도 기억한다 (위 폴더에서 이 폴더 크기를 다시 셌으면 그 차이를 반영한다)
      const size = job.items.reduce((sum, i) => sum + i.size, 0);
      const count = job.items.reduce((sum, i) => sum + i.count, 0);
      const before = this.dirs.get(job.path);
      this.remember(job.path, size, count);
      if (before) {
        for (let dir = dirname(job.path); dir !== job.path && dirname(dir) !== dir; dir = dirname(dir)) {
          const info = this.dirs.get(dir);
          if (info) info.size = Math.max(0, info.size + size - before.size);
        }
      }
      for (const dir of [...this.stale]) if (dir === job.path || dir.startsWith(job.path + sep)) this.stale.delete(dir);
    } catch (error) {
      if (!(error instanceof Stop)) job.skipped++;
      job.partial = !job.cancelled;
    } finally {
      job.done = true;
      job.endedAt = this.now();
    }
  }

  /** 폴더 하나를 끝까지 센다. add로 세는 중에 조금씩 알린다 */
  private async walk(dir: string, rootDev: number, job: Job, add: (bytes: number, files: number) => void): Promise<{ size: number; count: number }> {
    this.check(job);
    const self = await this.limited(() => lstat(dir));
    let size = diskSize(self);
    let count = 1;
    add(size, 0);
    let children: Array<{ name: string; info: Stats }>;
    try {
      children = await this.children(dir, job);
    } catch (error) {
      if (error instanceof Stop) throw error;
      job.skipped++;
      return { size, count };
    }
    const subdirs: string[] = [];
    for (const { name, info } of children) {
      const full = join(dir, name);
      // 링크는 따라가지 않고, 다른 저장소로는 넘어가지 않는다
      if (info.isDirectory() && info.dev === rootDev) {
        subdirs.push(full);
        continue;
      }
      const bytes = diskSize(info);
      size += bytes;
      count++;
      add(bytes, 1);
      if (info.isFile()) this.noteFile(full, bytes, info.mtimeMs);
    }
    const results = await Promise.all(
      subdirs.map((sub) =>
        this.walk(sub, rootDev, job, add).catch((error: unknown) => {
          if (error instanceof Stop) throw error;
          job.skipped++;
          return { size: 0, count: 0 };
        }),
      ),
    );
    for (const r of results) {
      size += r.size;
      count += r.count;
    }
    // walk는 시작할 때 자기 크기를 이미 알렸다. 하위 폴더는 각자 알렸으므로 여기서는 알리지 않는다
    this.remember(dir, size, count);
    return { size, count };
  }

  private async children(dir: string, job?: Job): Promise<Array<{ name: string; info: Stats }>> {
    const names = await this.limited(() => readdir(dir));
    const out: Array<{ name: string; info: Stats }> = [];
    await Promise.all(
      names.map(async (name) => {
        if (job) this.check(job);
        const info = await this.limited(() => lstat(join(dir, name))).catch(() => undefined);
        if (info) out.push({ name, info });
        else if (job) job.skipped++;
      }),
    );
    return out;
  }

  /** 이미 센 폴더를 바로 보인다: 바로 아래 목록은 새로 읽고, 하위 폴더 크기는 기억한 것을 쓴다 */
  private async fromCache(path: string): Promise<UsageSnapshot | undefined> {
    const info = this.dirs.get(path);
    if (!info) return undefined;
    const children = await this.children(path);
    let stale = this.stale.has(path);
    const items: UsageItem[] = children.map(({ name, info: child }) => {
      const full = join(path, name);
      if (child.isDirectory()) {
        const known = this.dirs.get(full);
        if (!known) stale = true;
        if (this.stale.has(full)) stale = true;
        return { name, path: full, dir: true, link: false, size: known?.size ?? 0, count: known?.count ?? 0, done: Boolean(known), mtime: child.mtimeMs };
      }
      return { name, path: full, dir: false, link: child.isSymbolicLink(), size: diskSize(child), count: 1, done: true, mtime: child.mtimeMs };
    });
    const total = items.reduce((sum, i) => sum + i.size, 0);
    return {
      id: "",
      path,
      done: true,
      partial: false,
      stale,
      total,
      count: items.reduce((sum, i) => sum + i.count, 0),
      skipped: 0,
      elapsedMs: 0,
      at: info.at,
      items: sortItems(items),
      largest: this.largestUnder(path),
    };
  }

  private snapshot(job: Job): UsageSnapshot {
    const items = sortItems(job.items.map((i) => ({ ...i })));
    return {
      id: job.id,
      path: job.path,
      done: job.done,
      partial: job.partial,
      stale: false,
      total: items.reduce((sum, i) => sum + i.size, 0),
      count: items.reduce((sum, i) => sum + i.count, 0),
      skipped: job.skipped,
      elapsedMs: (job.endedAt ?? this.now()) - job.startedAt,
      at: job.endedAt ?? this.now(),
      items,
      largest: this.largestUnder(job.path),
    };
  }

  private largestUnder(path: string): LargeFile[] {
    const prefix = path.endsWith(sep) ? path : path + sep;
    return this.large.filter((f) => f.path.startsWith(prefix)).slice(0, SHOW_LARGE_FILES);
  }

  private noteFile(path: string, size: number, mtime: number): void {
    const list = this.large;
    if (list.length >= MAX_LARGE_FILES && size <= list[list.length - 1]!.size) return;
    const at = list.findIndex((f) => f.path === path);
    if (at >= 0) list.splice(at, 1);
    // 큰 것부터 (이진 탐색으로 끼워 넣는다)
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.size >= size) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, { path, size, mtime });
    if (list.length > MAX_LARGE_FILES) list.pop();
  }

  private remember(dir: string, size: number, count: number): void {
    if (this.dirs.size >= MAX_CACHED_DIRS && !this.dirs.has(dir)) return;
    this.dirs.set(dir, { size, count, at: this.now() });
  }

  private dropUnder(path: string): void {
    const prefix = path + sep;
    for (const dir of [...this.dirs.keys()]) if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir);
    for (const dir of [...this.stale]) if (dir === path || dir.startsWith(prefix)) this.stale.delete(dir);
    this.large = this.large.filter((f) => f.path !== path && !f.path.startsWith(prefix));
  }

  private check(job: Job): void {
    if (job.cancelled) throw new Stop();
    if (this.now() > job.deadline) throw new Stop();
  }

  private forgetOldJobs(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) if (job.done && job.endedAt !== undefined && now - job.endedAt > JOB_KEEP_MS) this.jobs.delete(id);
  }

  /** 한 번에 읽는 파일 수를 줄인다 */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** 디스크에서 차지하는 크기 (블록 수를 모르면 길이) */
function diskSize(info: Stats): number {
  return typeof info.blocks === "number" && info.blocks >= 0 && process.platform !== "win32" ? info.blocks * 512 : info.size;
}

function sortItems(items: UsageItem[]): UsageItem[] {
  return items.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}
