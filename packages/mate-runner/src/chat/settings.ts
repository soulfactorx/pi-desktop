import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatePaths } from "../paths";
import { loadConfig, saveConfig, type ConfigPatch } from "../store";
import { mateTunables } from "../tunables";
import type { MateConfig } from "../types";

/**
 * Mate 대화가 바꿀 수 있는 앱 설정 (설계 DESIGN-MATE.md §13.1).
 * 대화 모델은 mate_do의 set_config로 이름(setting)과 값(value)을 넘긴다. 실행기가 값을 검사해 바꾼다.
 * 개인정보·비용·권한을 넓히는 변경(risky)은 바로 바꾸지 않고 사용자에게 버튼으로 다시 묻는다 (chat-agent.ts의 confirm).
 */

type Value = string | number | boolean;

interface SettingDef {
  label: string;
  /** 값의 모양 (모델에게 보이는 설명) */
  shape: string;
  get(config: MateConfig): string;
  /** 값을 검사해 설정 조각으로. 잘못되면 오류 */
  patch(value: Value, config: MateConfig): ConfigPatch;
  /** 바꾸기 전에 사용자에게 다시 물을 까닭 (없으면 바로 바꿈) */
  risky?(value: Value, config: MateConfig): string | undefined;
}

const bool = (value: Value): boolean => {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "on", "켜기", "켬", "예", "yes", "1"].includes(text)) return true;
  if (["false", "off", "끄기", "끔", "아니요", "no", "0"].includes(text)) return false;
  throw new Error(`켜기(true)·끄기(false)로 알려 주세요: ${String(value)}`);
};

