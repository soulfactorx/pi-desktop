import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Menu: {}, nativeImage: {}, Tray: class {} }));
const { trayMenuTemplate, trayTooltip } = await import("../../src/main/tray");
const { PendingAlerts } = await import("../../src/main/pending-alerts");

const actions = { open: vi.fn(), openMate: vi.fn(), startMate: vi.fn(async () => {}), mateStatus: vi.fn(), openRoute: vi.fn(), quit: vi.fn() };
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

  it("보지 않은 알림을 수·목록으로 보이고, 누르면 그곳으로 가며 읽은 것으로 친다", () => {
    const now = Date.now();
    const alerts = new PendingAlerts();
    const changes: number[] = [];
    alerts.onChange(() => changes.push(alerts.count));
    alerts.add({ title: "임무 끝남", body: "HN 요약", route: { workspace: "mate", tab: "runs" }, at: now - 5 * 60_000 });
    for (let i = 0; i < 6; i++) alerts.add({ title: `알림 ${i}`, body: "", at: now });
    expect(trayTooltip(undefined, alerts.count)).toBe("Pi Desktop · 새 알림 7건");
    expect(trayTooltip({ alive: true, todayRuns: 1, newInbox: 0 }, 2)).toBe("Pi Desktop · 새 알림 2건 · Mate 실행기 동작 중 · 오늘 자동 실행 1회");
    let items = trayMenuTemplate(undefined, actions, now, alerts);
    expect(labels(items).slice(0, 3)).toEqual(["Pi Desktop 열기", "🔴 새 알림 7건", "  알림 5 (방금)"]);
    expect(labels(items)).toContain("  외 2건");
    // 맨 아래까지 밀린 첫 알림은 목록 밖이라, 지우고 다시 만든다
    alerts.clear();
    const first = alerts.add({ title: "임무 끝남", body: "HN 요약", route: { workspace: "mate", tab: "runs" }, at: now - 5 * 60_000 });
    items = trayMenuTemplate(undefined, actions, now, alerts);
    const row = items.find((i) => i.label?.includes("임무 끝남"))!;
    expect(row.label).toBe("  임무 끝남 — HN 요약 (5분 전)");
    row.click!({} as never, undefined, {} as never);
    expect(actions.openRoute).toHaveBeenCalledWith({ workspace: "mate", tab: "runs" });
    expect(alerts.count).toBe(0);
    expect(alerts.list.find((a) => a.id === first.id)).toBeUndefined();
    expect(labels(trayMenuTemplate(undefined, actions, now, alerts))).toEqual(["Pi Desktop 열기", "끝내기 (Mate 실행기는 계속 돎)"]);
    expect(changes.at(-1)).toBe(0);
  });

  it("목록은 20개까지만 기억하고 수는 그대로 센다", () => {
    const alerts = new PendingAlerts();
    for (let i = 0; i < 25; i++) alerts.add({ title: `a${i}`, body: "", at: 0 });
    expect(alerts.count).toBe(25);
    expect(alerts.list).toHaveLength(20);
    expect(alerts.list[0]!.title).toBe("a24");
  });
});
