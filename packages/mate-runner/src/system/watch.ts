import { homedir, userInfo } from "node:os";
import { appendChatQuestion, appendProposal, makeProposal, readChat } from "@pi-desktop/mate-kit";
import { ASK_TOOL, PROPOSE_TOOL } from "@pi-desktop/mate-kit";
import { readActivity, recordActivity, isTopicMuted, topicFeedback, OBSERVER_DUTY_ID } from "../observer";
import { liveDoing, liveStep } from "../live";
import type { MatePaths } from "../paths";
import { folderAlias } from "../remote/messages";
import { localDateKey } from "../schedule";
import { mateDefault, mateTunables } from "../tunables";
import type { Duty, MateConfig, RunnerState } from "../types";
import type { Exec } from "../watchers";
import { piHabits, shellHabits, whenPhrase } from "./habits";
import { commandShape, scrubText } from "./privacy";
import { historyFiles, parseHistory, readApps, readDisks, readHealth, readTail, systemPlatform, type Platform, type RawEvent } from "./sources";
import { type EventSummary, type HabitCandidate, type SystemObserveConfig, type SystemView, type SystemWatchState } from "./types";

/**
 * 시스템 관찰 (설계 DESIGN-MATE.md §10.1). 활동 관찰(Pi 세션)과 따로 켠다.
 *
 * 실행기가 확인할 때마다(30초) 켜진 것만, 정해진 간격으로:
 * - 시스템 건강(1시간): 오류 로그·실패한 서비스·예약 작업·디스크 → 규칙으로 바로 알림 (반복·위험·디스크 부족)
 * - 셸 기록(30분): 새로 붙은 줄만 읽어 명령 "모양"(프로그램 + 하위 명령)으로 줄여 센다 → 되풀이하는 작업이면 임무로 만들지 대화로 묻는다
 * - 프로그램(5분): 켜져 있는 프로그램 이름만 세어 날마다 분으로 모은다
 * - 분석(하루 한 번, 따로 켬): 위 요약만 모델에게 보내 필요한 작업을 제안받는다 (도구는 제안·질문만)
 *
 * 개인정보: 날것의 로그·명령·창 제목은 남기지 않는다. 끈 출처의 기록은 바로 지운다. 기록은 기본 14일만 둔다.
 */

const DAY = 24 * 3_600_000;
export const SYSTEM_TOPICS = { health: "system-health", habit: "system-habit", digest: "system-digest" } as const;
const YES = "예, 임무로 만들어 줘";
const NO = "아니요, 괜찮아요";

/** 알아 둘 만한 Windows 오류 (출처#번호): 한 번만 나와도 알린다 */
const NOTABLE: Record<string, string> = {
  "Microsoft-Windows-Kernel-Power#41": "예기치 않게 꺼졌다가 다시 켜짐 (전원·드라이버·과열 확인)",
  "disk#7": "디스크에 읽을 수 없는 부분이 있음 (백업·디스크 점검 권장)",
  "disk#51": "디스크 쓰기 중 오류 (디스크·케이블 확인)",
  "disk#153": "디스크 응답이 늦어 다시 시도함",
  "Ntfs#55": "파일 시스템이 손상됨 (chkdsk 권장)",
  "Microsoft-Windows-WindowsUpdateClient#20": "Windows 업데이트 설치 실패",
  "Application Error#1000": "프로그램이 비정상 종료됨",
  "Application Hang#1002": "프로그램이 응답하지 않아 닫힘",
  "BugCheck#1001": "블루스크린(시스템 오류)으로 다시 시작됨",
};

export function emptySystemState(now: number): SystemWatchState {
  return { since: now, events: [], failed: [], disks: [], history: {}, shellDays: {}, shellHours: {}, apps: {}, asked: {}, suggested: {}, today: { date: "", count: 0 }, problems: {} };
}

export function anySystemSource(sys: SystemObserveConfig): boolean {
  return sys.health || sys.habits || sys.apps;
}

export interface SystemWatchOptions {
  platform?: Platform;
  home?: string;
  user?: string;
  /** 오래 걸리는 확인 전에 상태를 저장한다 (화면에 "확인 중"이 바로 보이게) */
  save?: () => Promise<void>;
}

export class SystemWatch {
  readonly platform: Platform;
  private readonly home: string;
  private readonly user: string;
  private readonly save: () => Promise<void>;

