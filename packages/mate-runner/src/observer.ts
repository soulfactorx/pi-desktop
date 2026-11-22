import { appendFile, readFile, writeFile } from "node:fs/promises";
import { appendProposal, makeProposal, readInbox } from "@pi-desktop/mate-kit";
import {
  applySessionLine,
  isObserved,
  observedSessions,
  projectCandidates,
  readNewLines,
  readProject,
  recentSessionFiles,
  sessionCandidates,
} from "./activity";
import type { ActivityRecord, Candidate, ObserverState, SessionAggregate } from "./activity-types";
import type { MatePaths } from "./paths";
import { localDateKey } from "./schedule";
import { loadInboxState } from "./store";
import { liveStep } from "./live";
import { folderAlias } from "./remote/messages";
import type { Duty, MateConfig, RunnerState } from "./types";
import type { Exec } from "./watchers";
import { mateDefault, mateTunables } from "./tunables";

/**
 * 활동 관찰자 (설계 DESIGN-MATE.md §10, M4).
 *
 * 실행기가 확인할 때마다(30초):
 * 1. 사용자의 Pi 세션 파일(Pi Desktop·터미널 pi·Agent)과 Mate 자신의 임무·대화 세션에 새로 붙은 줄을 읽어 세션 요약을 모은다
 *    Mate 자신의 작업은 활동 기록에만 남긴다. "작업을 마치면" 계기·제안·저장소 살피기에 쓰면
 *    Mate가 자기 작업을 보고 다시 일을 만드는 순환이 생기기 때문이다
 * 2. 세션이 조용해지면(기본 5분) "작업이 끝남"으로 본다 → 활동 기록, "작업을 마치면" 계기, 규칙 후보
 * 3. 10분마다 최근 작업한 저장소의 git 상태를 본다 → push 안 함·커밋 안 함 후보
 * 4. 규칙 후보는 바로 인박스에, 분석이 필요한 후보는 사용자가 쉬는 때 관찰자 실행(모델)으로 넘긴다
 * 사용자가 계속 버리는 주제는 덜 알린다 (인박스 처리 기록에서 배운다).
 */
export const OBSERVER_DUTY_ID = "observer";
export const OBSERVER_NAME = "Mate 관찰자";
/** 관찰자 실행이 실패하면 이만큼 쉬었다가 다시 한다 (두 번째 실패부터 세 배씩) */
const RETRY_MS = 10 * 60_000;
/** 이만큼 잇달아 실패하면 자동으로 다시 하지 않고 "다시 살펴보기"를 기다린다 (키가 만료되었으면 계속 실패하므로) */
export const OBSERVER_MAX_ATTEMPTS = 3;

// 저장소 확인 간격·기억해 둘 세션 수·활동 기록 줄 수는 설정으로 꺼냈다 (tunables.ts의 observer.*)

export function emptyObserverState(now: number): ObserverState {
  return { files: {}, projects: {}, today: { date: "", count: 0 }, suggested: {}, queue: [], recent: [], since: now };
}

/** 주제별 사용자 반응: 버림만 세 번 이상이고 받아들인 적이 없으면 그 주제는 쉰다 */
export async function topicFeedback(paths: MatePaths): Promise<Record<string, { shown: number; accepted: number; dismissed: number }>> {
  const [items, state] = await Promise.all([readInbox(paths.inbox), loadInboxState(paths)]);
  const out: Record<string, { shown: number; accepted: number; dismissed: number }> = {};
  for (const item of items) {
    if (!item.topic) continue;
    const f = (out[item.topic] ??= { shown: 0, accepted: 0, dismissed: 0 });
    f.shown += 1;
    const status = state[item.id]?.status;
    if (status === "dismissed") f.dismissed += 1;
    else if (status === "accepted" || status === "applied") f.accepted += 1;
  }
  return out;
}

export function isTopicMuted(f: { accepted: number; dismissed: number } | undefined): boolean {
  return !!f && f.dismissed >= 3 && f.accepted === 0;
}

export interface ObserveResult {
  /** 이번에 끝난 세션 ("작업을 마치면" 계기에 쓴다) */
  ended: SessionAggregate[];
}

export class Observer {
  /** 세션 파일별 bash 호출 id → 명령 (실패 결과와 짝짓기용, 메모리에만) */
  private toolCalls = new Map<string, Map<string, string>>();

