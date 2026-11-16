import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_MODEL_ARGS, PI_CLI, setupRealPi, type RealPiFixture } from "../../host-agent/test/helpers/real-pi";
import { readSections } from "../extensions/mate-chat/index";
import { MATE_ENV } from "../src/shared";

const MATE_CHAT = fileURLToPath(new URL("../extensions/mate-chat/index.ts", import.meta.url));

describe("Mate 대화 상태 섹션", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mate-sections-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("섹션 파일에서 Pi가 받는 이름과 글만 꺼낸다", async () => {
    const file = join(dir, "s.json");
    await writeFile(file, JSON.stringify({ mate_status: "지금", Bad: "x", preamble: "x", mate_empty: "", mate_num: 3 }));
    expect(readSections(file)).toEqual({ mate_status: "지금" });
    expect(readSections(join(dir, "없음.json"))).toEqual({});
  });
});

/** 실제 Pi로 대화 두 차례를 돌려, 두 번째 차례에는 바뀐 섹션만 대화 뒤에 붙는지 본다 (프롬프트 캐시가 맞으려면 앞부분이 그대로여야 한다) */
describe("Mate 대화 상태 섹션 + 실제 Pi", () => {
  let fixture: RealPiFixture;
  let dir: string;

  beforeAll(async () => {
    fixture = await setupRealPi();
    dir = await mkdtemp(join(tmpdir(), "mate-sections-pi-"));
  });
  afterAll(async () => {
    await fixture?.llm.close();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function turn(sections: Record<string, string>, prompt: string): Promise<void> {
    const file = join(dir, "sections.json");
    await writeFile(file, JSON.stringify(sections));
    // 실행기처럼 stdin을 닫고 돌린다 (열려 있으면 Pi가 입력을 기다린다)
    const child = spawn(
      process.execPath,
      [PI_CLI, "--mode", "json", "--session-dir", join(dir, "sessions"), "--session-id", "mate-chat-1", ...MOCK_MODEL_ARGS, "-ne", "-e", MATE_CHAT, "--append-system-prompt", "규칙", prompt],
      { cwd: fixture.projectDir, env: { ...process.env, ...fixture.piEnv, [MATE_ENV.sections]: file }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(`Pi 종료 코드 ${code}: ${stderr}`);
  }

  it("두 번째 차례에는 바뀐 섹션만 덧붙인다", async () => {
    await turn({ mate_status: "지금: 10:00", mate_duties: "임무: a" }, "안녕");
    await turn({ mate_status: "지금: 10:01" }, "또 안녕");

    const [name] = await readdir(join(dir, "sessions"));
    const lines = (await readFile(join(dir, "sessions", name!), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { message?: { role?: string; sections?: Record<string, string | null> } });
    const systems = lines.filter((l) => l.message?.role === "system").map((l) => l.message!.sections ?? {});
    expect(systems).toHaveLength(2);
    expect(systems[0]).toMatchObject({ addendum: expect.stringContaining("규칙"), mate_status: expect.stringContaining("10:00"), mate_duties: expect.stringContaining("임무: a") });
    // 둘째 차례: 시각만 바뀌고, 없어진 임무 섹션은 지운다. 규칙(addendum)은 다시 보내지 않는다
    expect(systems[1]).toEqual({ mate_status: expect.stringContaining("10:01"), mate_duties: null });
  }, 120_000);
});