  constructor(
    private readonly paths: MatePaths,
    private readonly exec: Exec,
    options: SystemWatchOptions = {},
  ) {
    this.platform = options.platform ?? systemPlatform();
    this.home = options.home ?? homedir();
    this.user = options.user ?? safeUser();
    this.save = options.save ?? (async () => {});
  }

  async tick(state: RunnerState, config: MateConfig, now: number): Promise<void> {
    const sys = config.observe.system;
    if (this.platform === "unsupported" || !anySystemSource(sys)) {
      // 다 끄면 모은 것을 모두 지운다
      if (state.system) delete state.system;
      return;
    }
    const st = (state.system ??= emptySystemState(now));
    forgetDisabled(st, sys);
    const today = localDateKey(now);
    if (st.today.date !== today) {
      // 날이 바뀌면 지난날의 셸 명령·프로그램을 한 줄씩 기록한다 (모양·이름과 횟수·시간만)
      if (st.today.date) await this.recordDay(st, st.today.date, now);
      st.today = { date: today, count: 0 };
    }
    const t = mateTunables();
    const due = (at: number | undefined, minutes: number) => !at || now - at >= minutes * 60_000;

    if (sys.health && due(st.healthAt, t.num("system.healthIntervalMinutes"))) {
      st.healthAt = now;
      liveDoing(state, now, "오류 로그·서비스·디스크 확인 중");
      await this.save().catch(() => undefined);
      const found = await this.checkHealth(st, now);
      liveDoing(state, now, undefined);
      const worst = st.disks.reduce((m, d) => Math.max(m, usedPercent(d)), 0);
      liveStep(
        state,
        "health",
        now,
        st.problems.health ??
          `새 오류 ${found.newEvents}건${found.sources.length ? ` (${found.sources.slice(0, 4).join(", ")})` : ""} · 실패 중 ${st.failed.length}개 · 디스크 ${st.disks.map((d) => `${d.mount} ${usedPercent(d)}%`).join(", ") || "-"}`,
        { ok: !st.problems.health && worst < 90, next: now + t.num("system.healthIntervalMinutes") * 60_000 },
      );
      if (found.newEvents > 0 || found.newlyFailed.length > 0)
        await recordActivity(this.paths, {
          at: now,
          kind: "system",
          what: "health",
          title: `새 오류 ${found.newEvents}건${found.newlyFailed.length ? `, 새로 실패 ${found.newlyFailed.length}개` : ""}`,
          details: [
            ...found.sources.map((source) => {
              const e = st.events.find((x) => x.source === source);
              return `${source}${e ? ` #${e.id} (${e.level === "critical" ? "위험" : "오류"}): ${e.message || "(내용 없음)"}` : ""}`;
            }),
            ...found.newlyFailed.map((name) => `실패: ${name}`),
          ].slice(0, 20),
        });
    } else if (!sys.health) delete state.live?.steps.health;
    if (sys.habits && sys.shellHistory && due(st.historyAt, t.num("system.historyIntervalMinutes"))) {
      st.historyAt = now;
      const counted = await this.readHistory(st, sys, now);
      liveStep(state, "history", now, st.problems.history ?? `새 명령 ${counted}개 셈 (프로그램과 하위 명령만) · 오늘 ${st.shellDays[today]?.length ?? 0}개`, {
        ok: !st.problems.history,
        next: now + t.num("system.historyIntervalMinutes") * 60_000,
      });
    }
    if (sys.apps && due(st.appsAt, t.num("system.appsIntervalMinutes"))) {
      const minutes = st.appsAt ? Math.min(Math.round((now - st.appsAt) / 60_000), t.num("system.appsIntervalMinutes") * 2) : t.num("system.appsIntervalMinutes");
      st.appsAt = now;
      const names = await this.sampleApps(st, sys, now, minutes);
      liveStep(state, "apps", now, st.problems.apps ?? `켜져 있는 프로그램 ${names.length}개${names.length ? `: ${names.slice(0, 6).join(", ")}` : ""}`, {
        ok: !st.problems.apps,
        next: now + t.num("system.appsIntervalMinutes") * 60_000,
      });
    }
    if (sys.analyze) {
      const every = t.num("system.analysisHours") * 3_600_000;
      const next = st.analyzedAt ? st.analyzedAt + every : st.since + Math.min(DAY, every);
      const prev = state.live?.steps.analysis;
      // 분석이 끝나면 데몬이 결과를 적는다. 여기서는 다음 차례만 고친다
      // 아직 돈 적이 없으면 시각을 0으로 두어 화면에 "아직"으로 보인다
      liveStep(state, "analysis", prev?.at ?? st.analyzedAt ?? 0, prev?.note ?? "모은 요약을 하루 한 번 모델에게 보내 제안받습니다", { ok: prev?.ok ?? true, next });
    }
    prune(st, now, t.num("system.keepDays"));
    await this.notify(st, config, now);
  }