const num = (value: Value, min: number, max: number, integer = true): number => {
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${min}~${max} 사이의 수로 알려 주세요: ${String(value)}`);
  return integer ? Math.round(n) : n;
};

const onOff = (on: boolean) => (on ? "켜짐" : "꺼짐");

/** 개인정보를 더 보는 관찰을 켤 때 */
const turningOn = (what: string) => (value: Value) => (bool(value) ? `${what}을(를) 켜면 Mate가 이 기기의 기록을 더 읽습니다` : undefined);

const system = (key: keyof MateConfig["observe"]["system"], label: string, what: string): SettingDef => ({
  label,
  shape: "true|false",
  get: (c) => onOff(c.observe.system[key] === true),
  patch: (v, c) => ({ observe: { system: { ...c.observe.system, [key]: bool(v) } } }),
  risky: turningOn(what),
});

export const SETTINGS: Record<string, SettingDef> = {
  paused: {
    label: "자동 실행 일시 정지",
    shape: "true|false",
    get: (c) => onOff(c.paused),
    patch: (v) => ({ paused: bool(v) }),
  },
  daily_run_limit: {
    label: "하루 자동 실행 상한(모든 임무 합계)",
    shape: "0~500 정수",
    get: (c) => `${c.dailyRunLimit}회`,
    patch: (v) => ({ dailyRunLimit: num(v, 0, 500) }),
    risky: (v, c) => (num(v, 0, 500) > c.dailyRunLimit ? `하루 자동 실행 상한을 ${c.dailyRunLimit}회에서 ${num(v, 0, 500)}회로 올리면 비용이 늘 수 있습니다` : undefined),
  },
  model: {
    label: "Mate 기본 모델(provider/id, 빈 값이면 Pi 기본 모델)",
    shape: "provider/id 또는 빈 문자열",
    get: (c) => c.model || "(Pi 기본 모델)",
    patch: (v) => {
      const text = String(v).trim();
      if (text && !/^[\w.-]+\/[\w.:-]+$/.test(text)) throw new Error(`모델은 provider/id 모양이어야 합니다: ${text}`);
      return { model: text };
    },
  },
  max_cost: {
    label: "실행당 비용 상한(USD, 0이면 없음)",
    shape: "0~20 수",
    get: (c) => `$${c.maxCostUsd}`,
    patch: (v) => ({ maxCostUsd: num(v, 0, 20, false) }),
    risky: (v, c) => {
      const next = num(v, 0, 20, false);
      return next === 0 || next > c.maxCostUsd ? `실행당 비용 상한을 $${c.maxCostUsd}에서 ${next === 0 ? "없음" : `$${next}`}(으)로 올리면 한 번에 쓰는 비용이 늘 수 있습니다` : undefined;
    },
  },
  desktop_notify: {
    label: "PC 알림(앱 창을 보고 있지 않을 때)",
    shape: "true|false",
    get: (c) => onOff(c.desktopNotify),
    patch: (v) => ({ desktopNotify: bool(v) }),
  },
  observe: {
    label: "활동 관찰(Pi 세션 기록 읽기)",
    shape: "true|false",
    get: (c) => onOff(c.observe.enabled),
    patch: (v) => ({ observe: { enabled: bool(v) } }),
    risky: turningOn("활동 관찰(Pi 세션 기록 읽기)"),
  },
  quiet_minutes: {
    label: "활동 관찰: 이만큼 조용하면 작업 끝으로 봄(분)",
    shape: "1~120 정수",
    get: (c) => `${c.observe.quietMinutes}분`,
    patch: (v) => ({ observe: { quietMinutes: num(v, 1, 120) } }),
  },
  daily_suggestion_limit: {
    label: "관찰 제안 하루 상한",
    shape: "0~50 정수",
    get: (c) => `${c.observe.dailySuggestionLimit}건`,
    patch: (v) => ({ observe: { dailySuggestionLimit: num(v, 0, 50) } }),
  },
  system_health: system("health", "시스템 관찰: 시스템 건강(오류 로그·서비스·디스크)", "시스템 오류 로그 읽기"),
  system_habits: system("habits", "시스템 관찰: 되풀이하는 작업 찾기", "되풀이하는 작업 찾기"),
  system_shell_history: system("shellHistory", "시스템 관찰: 셸 기록 읽기", "셸 기록 읽기"),
  system_apps: system("apps", "시스템 관찰: 켜져 있는 프로그램 세기", "켜져 있는 프로그램 세기"),
  system_analyze: system("analyze", "시스템 관찰: 하루 한 번 요약을 모델로 분석", "시스템 관찰 요약을 모델에게 보내기"),
  phone_notify: {
    label: "휴대폰 알림 범위(action: 할 일·확인 필요만, all: 전부)",
    shape: "action|all",
    get: (c) => c.telegram.notify,
    patch: (v) => {
      const text = String(v).trim();
      if (text !== "action" && text !== "all") throw new Error("action 또는 all로 알려 주세요");
      return { telegram: { notify: text } };
    },
  },
  phone_quiet: {
    label: "휴대폰 조용한 시간(HH:MM-HH:MM, off면 없음)",
    shape: "HH:MM-HH:MM 또는 off",
    get: (c) => (c.telegram.quiet ? `${c.telegram.quiet.start}-${c.telegram.quiet.end}` : "없음"),
    patch: (v) => {
      const text = String(v).trim();
      if (/^(off|없음|끄기)$/i.test(text)) return { telegram: { quiet: undefined } };
      const m = /^([01]\d|2[0-3]):([0-5]\d)\s*[-~]\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
      if (!m) throw new Error("조용한 시간은 22:00-07:00처럼 알려 주세요");
      return { telegram: { quiet: { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` } } };
    },
  },
  phone_send_detail: {
    label: "휴대폰으로 diff·근거 내용까지 보내기",
    shape: "true|false",
    get: (c) => onOff(c.telegram.sendDetail),
    patch: (v) => ({ telegram: { sendDetail: bool(v) } }),
    risky: (v) => (bool(v) ? "휴대폰(텔레그램)으로 코드 변경 내용까지 보내게 됩니다" : undefined),
  },
  phone_allow_fix: {
    label: "휴대폰에서 고치기(/fix·맡기기) 허용",
    shape: "true|false",
    get: (c) => onOff(c.telegram.allowFix),
    patch: (v) => ({ telegram: { allowFix: bool(v) } }),
    risky: (v) => (bool(v) ? "휴대폰에서 파일을 고치는 일을 맡길 수 있게 됩니다" : undefined),
  },
  phone_mirror_app: {
    label: "앱에서 나눈 대화도 휴대폰으로 보내기",
    shape: "true|false",
    get: (c) => onOff(c.telegram.mirrorApp),
    patch: (v) => (bool(v) ? { telegram: { mirrorApp: true, mirrorAppSince: Date.now() } } : { telegram: { mirrorApp: false } }),
    risky: (v) => (bool(v) ? "앱에서 나눈 대화가 휴대폰(텔레그램)으로도 갑니다" : undefined),
  },
};

