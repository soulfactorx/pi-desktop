import { describe, expect, it } from "vitest";
import { applyEvent, initialChatState } from "../../src/renderer/chat-state";

describe("확장 오류", () => {
  it("Pi의 extension_error를 오류 안내로 보인다 (경로는 끝 두 부분만)", () => {
    const state = applyEvent(initialChatState, 1, { type: "extension_error", extensionPath: "/home/me/.pi/agent/extensions/peers/index.ts", event: "session_start", error: "boom" });
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "확장 오류: peers/index.ts (session_start)", detail: "boom" });
  });
});