  /** 하루 한 번(설정의 간격) 요약을 모델에게 보내 제안받는 실행. 분석이 꺼져 있거나 볼 것이 없으면 없음 */
  async nextJob(state: RunnerState, config: MateConfig, now: number): Promise<Duty | undefined> {
    const sys = config.observe.system;
    const st = state.system;
    if (!st || !sys.analyze || this.platform === "unsupported") return undefined;
    if (st.analyzedAt && now - st.analyzedAt < mateTunables().num("system.analysisHours") * 3_600_000) return undefined;
    if (st.today.count >= config.observe.dailySuggestionLimit) return undefined;
    // 켠 지 하루는 모은 뒤에 본다 (켜자마자 빈 요약을 보내지 않게)
    if (now - st.since < Math.min(DAY, mateTunables().num("system.analysisHours") * 3_600_000)) return undefined;
    const digest = await this.digest(st, config, now);
    if (!digest.hasContent) return undefined;
    st.analyzedAt = now;
    st.today.count += 1;
    return systemDuty(this.paths, digest.text, now);
  }

  /** 모델에게 보낼 요약 (화면에서 미리 보는 것과 같다) */
  async digest(st: SystemWatchState, config: MateConfig, now: number): Promise<{ text: string; hasContent: boolean }> {
    const sys = config.observe.system;
    const lines: string[] = [`[이 기기의 시스템 관찰 요약 · ${platformLabel(this.platform)} · ${localDateKey(now)}]`];
    let hasContent = false;
    if (sys.health) {
      const week = st.events.filter((e) => e.lastAt >= now - 7 * DAY).sort((a, b) => total(b) - total(a)).slice(0, 12);
      lines.push("", "오류 로그 (최근 7일, 많은 것부터):");
      if (week.length === 0) lines.push("- 없음");
      for (const e of week) lines.push(`- ${e.source} #${e.id} (${e.level === "critical" ? "위험" : "오류"}) ${total(e)}회, 마지막 ${ago(e.lastAt, now)}: ${e.message || "(내용 없음)"}`);
      if (st.failed.length) lines.push("실패해 있는 것:", ...st.failed.map((f) => `- ${unitLabel(f.kind)} ${f.name} (${ago(f.since, now)}부터)`));
      if (st.disks.length) lines.push("디스크:", ...st.disks.map((d) => `- ${d.mount} ${usedPercent(d)}% 사용, 남은 ${gb(d.free)}`));
      hasContent ||= week.length > 0 || st.failed.length > 0 || st.disks.some((d) => usedPercent(d) >= 80);
    }
    if (sys.habits) {
      const habits = await this.habits(st, config, now);
      lines.push("", "되풀이하는 작업 (명령은 프로그램과 하위 명령만 셈):");
      if (habits.length === 0) lines.push("- 아직 없음");
      for (const h of habits) {
        const asked = st.asked[h.key];
        lines.push(`- ${whenPhrase(h)} ${h.kind === "pi" ? `Pi 요청 "${h.label}"` : h.label} (${h.span}일 중 ${h.days}일)${asked?.answer === "no" ? " [임무로 만들지 물었더니 아니라고 함]" : asked ? " [임무로 만들지 물어봄]" : ""}`);
      }
      hasContent ||= habits.length > 0;
    }
    if (sys.apps) {
      const day = lastAppsDay(st);
      const apps = day ? topApps(st.apps[day]!, 10) : [];
      lines.push("", `켜져 있던 프로그램 (${day ?? "아직 없음"}, 이름과 시간만):`);
      for (const a of apps) lines.push(`- ${a.name} ${hm(a.minutes)}`);
      hasContent ||= apps.length > 0;
    }
    const text = lines.join("\n");
    return { text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text, hasContent };
  }

