import type { LiveSource, LiveView, ObserveLive } from "./activity-types";
import type { MateConfig, RunnerState } from "./types";

/**
 * 관찰 현황 (설계 DESIGN-MATE.md §10.2). 실행기가 관찰할 때마다 출처별로 무엇을 했는지 한 줄을 남긴다.
 * 상태 파일에 두므로 앱은 실행기 상태를 읽을 때 함께 받는다 (따로 기록 파일을 만들지 않는다).
 */

export function liveOf(state: RunnerState, now: number): ObserveLive {
  return (state.live ??= { tickAt: now, steps: {} });
}

/** 출처 하나의 결과를 적는다 */
export function liveStep(state: RunnerState, source: LiveSource, now: number, note: string, options: { ok?: boolean; next?: number } = {}): void {
  const live = liveOf(state, now);
  live.steps[source] = { at: now, ok: options.ok ?? true, note, ...(options.next !== undefined ? { next: options.next } : {}) };
}

/** 오래 걸리는 확인을 시작·끝낸다 (화면에 "확인 중"으로 보인다) */
export function liveDoing(state: RunnerState, now: number, what: string | undefined): void {
  const live = liveOf(state, now);
  if (what) live.doing = { what, since: now };
  else delete live.doing;
}

/** 꺼진 출처의 줄은 지운다 (끈 것이 "확인함"으로 남아 보이지 않게) */
export function liveForget(state: RunnerState, config: MateConfig): void {
  const live = state.live;
  if (!live) return;
  const sys = config.observe.system;
  const on: Record<LiveSource, boolean> = {
    sessions: config.observe.enabled,
    projects: config.observe.enabled,
    health: sys.health,
    history: sys.habits && sys.shellHistory,
    apps: sys.apps,
    analysis: sys.analyze,
  };
  for (const key of Object.keys(live.steps) as LiveSource[]) if (!on[key]) delete live.steps[key];
}

/** 화면에 보일 관찰 현황: 상태에 남긴 줄 + 진행 중인 세션·대기 후보·도는 관찰자 실행 */
export function liveView(state: RunnerState, config: MateConfig, now: number): LiveView {
  const live = state.live ?? { tickAt: 0, steps: {} };
  const quiet = config.observe.quietMinutes * 60_000;
  const obs = state.observer;
  const active = obs
    ? Object.values(obs.files).flatMap((f) => {
        const a = f.aggregate;
        if (!a || a.app === "mate" || a.prompts === 0 || (f.endedAt !== undefined && f.endedAt >= a.lastAt)) return [];
        return [
          {
            ...(a.app ? { app: a.app } : {}),
            cwd: a.cwd,
            prompts: a.prompts,
            ...(a.firstPrompt ? { firstPrompt: a.firstPrompt } : {}),
            lastAt: a.lastAt,
            endsAt: a.lastAt + quiet,
            tools: Object.values(a.tools ?? {}).reduce((n, c) => n + c, 0),
          },
        ];
      })
    : [];
  const running = state.current && state.current.dutyId === "observer" ? { cause: state.current.cause ?? "관찰", since: state.current.startedAt, runId: state.current.runId } : undefined;
  return {
    tickAt: live.tickAt,
    ...(live.doing ? { doing: live.doing } : {}),
    steps: live.steps,
    active: active.sort((a, b) => b.lastAt - a.lastAt).slice(0, 10),
    queue: (obs?.queue ?? []).map((c) => ({ topic: c.topic, title: c.title, cwd: c.cwd })),
    ...(running ? { running } : {}),
  };
}