/** 바꾸기 전에 다시 물을 까닭. 값이 잘못되면 오류 */
export function settingRisk(setting: string, value: Value, config: MateConfig): string | undefined {
  const def = SETTINGS[setting];
  if (!def) throw new Error(`모르는 설정이에요: ${setting}. Mate 기능 안내 파일의 설정 목록을 보세요`);
  def.patch(value, config);
  return def.risky?.(value, config);
}

/** 설정을 바꾸고 사용자에게 보일 한 줄을 돌려준다 */
export async function applySetting(paths: MatePaths, setting: string, value: Value): Promise<string> {
  const def = SETTINGS[setting];
  if (!def) throw new Error(`모르는 설정이에요: ${setting}`);
  const before = await loadConfig(paths);
  const after = await saveConfig(paths, def.patch(value, before));
  return `⚙️ ${def.label}: ${def.get(before)} → ${def.get(after)}`;
}

/** 수치·프롬프트 설정(tunables) 하나를 바꾼다. 프롬프트(글)는 Mate의 행동을 바꾸므로 다시 묻는다 */
export function tunableRisk(id: string): string | undefined {
  const item = mateTunables().items().find((t) => t.id === id);
  if (!item) throw new Error(`모르는 설정 항목이에요: ${id}. Mate 기능 안내 파일의 목록을 보세요`);
  if (item.locked) throw new Error(`바꿀 수 없는 항목이에요: ${item.locked}`);
  return item.kind === "text" ? `"${item.label}" 지시문을 바꾸면 Mate의 일하는 방식이 바뀝니다` : undefined;
}

export function applyTunable(id: string, value: Value | null): string {
  const store = mateTunables();
  const before = store.items().find((t) => t.id === id);
  if (!before) throw new Error(`모르는 설정 항목이에요: ${id}`);
  const reset = value === null || (typeof value === "string" && /^(default|기본값?)$/i.test(value.trim()));
  const after = store.set(id, reset ? null : before.kind === "number" ? Number(value) : String(value));
  const show = (v: number | string) => (typeof v === "string" && v.length > 40 ? `${v.slice(0, 40)}…` : `${v}${before.unit ? before.unit : ""}`);
  return `⚙️ ${before.label}: ${show(before.value)} → ${show(after.value)}${reset ? " (기본값)" : ""}`;
}

/** 대화 안내의 "지금 설정" 섹션: 설정 이름과 지금 값 (set_config에 쓰는 이름 그대로) */
export function settingsSection(config: MateConfig): string[] {
  return [
    "지금 Mate 설정 (mate_do set_config의 setting 이름 = 지금 값). 수치·프롬프트 설정과 자세한 설명은 Mate 기능 안내 파일에 있다:",
    ...Object.entries(SETTINGS).map(([key, def]) => `- ${key} = ${def.get(config)} (${def.label})`),
  ];
}