  constructor(
    private readonly paths: MatePaths,
    private readonly exec: Exec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async tick(state: RunnerState, config: MateConfig, now: number): Promise<ObserveResult> {
    if (!config.observe.enabled) {
      // 끄면 기준을 버려, 다시 켰을 때 지난 기록으로 알림이 쏟아지지 않게 한다
      if (state.observer) delete state.observer;
      return { ended: [] };
    }
    const obs = (state.observer ??= emptyObserverState(now));
    const today = localDateKey(now);
    if (obs.today.date !== today) obs.today = { date: today, count: 0 };

    const scan = { files: 0, lines: 0 };
    const finished = await this.scanSessions(obs, config, now, scan);
    const candidates: Candidate[] = [];
    const ended: SessionAggregate[] = [];
    for (const session of finished) {
      if (session.app === "mate") {
        // Mate 자신의 작업: 기록만 (관찰자 실행 자체는 기록하지 않는다)
        if (!isObserverRun(session)) await this.record({ at: now, kind: "session-ended", session });
        continue;
      }
      ended.push(session);
      candidates.push(...sessionCandidates(session, obs.recent, now));
      obs.recent = [...obs.recent, session].slice(-mateTunables().num("observer.recentSessions"));
      await this.record({ at: now, kind: "session-ended", session });
    }
    const userEnded = finished.filter((s) => s.app !== "mate");
    liveStep(
      state,
      "sessions",
      now,
      `세션 파일 ${scan.files}개 확인 · 새 줄 ${scan.lines}개${userEnded.length ? ` · 끝난 작업 ${userEnded.length}개 (${userEnded.map((s) => folderAlias(s.cwd)).join(", ")})` : ""}`,
      { next: now + 30_000 },
    );
    const projectEvery = mateTunables().num("observer.projectIntervalMinutes") * 60_000;
    if (!obs.projectsAt || now - obs.projectsAt >= projectEvery) {
      obs.projectsAt = now;
      const found = await this.scanProjects(obs, config, now);
      candidates.push(...found);
      const names = Object.values(obs.projects).map((p) => `${folderAlias(p.cwd)}${p.ahead ? ` push 안 함 ${p.ahead}` : ""}${p.dirty ? ` 변경 ${p.dirty}` : ""}`);
      liveStep(state, "projects", now, `저장소 ${names.length}개 확인${names.length ? `: ${names.slice(0, 5).join(" · ")}` : ""}${found.length ? ` · 알릴 거리 ${found.length}개` : ""}`, { next: now + projectEvery });
    }
    await this.handle(obs, config, candidates, now);
    return { ended };
  }

  /** 사용자가 쉬는 중이면(진행 중인 세션이 없음) 관찰자에게 넘길 후보 하나를 꺼낸다 */
  nextJob(state: RunnerState, config: MateConfig, now: number): Candidate | undefined {
    const obs = state.observer;
    if (!config.observe.enabled || !obs || obs.queue.length === 0) return undefined;
    if (obs.today.count >= config.observe.dailySuggestionLimit) return undefined;
    // 방금 실패했으면 (API 키 만료 등) 잠시 쉰다
    if (obs.retryAt && now < obs.retryAt) return undefined;
    const quiet = config.observe.quietMinutes * 60_000;
    // Mate 자신이 일하는 중인 것은 사용자가 바쁜 것이 아니다
    const busy = Object.values(obs.files).some(
      (f) => f.aggregate && f.aggregate.app !== "mate" && f.aggregate.prompts > 0 && now - f.aggregate.lastAt < quiet,
    );
    if (busy) return undefined;
    const job = obs.queue.shift()!;
    obs.today.count += 1;
    obs.suggested[job.key] = now;
    return job;
  }

  /**
   * 관찰자 실행이 끝난 뒤. 실패하면 (API 키 만료·로그인 끊김 등) 그 후보를 버리지 않고 실패 목록에 남겨
   * 잠시 뒤 다시 하고, 세 번 실패하면 "다시 살펴보기"를 기다린다. 오늘 제안 수에서도 뺀다 (제안을 남기지 못했으므로)
   */
  afterRun(state: RunnerState, job: Candidate, status: string, now: number): void {
    const obs = state.observer;
    if (!obs) return;
    const prev = obs.failed?.find((f) => f.job.key === job.key);
    const others = (obs.failed ?? []).filter((f) => f.job.key !== job.key);
    if (status === "done") {
      if (others.length) obs.failed = others;
      else {
        delete obs.failed;
        delete obs.retryAt;
      }
      return;
    }
    const attempts = (prev?.attempts ?? 0) + 1;
    delete obs.suggested[job.key];
    obs.today.count = Math.max(0, obs.today.count - 1);
    obs.failed = [...others, { job, attempts, at: now, status }].slice(-10);
    if (attempts < OBSERVER_MAX_ATTEMPTS) obs.queue = [job, ...obs.queue.filter((q) => q.key !== job.key)];
    obs.retryAt = now + RETRY_MS * 3 ** (attempts - 1);
  }

  /** "다시 살펴보기": 실패한 후보를 모두 대기열 앞에 다시 넣고 바로 할 수 있게 한다 (키를 고친 뒤). 다시 넣은 수 */
  retryFailed(state: RunnerState): number {
    const obs = state.observer;
    if (!obs?.failed?.length) return 0;
    const jobs = obs.failed.map((f) => f.job);
    const keys = new Set(jobs.map((j) => j.key));
    obs.queue = [...jobs, ...obs.queue.filter((q) => !keys.has(q.key))];
    // 횟수를 새로 센다: 또 실패하면 다시 세 번까지 자동으로 한다
    obs.failed = obs.failed.map((f) => ({ ...f, attempts: 0 }));
    delete obs.retryAt;
    return jobs.length;
  }

  private async scanSessions(obs: ObserverState, config: MateConfig, now: number, scan = { files: 0, lines: 0 }): Promise<SessionAggregate[]> {
    const quiet = config.observe.quietMinutes * 60_000;
    const sources = observedSessions(this.env, [this.paths.sessions, this.paths.chatSessions]);
    const since = now - 2 * 24 * 3_600_000;
    const files = (
      await Promise.all(sources.sources.map(async ({ dir, app }) => (await recentSessionFiles(dir, since)).map((file) => ({ ...file, app }))))
    ).flat();
    const excluded = [...config.observe.excluded, ...sources.internal];
    scan.files = files.length;
    const ended: SessionAggregate[] = [];
    for (const file of files) {
      let entry = obs.files[file.path];
      if (!entry) {
        // 관찰을 켜기 전에 이미 조용해진 세션은 읽지 않고 끝에서부터 본다
        entry = obs.files[file.path] = { offset: file.mtime < obs.since - quiet ? file.size : 0 };
      }
      if (file.size > entry.offset) {
        const calls = this.toolCalls.get(file.path) ?? new Map<string, string>();
        this.toolCalls.set(file.path, calls);
        const { lines, offset } = await readNewLines(file.path, entry.offset, file.size);
        scan.lines += lines.length;
        let aggregate = entry.aggregate;
        for (const line of lines) aggregate = applySessionLine(aggregate, line, calls);
        if (aggregate) aggregate.app = file.app;
        entry.offset = offset;
        if (aggregate) entry.aggregate = aggregate;
      } else if (file.size < entry.offset) {
        entry.offset = 0; // 파일이 새로 쓰였다
      }
      const agg = entry.aggregate;
      if (!agg || agg.prompts === 0 || now - Math.max(agg.lastAt, file.mtime) < quiet) continue;
      if (entry.endedAt && entry.endedAt >= agg.lastAt) continue;
      entry.endedAt = now;
      // Mate 자신의 세션은 Mate 홈 안에서 열기도 하므로(대화) 앱 홈 제외는 하지 않는다
      if (isObserved(agg.cwd, agg.app === "mate" ? config.observe.excluded : excluded)) ended.push(agg);
      // 같은 세션을 이어 쓰면 다음 작업은 새로 센다
      entry.aggregate = { ...agg, startedAt: agg.lastAt, prompts: 0, firstPrompt: undefined, editedFiles: [], commands: 0, ranTests: false, failures: [], modelErrors: [] };
      for (const key of ["firstPrompt", "promptLog", "tools", "commandLog", "turns", "tokens", "costUsd"] as const) delete entry.aggregate[key];
    }
    // 이틀 넘게 안 바뀐 파일은 잊는다
    const live = new Set(files.map((f) => f.path));
    for (const path of Object.keys(obs.files)) if (!live.has(path)) delete obs.files[path];
    return ended;
  }

  private async scanProjects(obs: ObserverState, config: MateConfig, now: number): Promise<Candidate[]> {
    const week = now - 7 * 24 * 3_600_000;
    const cwds = [...new Set(obs.recent.filter((s) => s.lastAt >= week).map((s) => s.cwd))]
      .filter((cwd) => isObserved(cwd, config.observe.excluded))
      .slice(-10);
    const out: Candidate[] = [];
    for (const cwd of cwds) {
      const snapshot = await readProject(this.exec, cwd, obs.projects[cwd], now).catch(() => undefined);
      if (!snapshot) continue;
      obs.projects[cwd] = snapshot;
      out.push(...projectCandidates(snapshot, now));
    }
    for (const cwd of Object.keys(obs.projects)) if (!cwds.includes(cwd)) delete obs.projects[cwd];
    return out;
  }

  /** 후보를 걸러 규칙 후보는 바로 인박스에, 분석 후보는 관찰자 대기열에 */
  private async handle(obs: ObserverState, config: MateConfig, candidates: Candidate[], now: number): Promise<void> {
    if (candidates.length === 0) return;
    const feedback = await topicFeedback(this.paths);
    for (const c of candidates) {
      if (obs.suggested[c.key] || obs.queue.some((q) => q.key === c.key)) continue;
      if (isTopicMuted(feedback[c.topic])) continue;
      if (c.via === "observer") {
        obs.queue.push(c);
        continue;
      }
      if (obs.today.count >= config.observe.dailySuggestionLimit) continue;
      const item = makeProposal(
        { title: c.title, summary: c.detail, severity: c.topic === "session-error" ? "warn" : "info", topic: c.topic },
        { dutyId: OBSERVER_DUTY_ID, runId: `rule-${now}` },
        now,
      );
      obs.suggested[c.key] = now;
      if (await appendProposal(this.paths.inbox, item)) {
        obs.today.count += 1;
        await this.record({ at: now, kind: "suggested", topic: c.topic, key: c.key, cwd: c.cwd, title: c.title, via: "rule" });
      }
    }
    // 대기열은 최근 것 위주로 짧게
    obs.queue = obs.queue.slice(-10);
  }

  async record(record: ActivityRecord): Promise<void> {
    await recordActivity(this.paths, record);
  }
}

/** 활동 기록에 한 줄을 더한다 (오래된 것은 activity.jsonl 줄 수 설정만큼만 남긴다) */
export async function recordActivity(paths: MatePaths, record: ActivityRecord): Promise<void> {
  await appendFile(paths.activity, `${JSON.stringify(record)}\n`, "utf8").catch(() => undefined);
  await pruneActivity(paths);
}

/** 관찰자 실행을 알아보는 표시라 바꿀 수 없다 (observer.head, 읽기 전용) */
const OBSERVER_PROMPT_HEAD = mateDefault<string>("observer.head");

/** 관찰자 실행의 세션인지 (첫 요청이 관찰자 지시로 시작한다) */
function isObserverRun(session: SessionAggregate): boolean {
  return session.firstPrompt?.startsWith(OBSERVER_PROMPT_HEAD) ?? false;
}

/** 관찰자 실행의 지시 (후보 하나를 살펴보고 0~1개 제안) */
export function observerPrompt(job: Candidate): string {
  return [
    `${OBSERVER_PROMPT_HEAD} ${mateTunables().text("observer.instruction")}`,
    "",
    `관찰: ${job.title}`,
    job.detail,
    job.followUp ? `\n참고할 고치기 지시 예: ${job.followUp}` : "",
  ].join("\n");
}

/** 관찰자 실행에 쓰는 임시 임무 (저장하지 않음) */
export function observerDuty(job: Candidate, now: number): Duty {
  return {
    id: OBSERVER_DUTY_ID,
    name: OBSERVER_NAME,
    enabled: true,
    cwd: job.cwd,
    prompt: observerPrompt(job),
    profile: "propose",
    trigger: { kind: "manual" },
    timeoutSec: 180,
    createdAt: now,
  };
}

async function pruneActivity(paths: MatePaths): Promise<void> {
  try {
    const text = await readFile(paths.activity, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const keep = mateTunables().num("observer.activityKeep");
    if (lines.length > keep * 1.5) await writeFile(paths.activity, `${lines.slice(-keep).join("\n")}\n`, "utf8");
  } catch {
    // 없으면 지울 것도 없다
  }
}

export async function readActivity(paths: MatePaths, limit = 200): Promise<ActivityRecord[]> {
  try {
    const lines = (await readFile(paths.activity, "utf8")).split("\n").filter(Boolean).slice(-limit);
    return lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as ActivityRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