  async habits(st: SystemWatchState, config: MateConfig, now: number): Promise<HabitCandidate[]> {
    const sys = config.observe.system;
    if (!sys.habits) return [];
    const t = mateTunables();
    const span = t.num("system.keepDays");
    const minDays = t.num("system.habitMinDays");
    const out = sys.shellHistory ? shellHabits(st, now, minDays, span) : [];
    // Pi 요청은 활동 관찰이 켜져 있어야 기록이 있다 (이미 보는 기록이라 더 읽는 것은 없다)
    if (config.observe.enabled) {
      const sessions = (await readActivity(this.paths, 1500)).flatMap((r) =>
        r.kind === "session-ended" && r.session.app !== "mate" ? [{ at: r.at, cwd: r.session.cwd, ...(r.session.firstPrompt ? { firstPrompt: r.session.firstPrompt } : {}) }] : [],
      );
      out.push(...piHabits(sessions, now, Math.max(3, minDays - 1), span));
    }
    return out.filter((h) => !isIgnored(h.label, sys.ignore));
  }

  async view(state: RunnerState, config: MateConfig, now: number): Promise<SystemView> {
    const st = state.system;
    const day = st ? lastAppsDay(st) : undefined;
    return {
      supported: this.platform !== "unsupported",
      platform: platformLabel(this.platform),
      events: st ? [...st.events].sort((a, b) => b.lastAt - a.lastAt).slice(0, 30) : [],
      failed: st?.failed ?? [],
      disks: st?.disks ?? [],
      habits: st ? await this.habits(st, config, now) : [],
      apps: st && day ? topApps(st.apps[day]!, 15) : [],
      ...(day ? { appsDate: day } : {}),
      shellCommands: st ? Object.values(st.shellDays).reduce((n, seq) => n + seq.length, 0) : 0,
      problems: st?.problems ?? {},
      today: st?.today ?? { date: "", count: 0 },
      ...(st?.analyzedAt ? { analyzedAt: st.analyzedAt } : {}),
      ...(st ? { since: st.since } : {}),
    };
  }

  private async checkHealth(st: SystemWatchState, now: number): Promise<{ newEvents: number; sources: string[]; newlyFailed: string[] }> {
    // 처음에는 하루 전부터 (켜자마자 지난 오류가 쏟아지지 않게, 그래도 오늘 상태는 보이게)
    const since = st.healthCursor ?? now - DAY;
    const reading = await readHealth(this.platform, this.exec, since, this.paths.home).catch((e: Error) => ({ events: [] as RawEvent[], failed: [], problem: e.message }));
    if (reading.problem) st.problems.health = reading.problem;
    else delete st.problems.health;
    st.healthCursor = now;
    let newEvents = 0;
    const sources = new Set<string>();
    for (const raw of reading.events) {
      if (raw.at < since) continue;
      newEvents++;
      sources.add(scrubText(raw.source, this.home, this.user, 60));
      const key = `${raw.source}#${raw.id}`;
      const day = localDateKey(raw.at);
      const message = scrubText(raw.message, this.home, this.user);
      const found = st.events.find((e) => e.key === key);
      if (found) {
        found.days[day] = (found.days[day] ?? 0) + 1;
        // 가장 최근 것의 내용을 보인다
        if (message && raw.at >= found.lastAt) found.message = message;
        found.lastAt = Math.max(found.lastAt, raw.at);
        if (raw.level === "critical") found.level = "critical";
      } else {
        st.events.push({ key, source: scrubText(raw.source, this.home, this.user, 60), id: raw.id, level: raw.level, message, days: { [day]: 1 }, firstAt: raw.at, lastAt: raw.at });
      }
    }
    // 지금 실패해 있는 것만 남긴다 (언제부터인지는 이어 간다)
    const beforeFailed = new Set(st.failed.map((f) => `${f.kind}:${f.name}`));
    st.failed = reading.failed.map((f) => {
      const before = st.failed.find((x) => x.name === f.name && x.kind === f.kind);
      return { ...f, name: scrubText(f.name, this.home, this.user, 80), since: before?.since ?? now, seenAt: now };
    });
    st.disks = await readDisks(this.platform, now, this.home);
    return { newEvents, sources: [...sources], newlyFailed: st.failed.filter((f) => !beforeFailed.has(`${f.kind}:${f.name}`)).map((f) => f.name) };
  }

