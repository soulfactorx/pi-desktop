import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/renderer/chat-state";
import { currentActivity, formatDuration, QUIET_MS, workingStatus } from "../../src/renderer/working-status";

const user: ChatItem = { kind: "user", key: "u", text: "고쳐줘" } as ChatItem;
const assistant = (blocks: Array<{ type: string; text?: string; toolName?: string; argsText?: string }>): ChatItem =>
  ({ kind: "assistant", key: "a", blocks, done: false }) as ChatItem;
const tool: ChatItem = { kind: "tool", key: "t", toolCallId: "1", toolName: "bash", args: {}, status: "running", output: "" };

describe("작업 중 표시 (working-status)", () => {
  it("걸린 시간을 초·분·시간으로 쓴다", () => {
    expect(formatDuration(5_400)).toBe("5초");
    expect(formatDuration(83_000)).toBe("1분 23초");
    expect(formatDuration(3_725_000)).toBe("1시간 2분");
  });

  it("마지막 항목으로 지금 하는 일을 짐작한다", () => {
    expect(currentActivity([user]).doing).toBe("모델 응답을 기다리는 중");
    expect(currentActivity([user, assistant([{ type: "thinking", text: "음" }])]).doing).toBe("생각하는 중");
    expect(currentActivity([user, assistant([{ type: "text", text: "네" }])]).doing).toBe("답을 쓰는 중");
    expect(currentActivity([user, assistant([{ type: "toolCall", toolName: "edit", argsText: "" }])]).doing).toBe("edit 준비 중");
    expect(currentActivity([user, tool])).toEqual({ doing: "bash 실행 중", tool: true });
  });

  it("새 출력이 오래 없으면 그 시간과 안내를 더한다 (도구 실행 중이면 명령 안내)", () => {
    const start = 1_000_000;
    expect(workingStatus([user], start, start + 10_000, start + 20_000)).toEqual({ doing: "모델 응답을 기다리는 중", elapsed: "20초" });
    const slow = workingStatus([user], start, start, start + QUIET_MS + 5_000);
    expect(slow.quiet).toBe("50초");
    expect(slow.hint).toMatch(/응답이 늦어지고/);
    expect(workingStatus([user, tool], start, start, start + 120_000).hint).toMatch(/명령이 오래/);
  });
});
