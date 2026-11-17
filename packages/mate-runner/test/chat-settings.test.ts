import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendChatAction, CONFIRM_OPTIONS, readChat } from "@pi-desktop/mate-kit";
import { ChatAgent } from "../src/chat/chat-agent";
import { chatSystemPrompt } from "../src/chat/context";
import { writeGuide } from "../src/chat/settings";
import type { RunInput, RunOutcome } from "../src/executor";
import { matePaths, type MatePaths } from "../src/paths";
import { getDuty, listDuties, loadConfig, saveDuty, takeRequests } from "../src/store";
import { mateTunables } from "../src/tunables";

/** Mate 대화가 임무·앱 설정·수치 설정을 직접 바꾸고, 위험한 변경은 버튼으로 다시 묻는다 (설계 DESIGN-MATE.md §13.1) */
describe("Mate 대화의 설정 바꾸기", () => {
  let paths: MatePaths;
  let agent: ChatAgent;
  let actions: Array<Record<string, unknown>>;
  let previousHome: string | undefined;

  beforeEach(async () => {
    paths = matePaths(await mkdtemp(join(tmpdir(), "mate-chat-settings-")));
    previousHome = process.env.MATE_HOME;
    process.env.MATE_HOME = paths.home;
    actions = [];
    agent = new ChatAgent({
      paths,
      kitDir: join(__dirname, "..", "..", "mate-kit"),
      locatePi: async () => ({ cliPath: "pi" }),
      exec: async () => ({ code: 1, stdout: "" }),
      log: () => {},
      // 가짜 Pi: 정해 둔 할 일(mate_do)을 남기고 답한다
      runPi: (async (_l: unknown, input: RunInput) => {
        for (const a of actions) await appendChatAction(input.chat!.actionsPath, a);
        return { status: "done", summary: "맡겼어요", costUsd: 0, tokens: 1, proposals: 0 } satisfies RunOutcome;
      }) as never,
    });
    await saveDuty(paths, { id: "hn", name: "HN 요약", cwd: paths.home, prompt: "인기 10개", profile: "propose", trigger: { kind: "manual" } });
  });
  afterEach(async () => {
    agent.stop();
    if (previousHome === undefined) delete process.env.MATE_HOME;
    else process.env.MATE_HOME = previousHome;
    await rm(paths.home, { recursive: true, force: true });
  });

  const say = async (text: string, answerTo?: string) => {
    agent.submit({ text, source: "app", ...(answerTo ? { answerTo } : {}) });
    await agent.whenIdle();
    return readChat(paths.chat);
  };

  it("임무의 시간 제한·모델·켜기를 바로 고치고, run이면 바로 실행한다", async () => {
    actions = [{ action: "update_duty", duty: "HN 요약", timeout: 900, model: "anthropic/claude-sonnet-5-5", enabled: false, run: true }];
    const chat = await say("시간 제한 15분으로 늘리고 실행해 줘");
    const duty = await getDuty(paths, "hn");
    expect(duty).toMatchObject({ timeoutSec: 900, model: "anthropic/claude-sonnet-5-5", enabled: false });
    expect(chat.at(-1)!.text).toMatch(/시간 제한 300초→900초.*▶ HN 요약 실행을 요청했어요/s);
    expect((await takeRequests(paths)).map((r) => r.dutyId)).toEqual(["hn"]);
  });

  it("고치기만 맡기고 실행을 바란 말이면, 실행하지 않았다고 알린다", async () => {
    actions = [{ action: "update_duty", duty: "hn", prompt: "최신 20개" }];
    const chat = await say("임무 고쳐서 처리해 줘");
    expect(chat.at(-1)!.text).toContain("실행은 아직 요청하지 않았어요");
    expect(await takeRequests(paths)).toEqual([]);
  });

  it("안전한 앱 설정은 바로, 상한 올리기·개인정보 관찰은 버튼으로 묻고 답에 따라 바꾼다", async () => {
    actions = [
      { action: "set_config", setting: "paused", value: true },
      { action: "set_config", setting: "daily_run_limit", value: 50 },
      { action: "set_config", setting: "system_shell_history", value: true },
    ];
    let chat = await say("멈추고, 하루 50번까지, 셸 기록도 봐 줘");
    let config = await loadConfig(paths);
    expect(config.paused).toBe(true);
    expect(config.dailyRunLimit).toBe(20);
    expect(config.observe.system.shellHistory).toBe(false);
    const questions = chat.filter((l) => l.kind === "question" && l.confirm);
    expect(questions).toHaveLength(2);
    expect(questions[0]!.options).toEqual([...CONFIRM_OPTIONS]);
    // 상한은 바꾸고, 셸 기록은 그만
    actions = [];
    await say(CONFIRM_OPTIONS[0], questions[0]!.id);
    chat = await say(CONFIRM_OPTIONS[1], questions[1]!.id);
    config = await loadConfig(paths);
    expect(config.dailyRunLimit).toBe(50);
    expect(config.observe.system.shellHistory).toBe(false);
    expect(chat.at(-1)!.text).toBe("알겠어요. 바꾸지 않았어요.");
    // 같은 질문에 다시 답해도 한 번만
    chat = await say(CONFIRM_OPTIONS[0], questions[0]!.id);
    expect(chat.at(-1)!.text).toBe("이미 답한 질문이에요.");
  });

  it("답하지 않은 확인 질문은 다음 말에서 닫히고, 뒤늦은 답은 처리하지 않는다", async () => {
    actions = [{ action: "set_config", setting: "max_cost", value: 5 }];
    const chat = await say("비용 상한 5달러로");
    const q = chat.find((l) => l.confirm)!;
    actions = [];
    await say("아니 다른 얘기");
    const late = await say(CONFIRM_OPTIONS[0], q.id);
    expect(late.at(-1)!.text).toContain("지난 질문");
    expect((await loadConfig(paths)).maxCostUsd).toBe(0.5);
  });

  it("수치 설정은 바로, 프롬프트(글)는 묻고, 바꿀 수 없는 항목은 거절한다. 임무 지우기는 묻는다", async () => {
    actions = [
      { action: "set_tunable", tunable: "duty.defaultTimeoutSec", value: 600 },
      { action: "set_tunable", tunable: "observer.instruction", value: "새 지시" },
      { action: "set_tunable", tunable: "observer.head", value: "x" },
      { action: "delete_duty", duty: "hn" },
    ];
    const chat = await say("설정 바꿔 줘");
    expect(mateTunables(paths.home).num("duty.defaultTimeoutSec")).toBe(600);
    const notice = chat.at(-1)!.text;
    expect(notice).toContain("⚙️");
    expect(notice).toContain("바꿀 수 없는 항목");
    expect(chat.filter((l) => l.confirm).map((l) => String(l.confirm!.action.action))).toEqual(["set_tunable", "delete_duty"]);
    expect(await listDuties(paths)).toHaveLength(1);
    const del = chat.find((l) => l.confirm?.action.action === "delete_duty")!;
    actions = [];
    await say("예", del.id);
    expect(await listDuties(paths)).toHaveLength(0);
  });

  it("대화 안내에 지금 설정·임무의 시간 제한이 들어가고, 기능 안내 파일을 만든다", async () => {
    const prompt = await chatSystemPrompt(paths, Date.now());
    expect(prompt).toContain("daily_run_limit = 20회");
    expect(prompt).toContain("시간 제한 300초");
    expect(prompt).toContain("mate-guide.md");
    const file = await writeGuide(paths);
    const guide = await readFile(file, "utf8");
    expect(guide).toContain("timeout(실행 시간 제한");
    expect(guide).toContain("duty.defaultTimeoutSec");
    expect(guide).toContain("대화로 못 하는 것");
  });
});