  /** 지난날의 셸 명령(모양별 횟수)과 프로그램(켜져 있던 시간)을 활동 기록에 한 줄씩 남긴다 */
  private async recordDay(st: SystemWatchState, day: string, now: number): Promise<void> {
    const seq = st.shellDays[day] ?? [];
    if (seq.length) {
      const counts = new Map<string, number>();
      for (const [shape, hours] of Object.entries(st.shellHours[day] ?? {})) counts.set(shape, hours.reduce((a, b) => a + b, 0));
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      await recordActivity(this.paths, { at: now, kind: "system", what: "shell-day", title: `${day} 셸 명령 ${seq.length}개 (모양 ${counts.size}가지)`, details: top.map(([shape, n]) => `${shape} ${n}회`) });
    }
    const apps = st.apps[day];
    if (apps && Object.keys(apps).length) {
      const top = topApps(apps, 10);
      await recordActivity(this.paths, { at: now, kind: "system", what: "apps-day", title: `${day} 켜져 있던 프로그램 ${Object.keys(apps).length}개`, details: top.map((a) => `${a.name} ${hm(a.minutes)}`) });
    }
  }

  /** 새 줄을 읽어 모양으로 센다. 센 명령 수를 돌려준다 */
  private async readHistory(st: SystemWatchState, sys: SystemObserveConfig, now: number): Promise<number> {
    const files = await historyFiles(this.platform, this.home).catch(() => []);
    if (files.length === 0) {
      st.problems.history = "셸 기록 파일을 찾지 못했습니다 (bash·zsh·fish·PowerShell)";
      return 0;
    }
    let counted = 0;
    const add = (shape: string | undefined, at: number) => {
      if (!shape) return;
      counted++;
      addShape(st, shape, at);
    };
    delete st.problems.history;
    const keep = mateTunables().num("system.keepDays");
    for (const file of files) {
      const entry = st.history[file.path];
      try {
        if (!entry) {
          // 처음: 시각이 적힌 기록만 최근 며칠 치를 읽고, 시각 없는 지난 기록은 읽지 않는다 (한날로 몰리지 않게)
          const { text, size } = await readTail(file.path, 0);
          const past = parseHistory(text, file.format).filter((c) => c.at !== undefined && c.at >= now - keep * DAY && c.at <= now);
          for (const c of past) add(commandShape(c.command, sys.ignore), c.at!);
          st.history[file.path] = { offset: size };
          continue;
        }
        const { text, offset } = await readTail(file.path, entry.offset);
        entry.offset = offset;
        for (const c of parseHistory(text, file.format)) {
          const at = c.at !== undefined && c.at <= now && c.at >= now - DAY ? c.at : now;
          add(commandShape(c.command, sys.ignore), at);
        }
      } catch {
        // 못 읽은 파일은 다음에
      }
    }
    return counted;
  }

