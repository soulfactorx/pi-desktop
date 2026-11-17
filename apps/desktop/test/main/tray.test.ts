import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Menu: {}, nativeImage: {}, Tray: class {} }));
const { trayMenuTemplate, trayTooltip } = await import("../../src/main/tray");

const actions = { open: vi.fn(), openMate: vi.fn(), startMate: vi.fn(async () => {}), mateStatus: vi.fn(), quit: vi.fn() };
const labels = (items: ReturnType<typeof trayMenuTemplate>) => items.filter((i) => i.type !== "separator").map((i) => i.label);

describe("트레이", () => {
  it("Mate 실행기가 돌면 상태·오늘 실행·새 제안을 보이고, 인박스·대화로 간다", () => {
    const now = Date.now();
    const status = { alive: true, heartbeatAt: now - 2 * 60_000, todayRuns: 3, newInbox: 2 };
    expect(trayTooltip(status)).toBe("Pi Desktop · Mate 실행기 동작 중 · 오늘 자동 실행 3회 · 새 제안 2건");
    const items = trayMenuTemplate(status, actions, now);
    expect(labels(items)).toEqual([
      "Pi Desktop 열기",
      "● Mate 실행기 동작 중 · 마지막 확인 2분 전",
      "  오늘 자동 실행 3회",
      "Mate 인박스 열기 (새 제안 2건)",
      "Mate 대화 열기",
      "끝내기 (Mate 실행기는 계속 돎)",
    ]);
    items.find((i) => i.label?.startsWith("Mate 인박스"))!.click!({} as never, undefined, {} as never);
    expect(actions.openMate).toHaveBeenCalledWith("inbox");
  });

  it("실행기가 꺼져 있으면 시작 메뉴를 보이고, Mate가 꺼져 있으면 열기·끝내기만", () => {
    const off = { alive: false, todayRuns: 0, newInbox: 0 };
    expect(trayTooltip(off)).toBe("Pi Desktop · Mate 실행기 꺼짐");
    const items = trayMenuTemplate(off, actions);
    expect(labels(items)).toContain("Mate 실행기 시작");
    items.find((i) => i.label === "Mate 실행기 시작")!.click!({} as never, undefined, {} as never);
    expect(actions.startMate).toHaveBeenCalled();
    expect(trayTooltip({ alive: true, current: "hn", todayRuns: 1, newInbox: 0 })).toContain("지금 임무 실행 중 (hn)");
    expect(labels(trayMenuTemplate(undefined, actions))).toEqual(["Pi Desktop 열기", "끝내기 (Mate 실행기는 계속 돎)"]);
  });
});
