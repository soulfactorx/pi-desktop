import type { ChatItem } from "./chat-state";

/**
 * "Pi가 작업 중…" 줄에 보이는 상태 (ChatView). 얼마나 걸렸는지, 지금 무엇을 하는지,
 * 새 출력이 오래 없으면 그 시간을 보여 "잘 도는지·멈췄는지"를 알 수 있게 한다.
 */
export interface WorkingStatus {
  /** 지금 하는 일 (예: "bash 실행 중", "생각하는 중") */
  doing: string;
  /** 작업을 본 뒤 걸린 시간 */
  elapsed: string;
  /** 새 출력이 없는 시간 (조용함 기준을 넘었을 때만) */
  quiet?: string;
  /** 조용함 기준을 넘었을 때 덧붙이는 안내 */
  hint?: string;
}

/** 이만큼 새 출력이 없으면 "조용함"으로 알린다 */
export const QUIET_MS = 45_000;

/** 1분 23초 · 45초 · 1시간 2분 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 마지막 항목으로 지금 하는 일을 짐작한다 */
export function currentActivity(items: readonly ChatItem[]): { doing: string; tool: boolean } {
  const last = items.at(-1);
  if (last?.kind === "tool" && last.status === "running") return { doing: `${last.toolName} 실행 중`, tool: true };
  if (last?.kind === "assistant" && !last.done) {
    const block = last.blocks.at(-1);
    if (block?.type === "thinking") return { doing: "생각하는 중", tool: false };
    if (block?.type === "text") return { doing: "답을 쓰는 중", tool: false };
    if (block?.type === "toolCall") return { doing: `${block.toolName} 준비 중`, tool: false };
  }
  return { doing: "모델 응답을 기다리는 중", tool: false };
}

export function workingStatus(items: readonly ChatItem[], startedAt: number, lastActivityAt: number, now: number): WorkingStatus {
  const { doing, tool } = currentActivity(items);
  const status: WorkingStatus = { doing, elapsed: formatDuration(now - startedAt) };
  const quiet = now - lastActivityAt;
  if (quiet >= QUIET_MS) {
    status.quiet = formatDuration(quiet);
    status.hint = tool
      ? "명령이 오래 걸리는 중일 수 있어요. 계속 멈춰 있으면 ■ 중단 후 다시 시도하세요."
      : "모델이 오래 생각하거나 응답이 늦어지고 있어요. 계속 멈춰 있으면 ■ 중단 후 다시 보내 보세요.";
  }
  return status;
}