  /** 켜져 있는 프로그램 이름을 센다. 이번에 센 이름을 돌려준다 */
  private async sampleApps(st: SystemWatchState, sys: SystemObserveConfig, now: number, minutes: number): Promise<string[]> {
    const { names, problem } = await readApps(this.platform, this.exec, this.paths.home).catch((e: Error) => ({ names: [] as string[], problem: e.message }));
    if (problem) st.problems.apps = problem;
    else delete st.problems.apps;
    const day = localDateKey(now);
    const today = (st.apps[day] ??= {});
    for (const name of names) {
      if (isIgnored(name, sys.ignore)) continue;
      today[name] = (today[name] ?? 0) + minutes;
    }
    // 하루에 프로그램 60개까지 (적게 켜진 것부터 버린다)
    const entries = Object.entries(today);
    if (entries.length > 60) st.apps[day] = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 60));
    return names.filter((name) => !isIgnored(name, sys.ignore));
  }

  /** 규칙 알림: 디스크 부족·위험 오류·반복 오류·실패한 서비스는 인박스로, 되풀이 작업은 대화로 묻는다 */
  private async notify(st: SystemWatchState, config: MateConfig, now: number): Promise<void> {
    const sys = config.observe.system;
    const limit = config.observe.dailySuggestionLimit;
    const feedback = await topicFeedback(this.paths);
    const healthMuted = isTopicMuted(feedback[SYSTEM_TOPICS.health]);
    const recently = (key: string, days: number) => st.suggested[key] !== undefined && now - st.suggested[key]! < days * DAY;
    const propose = async (key: string, days: number, title: string, summary: string, severity: "info" | "warn") => {
      if (healthMuted || recently(key, days) || st.today.count >= limit) return;
      st.suggested[key] = now;
      const item = makeProposal({ title, summary, severity, topic: SYSTEM_TOPICS.health }, { dutyId: OBSERVER_DUTY_ID, runId: `system-${now}` }, now);
      if (await appendProposal(this.paths.inbox, item)) st.today.count += 1;
    };

    if (sys.health) {
      for (const d of st.disks) {
        const pct = usedPercent(d);
        if (pct >= 90 || d.free < 2 * 1024 ** 3)
          await propose(`disk:${d.mount}`, 3, `디스크 ${d.mount} 공간이 부족합니다 (${pct}% 사용)`, `남은 공간 ${gb(d.free)} / 전체 ${gb(d.total)}. 큰 파일·캐시·다운로드 폴더를 정리하거나 휴지통을 비우세요.`, "warn");
      }
      for (const e of st.events) {
        const today = e.days[localDateKey(now)] ?? 0;
        const note = NOTABLE[e.key];
        if (!note && e.level !== "critical" && today < 3) continue;
        const where = this.platform === "win32" ? `이벤트 뷰어 > Windows 로그(시스템·응용 프로그램)에서 원본 "${e.source}", 이벤트 ID ${e.id}` : `journalctl -p 3 -u ${e.source} 또는 journalctl -p 3 -t ${e.source}`;
        await propose(
          `event:${e.key}`,
          7,
          note ? `${note}: ${e.source}` : `${e.source}에서 오류가 되풀이됩니다 (오늘 ${today}회)`,
          `${e.message || "(내용 없음)"}\n최근 7일 ${total(e)}회, 마지막 ${ago(e.lastAt, now)}.\n확인: ${where}`,
          e.level === "critical" || note ? "warn" : "info",
        );
      }
      for (const f of st.failed) {
        const how = f.kind === "task" ? "작업 스케줄러에서 그 작업의 마지막 실행 결과" : `systemctl ${f.kind === "user-service" ? "--user " : ""}status ${f.name}`;
        await propose(`failed:${f.kind}:${f.name}`, 3, `${unitLabel(f.kind)} ${f.name}이(가) 실패해 있습니다`, `${ago(f.since, now)}부터 실패 상태입니다.\n확인: ${how}`, "warn");
      }
    }

    if (sys.habits) {
      await this.collectAnswers(st);
      // 되풀이 작업은 하루에 하나만 묻는다
      const askedToday = Object.values(st.asked).some((a) => localDateKey(a.at) === localDateKey(now));
      if (!askedToday && st.today.count < limit) {
        const habits = await this.habits(st, config, now);
        const next = habits.find((h) => !st.asked[h.key]);
        if (next) {
          const text = habitQuestion(next);
          if (await appendChatQuestion(this.paths.chat, { text, options: [YES, NO], ...(next.cwd ? { cwd: next.cwd } : {}) }, now)) {
            const lines = await readChat(this.paths.chat);
            const q = lines.findLast((l) => l.kind === "question" && l.text === text.trim());
            st.asked[next.key] = { at: now, ...(q ? { questionId: q.id } : {}) };
            st.today.count += 1;
            await recordActivity(this.paths, { at: now, kind: "system", what: "habit-asked", title: `되풀이 작업을 임무로 만들지 물음: ${next.label}`, details: [text] });
          }
        }
      }
    }
  }

  /** 되풀이 작업 질문의 답을 기억한다 ("아니요"면 다시 묻지 않고 분석에도 그렇게 알린다) */
  private async collectAnswers(st: SystemWatchState): Promise<void> {
    const waiting = Object.values(st.asked).filter((a) => a.questionId && !a.answer);
    if (waiting.length === 0) return;
    const lines = await readChat(this.paths.chat);
    for (const a of waiting) {
      const reply = lines.find((l) => l.answerTo === a.questionId);
      if (!reply) continue;
      a.answer = reply.text.trim().startsWith("예") ? "yes" : "no";
      const key = Object.entries(st.asked).find(([, v]) => v === a)?.[0] ?? "";
      await recordActivity(this.paths, { at: reply.at, kind: "system", what: "habit-answer", title: `되풀이 작업 질문에 "${a.answer === "yes" ? "예" : "아니요"}": ${key.replace(/^(shell|pi):/, "")}` });
    }
  }
}

