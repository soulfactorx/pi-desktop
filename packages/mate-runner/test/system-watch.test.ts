import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChat, readInbox } from "@pi-desktop/mate-kit";
import { runTools } from "../src/executor";
import { readActivity } from "../src/observer";
import { matePaths, type MatePaths } from "../src/paths";
import { localDateKey } from "../src/schedule";
import { saveConfig } from "../src/store";
import { peakHour, shellHabits } from "../src/system/habits";
import { commandShape, isSensitiveCommand, promptShape, scrubText } from "../src/system/privacy";
import { appName, macAppName, parseFailedUnits, parseHistory, parseJournal, parseWindowsHealth, systemPlatform } from "../src/system/sources";
import { DEFAULT_SYSTEM_OBSERVE } from "../src/system/types";
import { emptySystemState, habitQuestion, SystemWatch } from "../src/system/watch";
import { DEFAULT_CONFIG, type MateConfig, type RunnerState } from "../src/types";
import type { Exec } from "../src/watchers";

const HOUR = 3_600_000;

describe("시스템 관찰: 개인정보 가림", () => {
  it("로그 한 줄에서 홈·사용자 이름·메일·IP·주소 경로·토큰을 가린다", () => {
    const line =
      "Faulting app C:\\Users\\jun\\AppData\\app.exe for jun@example.com from 10.1.2.3 https://api.example.com/v1/x?key=1 token=abcd1234 sk-abcdefghijklmnop deadbeefdeadbeefdeadbeefdeadbeef";
    const out = scrubText(line, "C:\\Users\\jun", "jun");
    expect(out).not.toMatch(/jun|example\.com\/v1|10\.1\.2\.3|abcd1234|sk-abcdef|deadbeefdeadbeef/);
    expect(out).toContain("~\\AppData");
    expect(out).toContain("<메일>");
    expect(out).toContain("<IP>");
    expect(out).toContain("https://api.example.com/…");
    expect(scrubText("/home/alice/x and /Users/bob/y", "", "")).toBe("/home/<사용자>/x and /Users/<사용자>/y");
  });

  it("명령은 프로그램과 하위 명령만 남기고, 민감한 명령은 버린다", () => {
    expect(commandShape('git commit -m "고객 A 비밀 계약"')).toBe("git commit");
    expect(commandShape("npm run build -- --prod")).toBe("npm run build");
    expect(commandShape("sudo systemctl restart nginx")).toBe("systemctl restart");
    expect(commandShape("C:\\tools\\rg.exe secret-thing .")).toBeUndefined(); // 비밀처럼 보이는 낱말
    expect(commandShape("python3 ~/work/report.py --date 2026")).toBe("python3");
    expect(commandShape("ssh me@host")).toBeUndefined();
    expect(commandShape("export GITHUB_TOKEN=ghp_xxx")).toBeUndefined();
    expect(commandShape(" git push")).toBeUndefined(); // 공백으로 시작: 기록 숨김
    expect(commandShape("API_KEY=1 node app.js")).toBeUndefined();
    expect(commandShape("curl -H 'Authorization: Bearer x' https://a")).toBeUndefined();
    expect(commandShape("cd ~/proj")).toBeUndefined(); // 뜻 없는 명령
    expect(commandShape("kubectl get pods", ["kubectl"])).toBeUndefined(); // 무시 목록
    expect(commandShape("git pull && npm test")).toBe("git pull");
    expect(isSensitiveCommand("gpg --decrypt x")).toBe(true);
    expect(promptShape("PR #123 리뷰해 줘 https://github.com/a/b")).toBe("pr 리뷰해 줘");
  });
});