/** 대화로 바꿀 수 없는 것 (앱 화면에서만) */
export const APP_ONLY = [
  "휴대폰 봇 연결·토큰 넣기 (휴대폰 탭: 토큰은 PC 키체인에 암호화해 둔다)",
  "호스트 바꾸기·SSH 호스트 관리 (머리의 호스트 고르기)",
  "앱 업데이트, PC를 켜면 실행기 자동 시작, 트레이 (Pi Desktop 앱)",
  "스킬·MCP 서버 설치·Pi 패키지 설치 (스킬·MCP 탭)",
  "Pi 설치·로그인 (Pi 관리)",
];

/**
 * Mate 기능 안내 파일 (Mate 홈의 mate-guide.md). 대화 모델이 필요할 때 read로 읽는다.
 * 프롬프트에 다 넣으면 매 차례 길어지므로 파일로 두고, 내용이 바뀌었을 때만 다시 쓴다.
 */
export async function writeGuide(paths: MatePaths): Promise<string> {
  const config = await loadConfig(paths);
  const tunables = mateTunables(paths.home).items();
  const lines = [
    "# Mate 기능 안내 (대화 모델용, 실행기가 만든다)",
    "",
    "## 대화에서 할 수 있는 것 (mate_do)",
    "- run_duty: 임무 지금 실행",
    "- create_duty: 임무 만들기 (name, prompt, schedule, folder, profile, web, timeout(초), run=true면 만든 뒤 바로 실행)",
    "- update_duty: 임무 고치기. 바꿀 것만 넣는다: name, prompt(지시 전체), schedule, folder, profile(observe·propose·act), web,",
    "  timeout(실행 시간 제한, 초, 30~3600), model(provider/id, \"default\"면 Mate 기본), max_cost(실행당 USD, 0이면 Mate 설정 따름), enabled(true·false),",
    "  remove_grants(허용한 명령·도구 빼기), remove_mcp(MCP 서버 빼기), run=true(고친 뒤 바로 실행)",
    "- delete_duty: 임무 지우기 (휴지통으로, 사용자에게 다시 묻는다)",
    "- set_config: 앱 설정 하나 바꾸기 (setting, value). 아래 목록",
    "- set_tunable: 수치·프롬프트 설정 하나 바꾸기 (tunable=id, value. \"default\"면 기본값). 아래 목록",
    "- ask·fix·accept·dismiss·delegate·pause·resume·enable_web: 그대로",
    "",
    "개인정보·비용·권한을 넓히는 변경은 실행기가 사용자에게 버튼으로 다시 묻는다(상한 올리기, 관찰 켜기, 휴대폰으로 내용 보내기·고치기 허용, act 방식, 프롬프트 바꾸기, 임무 지우기).",
    "허용 명령·MCP를 더하는 것은 대화로 하지 않는다: 임무가 막히면 실행 뒤 허용 질문이 뜬다.",
    "",
    "## 앱 설정 (set_config)",
    ...Object.entries(SETTINGS).map(([key, def]) => `- ${key}: ${def.label}. 값: ${def.shape}. 지금: ${def.get(config)}`),
    "",
    "## 수치·프롬프트 설정 (set_tunable)",
    ...tunables.map(
      (t) =>
        `- ${t.id} [${t.group}] ${t.label}: 지금 ${t.kind === "text" ? `(글 ${String(t.value).length}자)` : `${t.value}${t.unit ?? ""}`}` +
        `${t.kind === "number" && t.min !== undefined ? ` (${t.min}~${t.max})` : ""}${t.locked ? " [바꿀 수 없음]" : ""}. ${t.purpose}`,
    ),
    "",
    "## 대화로 못 하는 것 (앱 화면으로 안내)",
    ...APP_ONLY.map((x) => `- ${x}`),
    "",
  ];
  const text = lines.join("\n");
  const file = join(paths.home, "mate-guide.md");
  const old = await readFile(file, "utf8").catch(() => "");
  if (old !== text) await writeFile(file, text, "utf8");
  return file;
}