/** 되풀이 작업을 임무로 만들지 묻는 말 */
export function habitQuestion(h: HabitCandidate): string {
  const when = whenPhrase(h);
  if (h.kind === "pi")
    return `최근 ${h.span}일 중 ${h.days}일, ${when} Pi에게 "${h.label}" 같은 요청을 하셨어요${h.cwd ? ` (폴더 ${folderAlias(h.cwd)})` : ""}. 이걸 Mate 임무로 만들어 정해진 때에 대신 해 드릴까요?`;
  return `최근 ${h.span}일 중 ${h.days}일, ${when} \`${h.label}\`을(를) 실행하셨어요. 이 작업을 Mate 임무로 만들어 정해진 때에 대신 확인해 드릴까요? (만들면 어느 폴더에서 할지 여쭤볼게요)`;
}

/** 분석 실행의 임시 임무: 요약만 보고 제안·질문만 할 수 있다 (파일·명령 도구 없음) */
export function systemDuty(paths: MatePaths, digest: string, now: number): Duty {
  const head = mateDefault<string>("observer.head");
  return {
    id: OBSERVER_DUTY_ID,
    name: "Mate 시스템 관찰자",
    enabled: true,
    cwd: paths.home,
    prompt: [`${head} ${mateTunables().text("system.instruction")}`, "", digest].join("\n"),
    profile: "propose",
    tools: [PROPOSE_TOOL, ASK_TOOL],
    trigger: { kind: "manual" },
    timeoutSec: 180,
    createdAt: now,
  };
}

function addShape(st: SystemWatchState, shape: string | undefined, at: number): void {
  if (!shape) return;
  const day = localDateKey(at);
  const seq = (st.shellDays[day] ??= []);
  if (seq.at(-1) !== shape && seq.length < 400) seq.push(shape);
  const hours = (st.shellHours[day] ??= {});
  if (!hours[shape] && Object.keys(hours).length >= 200) return;
  const h = (hours[shape] ??= new Array<number>(24).fill(0));
  h[new Date(at).getHours()]! += 1;
}

/** 오래된 기록을 지운다 (기본 14일) */
function prune(st: SystemWatchState, now: number, keepDays: number): void {
  const cutoff = localDateKey(now - keepDays * DAY);
  const old = (day: string) => day < cutoff;
  for (const day of Object.keys(st.shellDays)) if (old(day)) delete st.shellDays[day];
  for (const day of Object.keys(st.shellHours)) if (old(day)) delete st.shellHours[day];
  for (const day of Object.keys(st.apps)) if (old(day)) delete st.apps[day];
  st.events = st.events.flatMap((e) => {
    for (const day of Object.keys(e.days)) if (old(day)) delete e.days[day];
    return Object.keys(e.days).length ? [e] : [];
  });
  for (const [key, at] of Object.entries(st.suggested)) if (now - at > keepDays * DAY) delete st.suggested[key];
}

/** 끈 출처의 기록은 바로 지운다 */
function forgetDisabled(st: SystemWatchState, sys: SystemObserveConfig): void {
  if (!sys.health) {
    st.events = [];
    st.failed = [];
    st.disks = [];
    delete st.healthAt;
    delete st.healthCursor;
    delete st.problems.health;
  }
  if (!sys.habits || !sys.shellHistory) {
    st.history = {};
    st.shellDays = {};
    st.shellHours = {};
    delete st.historyAt;
    delete st.problems.history;
  }
  if (!sys.habits) st.asked = {};
  if (!sys.apps) {
    st.apps = {};
    delete st.appsAt;
    delete st.problems.apps;
  }
}

function isIgnored(text: string, ignore: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return ignore.some((word) => word && lower.includes(word.toLowerCase()));
}

function lastAppsDay(st: SystemWatchState): string | undefined {
  return Object.keys(st.apps).sort().at(-1);
}

function topApps(day: Record<string, number>, n: number): Array<{ name: string; minutes: number }> {
  return Object.entries(day)
    .map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, n);
}

function total(e: EventSummary): number {
  return Object.values(e.days).reduce((a, b) => a + b, 0);
}

function usedPercent(d: { total: number; free: number }): number {
  return d.total > 0 ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}시간 ${minutes % 60}분` : `${minutes}분`;
}

function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 60) return `${m}분 전`;
  if (m < 24 * 60) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}

function unitLabel(kind: "service" | "user-service" | "task"): string {
  return kind === "task" ? "예약 작업" : kind === "user-service" ? "사용자 서비스" : "서비스";
}

function platformLabel(p: Platform): string {
  return p === "win32" ? "Windows" : p === "darwin" ? "macOS" : p === "linux" ? "Linux" : "지원하지 않는 기기";
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}