describe("시스템 관찰: 수집기 결과 읽기", () => {
  it("Windows 이벤트·예약 작업 JSON", () => {
    const one = parseWindowsHealth(
      JSON.stringify({ events: { p: "disk", i: 7, l: 2, t: "2026-11-17T01:00:00.000Z", m: "bad block" }, tasks: "Backup" }),
    );
    expect(one.events).toEqual([{ source: "disk", id: "7", level: "error", at: Date.parse("2026-11-17T01:00:00.000Z"), message: "bad block" }]);
    expect(one.failed).toEqual([{ name: "Backup", kind: "task" }]);
    expect(parseWindowsHealth("")).toEqual({ events: [], failed: [] });
  });

  it("journalctl JSON과 실패한 유닛", () => {
    const events = parseJournal(
      [
        JSON.stringify({ PRIORITY: "3", _SYSTEMD_UNIT: "nginx.service", MESSAGE: "bind failed", __REALTIME_TIMESTAMP: "1763340000000000" }),
        JSON.stringify({ PRIORITY: "2", SYSLOG_IDENTIFIER: "kernel", MESSAGE: [104, 105], __REALTIME_TIMESTAMP: "1763340001000000" }),
        "깨진 줄",
      ].join("\n"),
    );
    expect(events.map((e) => [e.source, e.level, e.message])).toEqual([
      ["nginx.service", "error", "bind failed"],
      ["kernel", "critical", "hi"],
    ]);
    expect(parseFailedUnits("● nginx.service loaded failed failed A\nbackup.timer loaded failed failed B\n")).toEqual(["nginx.service", "backup.timer"]);
  });

  it("셸 기록 형식마다 명령과 시각을 읽는다", () => {
    expect(parseHistory("#1763340000\ngit pull\nls\n", "bash")).toEqual([{ command: "git pull", at: 1763340000000 }, { command: "ls" }]);
    expect(parseHistory(": 1763340000:0;npm test\n", "zsh")).toEqual([{ command: "npm test", at: 1763340000000 }]);
    expect(parseHistory("- cmd: cargo build\n  when: 1763340000\n- cmd: git status\n", "fish")).toEqual([
      { command: "cargo build", at: 1763340000000 },
      { command: "git status" },
    ]);
    expect(parseHistory("git pull `\n  --rebase\nnpm test\n", "pwsh").map((c) => c.command)).toEqual(["git pull `", "npm test"]);
  });

  it("프로그램 이름: 늘 떠 있는 것은 빼고 .app 안의 것만", () => {
    expect(appName("Code.exe")).toBe("Code");
    expect(appName("explorer")).toBeUndefined();
    expect(appName("kworker/0:1")).toBeUndefined();
    expect(macAppName("/Applications/Slack.app/Contents/MacOS/Slack")).toBe("Slack");
    expect(macAppName("/usr/libexec/trustd")).toBeUndefined();
    expect(systemPlatform("linux", { PREFIX: "/data/data/com.termux/files/usr" })).toBe("unsupported");
    expect(systemPlatform("win32", {})).toBe("win32");
  });
});

describe("시스템 관찰: 되풀이하는 작업", () => {
  it("여러 날 같은 명령 묶음과 시간대를 찾는다", () => {
    const st = emptySystemState(0);
    const now = new Date(2026, 10, 17, 18).getTime();
    for (let i = 0; i < 6; i++) {
      const day = localDateKey(now - i * 24 * HOUR);
      st.shellDays[day] = ["git pull", "npm test", "gh pr", i % 2 ? "docker ps" : "cargo build"];
      st.shellHours[day] = { "git pull": Object.assign(new Array(24).fill(0), { 9: 1 }) };
    }
    const habits = shellHabits(st, now, 4, 14);
    expect(habits[0]).toMatchObject({ kind: "shell", label: "git pull → npm test → gh pr", days: 6, hour: 9 });
    // 일부 묶음(git pull → npm test)은 따로 나오지 않는다
    expect(habits.filter((h) => h.label.includes("git pull"))).toHaveLength(1);
    expect(habitQuestion(habits[0]!)).toContain("오전 9시쯤");
    expect(peakHour([0, 0, 1])).toBeUndefined();
  });
});

