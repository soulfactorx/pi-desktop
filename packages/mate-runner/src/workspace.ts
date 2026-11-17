import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ChangeInfo } from "@pi-desktop/mate-kit";
import type { Exec } from "./watchers";
import { mateTunables } from "./tunables";

/**
 * act 단계의 작업 공간 (설계 DESIGN-MATE.md §4).
 *
 * 사용자 저장소의 HEAD에서 브랜치 없는(detached) git worktree를 Mate 홈 worktrees/ 아래에 만든다.
 * Pi는 그 안에서만 고치고, 변경은 커밋하지 않고 남긴다. 사용자가 인박스에서 "적용"하면 diff를 자기 작업 폴더에 적용한다.
 * 브랜치·커밋을 만들지 않으므로 사용자 저장소의 브랜치 목록과 커밋 훅을 건드리지 않는다.
 * 사용자의 커밋하지 않은 변경은 작업 공간에 없다 (HEAD 기준).
 *
 * git 저장소가 아닌 폴더는 그 폴더를 Mate 홈 worktrees/ 아래에 복사하고(의존성·캐시 폴더는 빼고), 복사본에서 git으로 기준을 잡는다.
 * 적용은 같은 diff를 원래 폴더에 넣는다 (git apply는 저장소 밖에서도 patch처럼 쓴다). 사용자 폴더에 .git을 만들지 않는다.
 */
export interface Workspace {
  repo: string;
  worktree: string;
  base: string;
  /** 임무 폴더에 해당하는 작업 공간 안 폴더 (임무가 저장소의 하위 폴더일 때) */
  cwd: string;
  /** 저장소가 아닌 폴더의 복사본 */
  copy?: boolean;
}

/** 복사본에 넣지 않는 폴더 (다시 받거나 만들 수 있는 것) */
const COPY_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", ".next", ".turbo", ".gradle", "target", ".pytest_cache", ".mypy_cache"]);
const COPY_MAX_FILES = 20_000;
const COPY_MAX_BYTES = 300 * 1024 * 1024;

/** 복사할 크기를 미리 센다. 너무 크면 오류 (홈 폴더 전체 같은 실수를 막는다) */
async function measure(dir: string, total = { files: 0, bytes: 0 }): Promise<{ files: number; bytes: number }> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!COPY_SKIP.has(entry.name)) await measure(join(dir, entry.name), total);
      continue;
    }
    total.files++;
    total.bytes += entry.isFile() ? (await lstat(join(dir, entry.name))).size : 0;
    if (total.files > COPY_MAX_FILES || total.bytes > COPY_MAX_BYTES) {
      throw new Error(`git 저장소가 아닌 폴더라 복사본에서 고치는데, 폴더가 너무 큽니다 (파일 ${COPY_MAX_FILES.toLocaleString()}개·${COPY_MAX_BYTES / 1024 / 1024}MB까지). 이 폴더를 git 저장소로 만들면 고칠 수 있습니다`);
    }
  }
  return total;
}

async function copyWorkspace(exec: Exec, dutyCwd: string, worktreesDir: string, runId: string): Promise<Workspace> {
  const source = resolve(dutyCwd);
  await measure(source);
  await mkdir(worktreesDir, { recursive: true });
  const copy = join(worktreesDir, runId);
  await cp(source, copy, { recursive: true, verbatimSymlinks: true, filter: (src) => src === source || !COPY_SKIP.has(basename(src)) });
  await git(exec, copy, "init", "-q");
  // 줄 끝을 바꾸지 않는다 (Windows의 core.autocrlf가 사용자 파일의 줄 끝을 바꾸지 않게)
  await git(exec, copy, "config", "core.autocrlf", "false");
  await git(exec, copy, "add", "-A");
  await git(exec, copy, "-c", "user.name=Mate", "-c", "user.email=mate@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "Mate 작업 공간 기준");
  const base = await git(exec, copy, "rev-parse", "HEAD");
  return { repo: source, worktree: copy, base, cwd: copy, copy: true };
}


async function git(exec: Exec, cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, cwd);
  if (result.code !== 0) throw new Error(`git ${args[0]} 실패`);
  return result.stdout.trim();
}

