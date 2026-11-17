import type { HabitCandidate, SystemWatchState } from "./types";
import { promptShape } from "./privacy";

/**
 * 되풀이하는 작업 찾기 (설계 DESIGN-MATE.md §10.1). 모델 없이 센다.
 * - 셸: 날마다의 명령 모양 순서에서 2~4개짜리 묶음이 며칠에 나왔는지, 한 명령이 같은 시간대에 날마다 나오는지
 * - Pi: 비슷한 요청(앞부분)을 며칠에 했는지
 */

const DAY = 24 * 3_600_000;

function dayOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

function isWeekday(key: string): boolean {
  const w = dayOf(key).getDay();
  return w >= 1 && w <= 5;
}

/** 시간대별 횟수에서 2시간 창이 절반 이상을 차지하면 그 시각 */
export function peakHour(hours: number[]): number | undefined {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 3) return undefined;
  let best = -1;
  let bestCount = 0;
  for (let h = 0; h < 24; h++) {
    const count = (hours[h] ?? 0) + (hours[(h + 1) % 24] ?? 0);
    if (count > bestCount) {
      bestCount = count;
      best = (hours[h] ?? 0) >= (hours[(h + 1) % 24] ?? 0) ? h : (h + 1) % 24;
    }
  }
  return bestCount / total >= 0.5 ? best : undefined;
}

/** 최근 span일의 날짜 열쇠 (오늘 포함) */
function recentDays(now: number, span: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < span; i++) {
    const d = new Date(now - i * DAY);
    out.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

export function shellHabits(st: Pick<SystemWatchState, "shellDays" | "shellHours">, now: number, minDays: number, span: number): HabitCandidate[] {
  const days = recentDays(now, span);
  const seqDays = new Map<string, Set<string>>();
  for (const [day, seq] of Object.entries(st.shellDays)) {
    if (!days.has(day)) continue;
    const seen = new Set<string>();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= seq.length; i++) {
        const gram = seq.slice(i, i + n);
        if (new Set(gram).size !== n) continue;
        const label = gram.join(" → ");
        if (seen.has(label)) continue;
        seen.add(label);
        (seqDays.get(label) ?? seqDays.set(label, new Set()).get(label)!).add(day);
      }
    }
  }
  const hoursOf = (shape: string, inDays: Iterable<string>) => {
    const out = new Array<number>(24).fill(0);
    for (const day of inDays) {
      const h = st.shellHours[day]?.[shape];
      if (h) for (let i = 0; i < 24; i++) out[i]! += h[i] ?? 0;
    }
    return out;
  };
  const picked: HabitCandidate[] = [];
  const ranked = [...seqDays.entries()]
    .filter(([, d]) => d.size >= minDays)
    .sort((a, b) => b[0].split(" → ").length - a[0].split(" → ").length || b[1].size - a[1].size);
  for (const [label, d] of ranked) {
    // 고른 묶음의 일부이거나 고른 묶음을 품으면 같은 습관이다
    if (picked.some((p) => p.label.includes(label) || label.includes(p.label))) continue;
    const first = label.split(" → ")[0]!;
    const hour = peakHour(hoursOf(first, d));
    picked.push({ key: `shell:${label}`, kind: "shell", label, days: d.size, span, ...(hour !== undefined ? { hour } : {}), weekdays: [...d].every(isWeekday) });
    if (picked.length >= 5) break;
  }
  // 한 명령을 날마다 같은 시간대에 (묶음보다 하루 이상 더 자주)
  const single = new Map<string, Set<string>>();
  for (const [day, seq] of Object.entries(st.shellDays)) {
    if (!days.has(day)) continue;
    for (const shape of new Set(seq)) (single.get(shape) ?? single.set(shape, new Set()).get(shape)!).add(day);
  }
  for (const [shape, d] of [...single.entries()].sort((a, b) => b[1].size - a[1].size)) {
    if (picked.length >= 5) break;
    if (d.size < minDays + 2 || picked.some((p) => p.label.split(" → ").includes(shape))) continue;
    const hour = peakHour(hoursOf(shape, d));
    if (hour === undefined) continue;
    picked.push({ key: `shell:${shape}`, kind: "shell", label: shape, days: d.size, span, hour, weekdays: [...d].every(isWeekday) });
  }
  return picked;
}

/** Pi 세션 요약에서 비슷한 요청을 되풀이한 것 */
export function piHabits(
  sessions: Array<{ at: number; cwd: string; firstPrompt?: string }>,
  now: number,
  minDays: number,
  span: number,
): HabitCandidate[] {
  const days = recentDays(now, span);
  const groups = new Map<string, { days: Set<string>; hours: number[]; cwds: Map<string, number>; label: string }>();
  for (const s of sessions) {
    if (!s.firstPrompt) continue;
    const d = new Date(s.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!days.has(day)) continue;
    const shape = promptShape(s.firstPrompt);
    if (!shape) continue;
    const g = groups.get(shape) ?? { days: new Set(), hours: new Array<number>(24).fill(0), cwds: new Map(), label: s.firstPrompt };
    g.days.add(day);
    g.hours[d.getHours()]! += 1;
    g.cwds.set(s.cwd, (g.cwds.get(s.cwd) ?? 0) + 1);
    g.label = s.firstPrompt;
    groups.set(shape, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.days.size >= minDays)
    .sort((a, b) => b[1].days.size - a[1].days.size)
    .slice(0, 3)
    .map(([shape, g]) => {
      const hour = peakHour(g.hours);
      const cwd = [...g.cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        key: `pi:${shape}`,
        kind: "pi" as const,
        label: g.label.length > 80 ? `${g.label.slice(0, 80)}…` : g.label,
        days: g.days.size,
        span,
        ...(hour !== undefined ? { hour } : {}),
        weekdays: [...g.days].every(isWeekday),
        ...(cwd ? { cwd } : {}),
      };
    });
}

/** "평일 오전 9시쯤" 같은 때 */
export function whenPhrase(h: Pick<HabitCandidate, "hour" | "weekdays">): string {
  const day = h.weekdays ? "평일" : "거의 매일";
  if (h.hour === undefined) return day;
  if (h.hour === 0) return `${day} 밤 12시쯤`;
  if (h.hour === 12) return `${day} 낮 12시쯤`;
  return `${day} ${h.hour < 12 ? "오전" : "오후"} ${h.hour % 12}시쯤`;
}