describe("시스템 관찰: 실행기", () => {
  let paths: MatePaths;
  beforeEach(async () => {
    paths = matePaths(await mkdtemp(join(tmpdir(), "mate-system-")));
  });
  afterEach(async () => {
    await rm(paths.home, { recursive: true, force: true });
  });

  const config = (system: Partial<MateConfig["observe"]["system"]>, limit = 5): MateConfig => ({
    ...DEFAULT_CONFIG,
    observe: { ...DEFAULT_CONFIG.observe, dailySuggestionLimit: limit, system: { ...DEFAULT_SYSTEM_OBSERVE, ...system } },
  });

  it("오류 로그를 가려 모으고, 위험한 것은 인박스에 한 번만 알리고, 끄면 지운다", async () => {
    const now = Date.now();
    let calls = 0;
    const exec: Exec = async (command, args) => {
      calls++;
      if (command === "journalctl")
        return {
          code: 0,
          stdout: [1, 2, 3]
            .map((n) => JSON.stringify({ PRIORITY: "3", _SYSTEMD_UNIT: "backup.service", MESSAGE: `failed for /home/alice/secret ${n}`, __REALTIME_TIMESTAMP: String((now - n * 60_000) * 1000) }))
            .join("\n"),
        };
      if (command === "systemctl") return { code: 0, stdout: args.includes("--user") ? "" : "backup.service loaded failed failed Backup\n" };
      return { code: 1, stdout: "" };
    };
    const watch = new SystemWatch(paths, exec, { platform: "linux", home: "/home/alice", user: "alice" });
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    await watch.tick(state, config({ health: true }), now);
    expect(state.system?.events).toHaveLength(1);
    expect(state.system!.events[0]!.message).toBe("failed for ~/secret 1");
    expect(Object.values(state.system!.events[0]!.days)).toEqual([3]);
    expect(state.system!.failed).toEqual([expect.objectContaining({ name: "backup.service", kind: "service" })]);
    const items = await readInbox(paths.inbox);
    expect(items.map((i) => i.topic)).toEqual(["system-health", "system-health"]);
    // 관찰 현황과 활동 기록 (가린 내용으로)
    expect(state.live?.steps.health).toMatchObject({ ok: true, note: expect.stringContaining("새 오류 3건 (backup.service)"), next: now + HOUR });
    const records = await readActivity(paths);
    expect(records).toEqual([expect.objectContaining({ kind: "system", what: "health", title: "새 오류 3건, 새로 실패 1개" })]);
    expect(JSON.stringify(records)).not.toContain("alice");
    expect(items.some((i) => i.title.includes("되풀이"))).toBe(true);
    // 간격 안에서는 다시 읽지 않고, 같은 것은 다시 알리지 않는다
    const before = calls;
    await watch.tick(state, config({ health: true }), now + 60_000);
    expect(calls).toBe(before);
    await watch.tick(state, config({ health: true }), now + 2 * HOUR);
    expect(await readInbox(paths.inbox)).toHaveLength(2);
    // 끄면 모은 것을 지운다
    await watch.tick(state, config({}), now + 3 * HOUR);
    expect(state.system).toBeUndefined();
  });

  it("셸 기록은 켠 뒤 새 줄만 모양으로 세고, 되풀이하면 대화로 한 번만 묻는다", async () => {
    const home = paths.home;
    const history = join(home, ".bash_history");
    const start = new Date(2026, 10, 10, 9).getTime();
    // 켜기 전의 시각 있는 기록 (최근 14일 안): 5일 동안 같은 묶음
    const past = [];
    for (let d = 0; d < 5; d++) {
      const at = Math.floor((start + d * 24 * HOUR) / 1000);
      past.push(`#${at}`, "git pull", `#${at + 60}`, "npm test", `#${at + 120}`, 'git commit -m "비밀 메모"');
    }
    await writeFile(history, `${past.join("\n")}\n`);
    const watch = new SystemWatch(paths, async () => ({ code: 1, stdout: "" }), { platform: "linux", home, user: "me" });
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const now = start + 5 * 24 * HOUR;
    await watch.tick(state, config({ habits: true, shellHistory: true }), now);
    const saved = JSON.stringify(state.system);
    expect(saved).not.toContain("비밀 메모");
    expect(saved).toContain("git commit");
    const chat = await readChat(paths.chat);
    expect(chat.filter((l) => l.kind === "question")).toHaveLength(1);
    expect(chat[0]!.text).toContain("git pull → npm test → git commit");
    expect(chat[0]!.options).toEqual(["예, 임무로 만들어 줘", "아니요, 괜찮아요"]);
    expect(state.live?.steps.history?.note).toContain("새 명령 15개 셈");
    expect((await readActivity(paths)).map((r) => (r.kind === "system" ? r.what : r.kind))).toEqual(["habit-asked"]);
    // 같은 날 다시 묻지 않는다 (그 사이 새 명령 하나: 시각이 없으면 읽은 때로 센다)
    await writeFile(history, `${past.join("\n")}\ncargo build --release\n`);
    await watch.tick(state, config({ habits: true, shellHistory: true }), now + HOUR);
    expect((await readChat(paths.chat)).filter((l) => l.kind === "question")).toHaveLength(1);
    // 날이 바뀌면 지난날의 명령 모양을 하루 요약으로 남긴다 (모양과 횟수만)
    await watch.tick(state, config({ habits: true, shellHistory: true }), now + 24 * HOUR);
    const day = (await readActivity(paths)).find((r) => r.kind === "system" && r.what === "shell-day");
    expect(day).toMatchObject({ title: expect.stringContaining("셸 명령") });
    expect(JSON.stringify(day)).not.toContain("비밀 메모");
    // 셸 기록만 끄면 명령 기록은 지운다
    await watch.tick(state, config({ habits: true }), now + 2 * HOUR);
    expect(state.system?.shellDays).toEqual({});
  });

  it("분석은 켰을 때 하루 한 번, 요약만 담아 제안·질문 도구로만 돈다", async () => {
    const now = Date.now();
    const watch = new SystemWatch(paths, async () => ({ code: 1, stdout: "" }), { platform: "win32", home: "C:\\Users\\me", user: "me" });
    const st = emptySystemState(now - 2 * 24 * HOUR);
    st.disks = [{ mount: "C:\\", total: 100 * 1024 ** 3, free: 5 * 1024 ** 3, at: now }];
    st.apps[localDateKey(now)] = { Code: 300, chrome: 120 };
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 }, system: st };
    expect(await watch.nextJob(state, config({ health: true, apps: true }), now)).toBeUndefined(); // 분석 꺼짐
    const job = await watch.nextJob(state, config({ health: true, apps: true, analyze: true }), now);
    expect(job?.prompt).toContain("C:\\ 95% 사용");
    expect(job?.prompt).toContain("Code 5시간 0분");
    expect(job?.cwd).toBe(paths.home);
    expect(runTools({ duty: job!, home: paths.home } as never)).toEqual(["mate_propose", "mate_ask"]);
    expect(await watch.nextJob(state, config({ health: true, apps: true, analyze: true }), now + HOUR)).toBeUndefined(); // 하루 한 번
  });

  it("설정 파일의 시스템 관찰은 모르는 값이면 꺼짐", async () => {
    await writeFile(paths.config, JSON.stringify({ observe: { system: { health: "yes", apps: true, ignore: ["Steam", "", 3] } } }));
    const saved = await saveConfig(paths, {});
    expect(saved.observe.system).toEqual({ ...DEFAULT_SYSTEM_OBSERVE, apps: true, ignore: ["steam"] });
    expect(JSON.parse(await readFile(paths.config, "utf8")).observe.system.apps).toBe(true);
  });
});
