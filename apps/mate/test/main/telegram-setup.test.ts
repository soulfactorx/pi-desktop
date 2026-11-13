import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, safeStorage: {} }));
const { sameBot } = await import("../../src/main/telegram-setup");

describe("sameBot", () => {
  it("같은 봇의 토큰을 다시 넣으면 연결을 그대로 둔다 (대소문자 무시)", () => {
    expect(sameBot("pidesktopmate_bot", "pidesktopmate_bot")).toBe(true);
    expect(sameBot("PiDesktopMate_bot", "pidesktopmate_bot")).toBe(true);
  });
  it("다른 봇이거나 처음 넣는 것이면 새로 연결한다", () => {
    expect(sameBot("pidesktopmate_bot", "other_bot")).toBe(false);
    expect(sameBot(undefined, "pidesktopmate_bot")).toBe(false);
  });
});
