import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runner } from "../src/daemon";
import type { RunInput, RunOutcome } from "../src/executor";
import { matePaths, type MatePaths } from "../src/paths";
import { addRequest, listRuns, loadState, saveDuty } from "../src/store";

/** 임무를 동시에 돌린다 (설정 runner.maxParallel, 기본 2). 넘는 것과 같은 임무의 두 번째 요청은 기다린다 */
describe("임무 동시 실행", () => {
  let paths: MatePaths;
  let runner: Runner;
  let started: string[];
  let finish: Map<string, () => void>;
  let previousHome: string | undefined;

  beforeEach(async () => {
    paths = matePaths(await mkdtemp(join(tmpdir(), "mate-parallel-")));
    previousHome = process.env.MATE_HOME;
    process.env.MATE_HOME = paths.home;
    started = [];
    finish = new Map();
    for (const id of ["a", "b", "c"]) await saveDuty(paths, { id, name: `임무 ${id}`, cwd: paths.home, prompt: "x", profile: "observe", trigger: { kind: "manual" } });
    runner = new Runner({
      paths,
      kitDir: join(__dirname, "..", "..", "mate-kit"),
      locatePi: async () => ({ cliPath: "pi" }),
      exec: async () => ({ code: 1, stdout: "" }),
      // 가짜 Pi: 테스트가 끝내라고 할 때까지 돈다
      runPi: (async (_l: unknown, input: RunInput) => {
        started.push(input.duty.id);
        await new Promise<void>((resolve) => finish.set(input.duty.id, resolve));
        return { status: "done", summary: "끝", costUsd: 0, tokens: 1, proposals: 0 } satisfies RunOutcome;
      }) as never,
    });
  });
  afterEach(async () => {
    for (const done of finish.values()) done();
    await runner.stop();
    await runner.whenIdle();
    if (previousHome === undefined) delete process.env.MATE_HOME;
    else process.env.MATE_HOME = previousHome;
    await rm(paths.home, { recursive: true, force: true });
  });

  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
    expect(await check()).toBe(true);
  };

  it("두 임무는 함께 돌고, 세 번째는 하나가 끝나면 돈다", async () => {
    for (const id of ["a", "b", "c"]) await addRequest(paths, id);
    await runner.start();
    await until(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);
    let state = await loadState(paths);
    expect(state.running?.map((r) => r.dutyId).sort()).toEqual(["a", "b"]);
    expect(state.waiting).toEqual(["c"]);
    expect((await listRuns(paths, 10)).filter((r) => r.status === "running")).toHaveLength(2);

    finish.get("a")!();
    await until(() => started.includes("c"));
    state = await loadState(paths);
    expect(state.running?.map((r) => r.dutyId).sort()).toEqual(["b", "c"]);
    expect(state.waiting).toBeUndefined();
  });

  it("같은 임무를 다시 누르면 지금 실행이 끝난 뒤 한 번만 더 돈다", async () => {
    await addRequest(paths, "a");
    await runner.start();
    await until(() => started.length === 1);
    await addRequest(paths, "a", Date.now() + 1);
    await addRequest(paths, "a", Date.now() + 2);
    await runner.tick();
    await until(async () => (await loadState(paths)).waiting?.[0] === "a");
    expect(started).toEqual(["a"]);
    expect((await loadState(paths)).waiting).toEqual(["a"]);
    finish.get("a")!();
    await until(() => started.length === 2);
    finish.get("a")!();
    await until(async () => !(await loadState(paths)).running);
    expect(started).toEqual(["a", "a"]);
  });
});
