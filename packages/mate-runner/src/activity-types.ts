/**
 * 활동 관찰의 기록 형식 (설계 DESIGN-MATE.md §10). 화면도 쓰므로 Node 코드 없이 타입만 둔다.
 *
 * 저장하는 것은 요약뿐이다: 요청·명령은 앞부분만, 비밀값처럼 보이는 것은 가린다. 파일 내용·모델 답변은 저장하지 않는다.
 */

/** 세션을 쓴 앱: pi = Pi Desktop·터미널 pi, agent = Agent, mate = Mate 자신(임무·대화) */
export type SessionApp = "pi" | "agent" | "mate";

export const SESSION_APP_LABELS: Record<SessionApp, string> = { pi: "Pi Desktop", agent: "Agent", mate: "Mate" };

/** 세션 하나를 읽으며 모으는 요약 */
export interface SessionAggregate {
  sessionId: string;
  /** 어느 앱의 세션인지 (이 값이 생기기 전 기록에는 없다) */
  app?: SessionApp;
  cwd: string;
  startedAt: number;
  lastAt: number;
  prompts: number;
  /** 첫 요청 (앞부분, 가림 처리) */
  firstPrompt?: string;
  /** write·edit로 고친 파일 (최대 30개) */
  editedFiles: string[];
  /** bash 명령 수와, 테스트로 보이는 명령을 돌렸는지 */
  commands: number;
  ranTests: boolean;
  /** 실패한 명령 (앞부분, 최대 10개) */
  failures: string[];
  /** 모델 오류 (예: Connection error) */
  modelErrors: string[];
  // ── 자세한 기록 (이 값들이 생기기 전 기록에는 없다) ──
  /** 사용자 요청들 (앞부분, 가림 처리, 최대 activity.maxPrompts개). 모델 답변은 남기지 않는다 */
  promptLog?: Array<{ at: number; text: string }>;
  /** 쓴 도구별 횟수 (read·edit·bash …) */
  tools?: Record<string, number>;
  /** 실행한 명령 (앞부분, 가림 처리, 최대 activity.maxCommands개) */
  commandLog?: string[];
  /** 마지막으로 쓴 모델 (provider/model) */
  model?: string;
  /** 모델 응답 수와 토큰·비용 합계 */
  turns?: number;
  tokens?: number;
  costUsd?: number;
}

/** activity.jsonl 한 줄 */
export type ActivityRecord =
  | { at: number; kind: "session-ended"; session: SessionAggregate }
  | { at: number; kind: "project"; project: ProjectSnapshot }
  | { at: number; kind: "suggested"; topic: string; key: string; cwd: string; title: string; via: "rule" | "observer" }
  /** 시스템 관찰에서 생긴 일 (새 오류·실패, 하루 요약, 되풀이 작업 질문·답) */
  | { at: number; kind: "system"; what: SystemEventKind; title: string; details?: string[] }
  /** 관찰자 실행 (모델이 후보·요약을 살펴봄)이 끝남 */
  | { at: number; kind: "observer-run"; runId: string; cause: string; topic?: string; status: string; proposals: number; durationMs: number; costUsd?: number };

export type SystemEventKind = "health" | "shell-day" | "apps-day" | "habit-asked" | "habit-answer";

export const SYSTEM_EVENT_LABELS: Record<SystemEventKind, string> = {
  health: "시스템 건강",
  "shell-day": "셸 명령 하루 요약",
  "apps-day": "프로그램 하루 요약",
  "habit-asked": "되풀이 작업 질문",
  "habit-answer": "되풀이 작업 답",
};

/** 관찰 출처 (실시간 현황의 줄) */
export type LiveSource = "sessions" | "projects" | "health" | "history" | "apps" | "analysis";

export const LIVE_SOURCE_LABELS: Record<LiveSource, string> = {
  sessions: "Pi 세션 읽기",
  projects: "저장소 상태",
  health: "시스템 건강",
  history: "셸 기록",
  apps: "켜져 있는 프로그램",
  analysis: "모델 분석",
};

/** 출처 하나의 마지막 확인 */
export interface LiveStep {
  at: number;
  ok: boolean;
  /** 무엇을 했는지 한 줄 (예: "새 세션 줄 12개 읽음, 끝난 작업 1개") */
  note: string;
  /** 다음 확인 예정 시각 */
  next?: number;
}

