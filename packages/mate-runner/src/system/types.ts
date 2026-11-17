/**
 * 시스템 관찰의 설정·상태·화면 형식 (설계 DESIGN-MATE.md §10.1). 화면도 쓰므로 Node 코드 없이 타입만 둔다.
 *
 * 개인정보: 날것의 로그·명령·창 제목은 남기지 않는다. 남기는 것은 요약뿐이다
 * (오류 출처·번호·횟수와 가린 한 줄, 명령은 프로그램 이름과 하위 명령만, 프로그램은 이름만).
 */

/** 시스템 관찰 설정. 모두 기본 꺼짐이고 하나씩 켠다 */
export interface SystemObserveConfig {
  /** 시스템 오류 로그, 실패한 서비스·예약 작업, 디스크 */
  health: boolean;
  /** 되풀이하는 작업 찾기 (Pi 요청. 셸 기록은 shellHistory를 따로 켜야 읽는다) */
  habits: boolean;
  /** 셸 기록(bash·zsh·fish·PowerShell)을 읽는다. 인자는 버리고 프로그램 이름과 하위 명령만 센다 */
  shellHistory: boolean;
  /** 켜져 있는 프로그램 이름을 몇 분마다 센다 (창 제목·인자는 보지 않는다) */
  apps: boolean;
  /** 하루 한 번 요약을 모델에게 보내 필요한 작업을 제안받는다. 끄면 이 PC 밖으로 아무것도 나가지 않는다 */
  analyze: boolean;
  /** 기록하지 않을 프로그램·명령 이름 (소문자) */
  ignore: string[];
}

export const DEFAULT_SYSTEM_OBSERVE: SystemObserveConfig = {
  health: false,
  habits: false,
  shellHistory: false,
  apps: false,
  analyze: false,
  ignore: [],
};

/** 오류 로그 요약 한 가지 (같은 출처·번호를 묶는다) */
export interface EventSummary {
  /** 출처#번호 (Windows: 공급자#이벤트 ID, Linux: 프로그램·유닛#우선순위) */
  key: string;
  source: string;
  id: string;
  level: "critical" | "error";
  /** 가린 첫 줄 (경로·사용자 이름·주소·비밀값을 가림) */
  message: string;
  /** 가린 전체 메시지 (여러 줄, 가장 최근 것). Windows 이벤트처럼 첫 줄 뒤에 설명이 있을 때 */
  detail?: string;
  /** 날짜(로컬) → 횟수 */
  days: Record<string, number>;
  firstAt: number;
  lastAt: number;
}

/** 지금 실패해 있는 서비스·예약 작업 */
export interface FailedUnit {
  name: string;
  kind: "service" | "user-service" | "task";
  since: number;
  seenAt: number;
}

export interface DiskSnapshot {
  mount: string;
  total: number;
  free: number;
  at: number;
}

/** 되풀이하는 작업 후보 */
export interface HabitCandidate {
  key: string;
  kind: "shell" | "pi";
  /** 명령 묶음(→로 이음) 또는 Pi 요청 앞부분 */
  label: string;
  /** 최근 며칠 중 며칠에 했는지 */
  days: number;
  span: number;
  /** 주로 하는 시각 (0~23). 고르게 흩어져 있으면 없음 */
  hour?: number;
  /** 평일에만 하는지 */
  weekdays: boolean;
  cwd?: string;
}

/** 실행기 상태에 남기는 시스템 관찰 상태 (runner-state.json) */
export interface SystemWatchState {
  since: number;
  healthAt?: number;
  /** 이 시각 뒤의 로그만 읽는다 */
  healthCursor?: number;
  events: EventSummary[];
  failed: FailedUnit[];
  disks: DiskSnapshot[];
  historyAt?: number;
  /** 셸 기록 파일별로 어디까지 읽었는지 */
  history: Record<string, { offset: number }>;
  /** 날짜 → 그날 실행한 명령 모양 (순서대로, 같은 것이 이어지면 하나로) */
  shellDays: Record<string, string[]>;
  /** 날짜 → 명령 모양 → 시간대별 횟수 (24칸) */
  shellHours: Record<string, Record<string, number[]>>;
  appsAt?: number;
  /** 날짜 → 프로그램 이름 → 켜져 있던 분 */
  apps: Record<string, Record<string, number>>;
  /** 되풀이 작업을 물어본 기록 (같은 것은 다시 묻지 않는다) */
  asked: Record<string, { at: number; questionId?: string; answer?: "yes" | "no" }>;
  /** 이미 알린 열쇠 (시각) */
  suggested: Record<string, number>;
  today: { date: string; count: number };
  /** 마지막 분석 실행 시각 */
  analyzedAt?: number;
  /** 읽지 못한 이유 (권한·명령 없음 등) */
  problems: Partial<Record<"health" | "history" | "apps", string>>;
}

/** 활동 탭의 시스템 관찰 화면 */
export interface SystemView {
  /** 이 기기에서 쓸 수 있는지 (휴대폰 Termux 등은 못 씀) */
  supported: boolean;
  platform: string;
  events: EventSummary[];
  failed: FailedUnit[];
  disks: DiskSnapshot[];
  habits: HabitCandidate[];
  /** 최근 날의 프로그램별 켜져 있던 시간 (분, 큰 것부터) */
  apps: Array<{ name: string; minutes: number }>;
  appsDate?: string;
  /** 셸 기록에서 센 명령 모양 수 */
  shellCommands: number;
  problems: SystemWatchState["problems"];
  today: { date: string; count: number };
  analyzedAt?: number;
  since?: number;
}
