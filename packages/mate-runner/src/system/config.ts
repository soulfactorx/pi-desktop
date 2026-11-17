import { DEFAULT_SYSTEM_OBSERVE, type SystemObserveConfig } from "./types";

/** 설정 파일의 시스템 관찰 설정을 검사한다 (모르는 값은 꺼짐) */
export function normalizeSystemObserve(raw: unknown): SystemObserveConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SystemObserveConfig, unknown>>;
  const d = DEFAULT_SYSTEM_OBSERVE;
  const bool = (v: unknown) => v === true;
  return {
    health: bool(o.health ?? d.health),
    habits: bool(o.habits ?? d.habits),
    shellHistory: bool(o.shellHistory ?? d.shellHistory),
    apps: bool(o.apps ?? d.apps),
    analyze: bool(o.analyze ?? d.analyze),
    ignore: Array.isArray(o.ignore) ? [...new Set(o.ignore.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase()))].slice(0, 100) : [],
  };
}