/** 실행기 상태에 남기는 관찰 현황 (활동 탭의 "지금 관찰 중") */
export interface ObserveLive {
  /** 실행기가 마지막으로 관찰을 확인한 시각 (30초마다) */
  tickAt: number;
  /** 지금 하는 일 (오래 걸리는 확인 중에만) */
  doing?: { what: string; since: number };
  steps: Partial<Record<LiveSource, LiveStep>>;
}

/** 화면의 "지금 관찰 중" */
export interface LiveView extends ObserveLive {
  /** 진행 중인 Pi 세션 (아직 "작업 끝"이 아님) */
  active: Array<{ app?: SessionApp; cwd: string; prompts: number; firstPrompt?: string; lastAt: number; endsAt: number; tools: number }>;
  /** 관찰자가 살펴볼 차례를 기다리는 후보 */
  queue: Array<{ topic: string; title: string; cwd: string }>;
  /** 지금 도는 관찰자 실행 */
  running?: { cause: string; since: number; runId: string };
}

/** 저장소 상태 (최근 작업한 폴더만 주기적으로) */
export interface ProjectSnapshot {
  cwd: string;
  branch: string;
  /** upstream보다 앞선 커밋 수 (upstream이 없으면 undefined) */
  ahead?: number;
  /** 커밋하지 않은 파일 수 */
  dirty: number;
  /** 처음 본 시각: 앞선 커밋·커밋 안 한 변경이 언제부터 있었는지 */
  aheadSince?: number;
  dirtySince?: number;
  checkedAt: number;
}

/** 제안 후보의 주제. 사용자가 버린 주제는 덜 알린다 */
export type InsightTopic =
  | "untested-edit"
  | "repeated-failure"
  | "unpushed"
  | "uncommitted"
  | "session-error"
  /** 시스템 관찰 (§10.1) */
  | "system-health"
  | "system-habit"
  | "system-digest";

export interface Candidate {
  topic: InsightTopic;
  /** 같은 일을 두 번 알리지 않기 위한 열쇠 */
  key: string;
  cwd: string;
  title: string;
  /** 모델 없이 바로 알릴 때의 내용, 또는 관찰자에게 줄 근거 */
  detail: string;
  /** rule: 규칙만으로 바로 알림, observer: 모델이 살펴보고 제안 */
  via: "rule" | "observer";
  /** 관찰자가 맡길 수 있는 일의 지시 (사용자가 "Mate에게 맡기기"를 누르면 고치기로 실행) */
  followUp?: string;
}

/** 실행기 상태에 남기는 관찰 상태 */
export interface ObserverState {
  /** 세션 파일별로 어디까지 읽었는지 */
  files: Record<string, { offset: number; aggregate?: SessionAggregate; endedAt?: number }>;
  projects: Record<string, ProjectSnapshot>;
  /** 오늘 관찰 제안 수 */
  today: { date: string; count: number };
  /** 이미 알린 열쇠 (시각) */
  suggested: Record<string, number>;
  /** 관찰자에게 넘길 후보 (사용자가 쉬는 때를 기다림) */
  queue: Candidate[];
  /** 최근 끝난 세션 요약 (같은 실패 반복을 세션을 넘어 세기 위해, 최대 50개) */
  recent: SessionAggregate[];
  /** 관찰을 켠 시각. 그 전에 조용해진 세션은 읽지 않는다 (켜자마자 지난 기록으로 알림이 쏟아지지 않게) */
  since: number;
  /** 저장소 상태를 마지막으로 읽은 시각 */
  projectsAt?: number;
  /**
   * 관찰자 실행이 실패한 후보 (API 키 만료·로그인 끊김 등). 잠시 뒤 다시 하고,
   * 세 번 실패하면 사용자가 "다시 살펴보기"를 누를 때까지 기다린다
   */
  failed?: ObserverFailure[];
  /** 실패 뒤 이 시각까지 관찰자 실행을 쉰다 (같은 이유로 곧바로 또 실패하지 않게) */
  retryAt?: number;
}

export interface ObserverFailure {
  job: Candidate;
  attempts: number;
  at: number;
  /** 실행 결과 (failed·timeout·budget) */
  status: string;
}

export const TOPIC_LABELS: Record<InsightTopic, string> = {
  "untested-edit": "고치고 테스트 안 함",
  "repeated-failure": "같은 실패 반복",
  unpushed: "push 안 한 커밋",
  uncommitted: "오래 커밋 안 한 변경",
  "session-error": "오류로 끝난 세션",
  "system-health": "시스템 오류·디스크",
  "system-habit": "되풀이하는 작업",
  "system-digest": "시스템 관찰 분석",
};
