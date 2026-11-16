import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskUsage } from "../../src/server/disk-usage";
import type { UsageSnapshot } from "../../src/shared/web-files";
import { rebuildableHint } from "../../src/shared/web-files";

/** du처럼 센 크기 (블록 수, Windows는 길이) */
function du(path: string): number {
  const info = lstatSync(path);
  const own = process.platform !== "win32" ? info.blocks * 512 : info.size;
  if (!info.isDirectory()) return own;
  return own + readdirSync(path).reduce((sum, name) => sum + du(join(path, name)), 0);
}

async function finish(usage: DiskUsage, first: UsageSnapshot): Promise<UsageSnapshot> {
  let snap = first;
  for (let i = 0; !snap.done && i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10));
    snap = usage.poll(snap.id);
  }
  return snap;
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), "pw-usage-"));
  mkdirSync(join(root, "big", "deep", "deeper"), { recursive: true });
  writeFileSync(join(root, "big", "a.bin"), Buffer.alloc(200_000, 1));
  writeFileSync(join(root, "big", "deep", "deeper", "b.bin"), Buffer.alloc(500_000, 1));
  mkdirSync(join(root, "small"));
  writeFileSync(join(root, "small", "c.txt"), "c");
  writeFileSync(join(root, "top.txt"), Buffer.alloc(50_000, 1));
  // 밖을 가리키는 링크는 따라가지 않는다
  const outside = mkdtempSync(join(tmpdir(), "pw-usage-out-"));
  writeFileSync(join(outside, "huge.bin"), Buffer.alloc(2_000_000, 1));
  symlinkSync(outside, join(root, "storage"), process.platform === "win32" ? "junction" : "dir");
  return root;
}

describe("파일 관리자 용량 보기", () => {
  it("하위 폴더까지 du처럼 세고, 큰 것부터, 링크는 따라가지 않는다", async () => {
    const root = tree();
    const usage = new DiskUsage({ maxMs: () => 60_000 });
    const snap = await finish(usage, await usage.start(root));
    expect(snap.done).toBe(true);
    expect(snap.partial).toBe(false);
    const byName = Object.fromEntries(snap.items.map((i) => [i.name, i]));
    expect(byName.big!.size).toBe(du(join(root, "big")));
    expect(byName.big!.count).toBe(5); // big, a.bin, deep, deeper, b.bin
    expect(byName.small!.size).toBe(du(join(root, "small")));
    expect(byName.storage!.link).toBe(true);
    expect(byName.storage!.size).toBeLessThan(100_000);
    expect(snap.items[0]!.name).toBe("big");
    expect(snap.total).toBe(snap.items.reduce((s, i) => s + i.size, 0));
    // 큰 파일: 링크 너머(huge.bin)는 없고, 큰 것부터
    expect(snap.largest.map((f) => f.path.slice(root.length + 1))).toEqual([join("big", "deep", "deeper", "b.bin"), join("big", "a.bin"), "top.txt", join("small", "c.txt")]);
  });

  it("다 센 폴더는 들어가면 바로 보이고, 지우면 위 폴더에서 뺀다", async () => {
    const root = tree();
    const usage = new DiskUsage({ maxMs: () => 60_000 });
    const first = await finish(usage, await usage.start(root));
    const big = first.items.find((i) => i.name === "big")!;
    const inner = await usage.start(join(root, "big"));
    expect(inner.id).toBe("");
    expect(inner.done).toBe(true);
    // 폴더 자신의 크기를 뺀 안쪽 합계
    expect(inner.total).toBe(big.size - (du(join(root, "big")) - du(join(root, "big", "a.bin")) - du(join(root, "big", "deep"))));
    expect(inner.largest[0]!.path).toBe(join(root, "big", "deep", "deeper", "b.bin"));

    // 지우기: 서버가 지우기 전에 크기를 묻고, 지운 뒤 뺀다
    const deep = join(root, "big", "deep");
    const size = await usage.sizeOf(deep);
    expect(size).toBe(du(deep));
    rmSync(deep, { recursive: true });
    usage.removed(deep, size);
    const again = await usage.start(root);
    expect(again.id).toBe("");
    expect(again.stale).toBe(false);
    expect(again.items.find((i) => i.name === "big")!.size).toBe(du(join(root, "big")));
    expect(again.largest.some((f) => f.path.includes("deeper"))).toBe(false);
  });

  it("만들기·옮기기 뒤에는 '바뀜'으로 보이고, 다시 세면 풀린다", async () => {
    const root = tree();
    const usage = new DiskUsage({ maxMs: () => 60_000 });
    await finish(usage, await usage.start(root));
    writeFileSync(join(root, "small", "new.txt"), Buffer.alloc(10_000, 1));
    usage.changed([join(root, "small", "new.txt")]);
    expect((await usage.start(root)).stale).toBe(true);
    // 다른 곳(Pi 등)에서 새로 만든 폴더(센 적 없음)도 '바뀜'으로 보인다
    mkdirSync(join(root, "fresh"));
    expect((await usage.start(join(root, "big"))).stale).toBe(false);
    const recount = await finish(usage, await usage.start(root, true));
    expect(recount.id).not.toBe("");
    expect(recount.items.find((i) => i.name === "small")!.size).toBe(du(join(root, "small")));
    expect((await usage.start(root)).stale).toBe(false);
    mkdirSync(join(root, "later"));
    const withNew = await usage.start(root);
    expect(withNew.stale).toBe(true);
    expect(withNew.items.find((i) => i.name === "later")!.done).toBe(false);
  });

  it("다른 폴더를 세기 시작하면 앞의 계산은 멈추고, 시간이 다 되면 일부만 셌다고 알린다", async () => {
    const root = tree();
    let now = 0;
    const usage = new DiskUsage({ maxMs: () => 1000, now: () => now });
    const first = await usage.start(root);
    const second = await usage.start(join(root, "small"));
    const stopped = await finish(usage, usage.poll(first.id));
    expect(stopped.done).toBe(true);
    expect(stopped.partial).toBe(false);
    await finish(usage, second);
    // 시간 초과
    const slow = await usage.start(root, true);
    now = 5000;
    const partial = await finish(usage, slow);
    expect(partial.done).toBe(true);
    expect(partial.partial).toBe(true);
    // 일부만 센 폴더는 기억하지 않는다 (다음에 다시 센다)
    now = 6000;
    expect((await usage.start(root)).id).not.toBe("");
  });

  it("다시 받을 수 있는 폴더를 알아본다", () => {
    expect(rebuildableHint("node_modules", true)).toContain("npm install");
    expect(rebuildableHint("node_modules", false)).toBeUndefined();
    expect(rebuildableHint("constructor", true)).toBeUndefined();
    expect(rebuildableHint("Documents", true)).toBeUndefined();
  });
});
