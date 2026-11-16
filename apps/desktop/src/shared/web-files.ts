/**
 * Pi Web 파일 관리자의 채널과 화면 API (설계 §5.10 "파일 관리자"). 웹에만 있다 (데스크톱 앱은 OS 파일 관리자를 쓴다).
 * 화면은 window.piWeb.files로 쓴다 (web/main.ts가 둔다).
 */
export const FileChannels = {
  list: "pi-web:files-list",
  makeDir: "pi-web:files-mkdir",
  makeFile: "pi-web:files-mkfile",
  rename: "pi-web:files-rename",
  transfer: "pi-web:files-transfer",
  remove: "pi-web:files-remove",
  readText: "pi-web:files-read",
  writeText: "pi-web:files-write",
  upload: "pi-web:files-upload",
  downloadTicket: "pi-web:files-download",
  usageStart: "pi-web:files-usage-start",
  usagePoll: "pi-web:files-usage-poll",
  usageCancel: "pi-web:files-usage-cancel",
} as const;

/** 내려받기 주소 (티켓을 붙인다) */
export const FILE_DOWNLOAD_PATH = "/api/files/download";

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  link: boolean;
  size: number;
  mtime: number;
}

export interface FileListing {
  path: string;
  parent?: string;
  entries: FileEntry[];
}

/** 용량 보기의 한 줄 (지금 폴더 바로 아래의 파일·폴더) */
export interface UsageItem {
  name: string;
  path: string;
  dir: boolean;
  link: boolean;
  /** 디스크에서 차지하는 크기 (바이트). 계산 중이면 지금까지 센 만큼 */
  size: number;
  /** 안의 파일·폴더 수 (자기 포함) */
  count: number;
  /** 다 셌는지 */
  done: boolean;
  mtime: number;
}

/** 큰 파일 모아 보기의 한 줄 */
export interface LargeFile {
  path: string;
  size: number;
  mtime: number;
}

/** 용량 계산 결과 (계산 중에도 지금까지 센 것을 돌려준다) */
export interface UsageSnapshot {
  /** 계산 작업 id. 이미 센 결과를 그대로 돌려줄 때는 "" */
  id: string;
  path: string;
  done: boolean;
  /** 시간이 다 되어 일부만 셌다 */
  partial: boolean;
  /** 센 뒤에 바뀐 곳이 있어 합계가 맞지 않을 수 있다 (다시 계산하면 맞다) */
  stale: boolean;
  total: number;
  count: number;
  /** 읽지 못해 건너뛴 곳 수 (권한 등) */
  skipped: number;
  elapsedMs: number;
  /** 센 시각 (이미 센 결과를 돌려줄 때) */
  at: number;
  /** 큰 것부터 */
  items: UsageItem[];
  /** 이 폴더 아래 큰 파일 (큰 것부터, 30개까지) */
  largest: LargeFile[];
}

/** 다시 받거나 다시 만들 수 있는 폴더 (지워도 되는지 판단을 돕는 표시). 이름 → 설명 */
const REBUILDABLE: Record<string, string> = {
  node_modules: "npm install로 다시 받을 수 있음",
  ".npm": "npm 캐시: 필요하면 다시 받음",
  ".cache": "프로그램 캐시: 필요하면 다시 만듦",
  __pycache__: "파이썬이 다시 만듦",
  ".gradle": "Gradle 캐시: 다시 받을 수 있음",
  ".pnpm-store": "pnpm 캐시: 다시 받을 수 있음",
  ".yarn-cache": "Yarn 캐시: 다시 받을 수 있음",
  ".pytest_cache": "pytest가 다시 만듦",
  ".mypy_cache": "mypy가 다시 만듦",
  ".next": "Next.js 빌드 결과: 다시 만들 수 있음",
  ".turbo": "Turborepo 캐시: 다시 만들 수 있음",
};

/** 다시 받을 수 있는 폴더면 그 설명 */
export function rebuildableHint(name: string, dir: boolean): string | undefined {
  return dir && Object.hasOwn(REBUILDABLE, name) ? REBUILDABLE[name] : undefined;
}

export interface WebFilesApi {
  list(path?: string): Promise<FileListing>;
  makeDir(parent: string, name: string): Promise<string>;
  makeFile(parent: string, name: string): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  transfer(paths: string[], destDir: string, mode: "move" | "copy"): Promise<string[]>;
  remove(paths: string[]): Promise<number>;
  readText(path: string): Promise<{ text: string; mtime: number }>;
  writeText(path: string, text: string, baseMtime?: number): Promise<number>;
  upload(dir: string, file: File): Promise<string>;
  /** 브라우저가 파일을 내려받게 한다 */
  download(path: string): Promise<void>;
  /** 폴더 용량 계산을 시작한다 (이미 센 결과가 있으면 그것을 바로 돌려준다. refresh면 다시 센다) */
  usageStart(path: string, refresh?: boolean): Promise<UsageSnapshot>;
  /** 계산 중인 결과 */
  usagePoll(id: string): Promise<UsageSnapshot>;
  usageCancel(id: string): Promise<void>;
}

/** 휴대폰 알림의 open 값: 이 세션을 연다 (뒤에 JSON {hostId, sessionId}) */
export const OPEN_SESSION_PREFIX = "session:";
/** 알림을 눌러 세션을 열라는 화면 이벤트 (detail: SessionTarget) */
export const OPEN_SESSION_EVENT = "pi-web:open-session";

export interface SessionTarget {
  hostId: string;
  sessionId: string;
}

export function sessionOpenValue(target: SessionTarget): string {
  return `${OPEN_SESSION_PREFIX}${JSON.stringify(target)}`;
}

export function parseSessionOpen(open: string): SessionTarget | undefined {
  if (!open.startsWith(OPEN_SESSION_PREFIX)) return undefined;
  try {
    const value = JSON.parse(open.slice(OPEN_SESSION_PREFIX.length)) as Partial<SessionTarget>;
    return typeof value.hostId === "string" && typeof value.sessionId === "string" ? { hostId: value.hostId, sessionId: value.sessionId } : undefined;
  } catch {
    return undefined;
  }
}

declare global {
  interface Window {
    /** 웹에만 있는 기능 (pi-web). 데스크톱 앱에는 없다 */
    piWeb?: {
      files: WebFilesApi;
      /** 화면이 뜨기 전에 알림을 눌러 받은 세션 (한 번 읽으면 지운다). 그 뒤의 것은 OPEN_SESSION_EVENT로 */
      takeOpenSession(): SessionTarget | undefined;
      /** 웹앱 버전 (서버의 릴리스 태그) */
      version?: string;
      /** 알림을 켜고(묻기) 시험 알림을 보낸다. 결과는 화면 위 안내로 */
      checkNotifications(): Promise<void>;
    };
  }
}