export async function prepareWorkspace(exec: Exec, dutyCwd: string, worktreesDir: string, runId: string): Promise<Workspace> {
  let repo: string;
  try {
    repo = resolve(await git(exec, dutyCwd, "rev-parse", "--show-toplevel"));
  } catch {
    // git 저장소가 아니면 복사본에서 고친다
    return copyWorkspace(exec, dutyCwd, worktreesDir, runId);
  }
  const base = await git(exec, repo, "rev-parse", "HEAD");
  // 임무 폴더가 저장소의 어느 하위 폴더인지는 git에게 묻는다. 경로끼리 계산하면 Windows 짧은 이름(RUNNER~1)과
  // git이 돌려주는 긴 이름이 달라 엉뚱한 상대 경로가 나온다
  const prefix = await git(exec, dutyCwd, "rev-parse", "--show-prefix");
  await mkdir(worktreesDir, { recursive: true });
  const worktree = join(worktreesDir, runId);
  await git(exec, repo, "worktree", "add", "--detach", worktree, base);
  return { repo, worktree, base, cwd: prefix ? join(worktree, prefix.replace(/\/$/, "")) : worktree };
}

/** 작업 공간의 변경(새 파일 포함)을 모은다. 없으면 undefined */
export async function collectChange(exec: Exec, ws: Workspace): Promise<{ info: ChangeInfo; stat: string; patch: string } | undefined> {
  await git(exec, ws.worktree, "add", "-A");
  const names = await git(exec, ws.worktree, "diff", "--cached", "--name-only", ws.base);
  const files = names.split(/\r?\n/).filter(Boolean);
  if (files.length === 0) return undefined;
  const stat = await git(exec, ws.worktree, "diff", "--cached", "--stat", ws.base);
  const full = await exec("git", ["diff", "--cached", ws.base], ws.worktree);
  const patchLimit = mateTunables().num("duty.patchChars");
  const patch = full.stdout.length > patchLimit ? `${full.stdout.slice(0, patchLimit)}\n… (diff가 길어 잘랐습니다)` : full.stdout;
  return { info: { repo: ws.repo, worktree: ws.worktree, base: ws.base, files, ...(ws.copy ? { copy: true } : {}) }, stat, patch };
}

/** 작업 공간의 변경을 사용자 작업 폴더에 적용한다 (커밋하지 않은 변경으로 남는다) */
export async function applyChange(exec: Exec, change: ChangeInfo, patchFile: string): Promise<void> {
  // 바이너리 포함 전체 diff를 파일로 받아 사용자 저장소에 적용한다. 먼저 --check로 깨끗이 들어가는지 본다
  const diff = await exec("git", ["diff", "--cached", "--binary", `--output=${patchFile}`, change.base], change.worktree);
  if (diff.code !== 0) throw new Error("작업 공간의 변경을 읽지 못했습니다");
  // 복사본(저장소가 아닌 폴더)은 patch처럼 그대로 넣는다: 전역 core.autocrlf가 줄 끝을 바꾸지 않게
  const eol = change.copy ? ["-c", "core.autocrlf=false"] : [];
  const check = await exec("git", [...eol, "apply", "--check", "--whitespace=nowarn", patchFile], change.repo);
  if (check.code !== 0) {
    throw new Error(`내 작업 폴더가 그사이 바뀌어 그대로 적용할 수 없습니다. 작업 공간(${change.worktree})에서 직접 확인해 주세요`);
  }
  await git(exec, change.repo, ...eol, "apply", "--whitespace=nowarn", patchFile);
}

/** 작업 공간을 지운다. git이 만든 worktree라 git으로 지우고, 기록이 남지 않게 prune한다. 복사본은 그 폴더만 지운다 */
export async function removeWorkspace(exec: Exec, repo: string, worktree: string, copy = false): Promise<void> {
  if (copy) {
    await rm(worktree, { recursive: true, force: true });
    return;
  }
  await exec("git", ["worktree", "remove", "--force", worktree], repo);
  await exec("git", ["worktree", "prune"], repo);
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
}
