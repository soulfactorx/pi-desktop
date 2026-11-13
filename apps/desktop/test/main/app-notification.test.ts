import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Notification: class {} }));
const { parseRoute, routeFromArgv, routeUrl, toastXml } = await import("../../src/main/app-notification");

describe("알림 주소", () => {
  it("Mate 탭과 Agent 명령을 주소로 바꾸고 되돌린다", () => {
    expect(routeUrl({ workspace: "mate", tab: "inbox" })).toBe("pi-desktop://open/mate/inbox");
    expect(parseRoute("pi-desktop://open/mate/inbox")).toEqual({ workspace: "mate", tab: "inbox" });
    const chat = routeUrl({ workspace: "agent", command: "open-chat:01a1d2a0-0717" });
    expect(chat).toBe("pi-desktop://open/agent/open-chat%3A01a1d2a0-0717");
    expect(parseRoute(chat)).toEqual({ workspace: "agent", command: "open-chat:01a1d2a0-0717" });
    // Windows가 끝에 /를 붙여 넘기기도 한다
    expect(parseRoute("pi-desktop://open/agent/page%3Atasks/")).toEqual({ workspace: "agent", command: "page:tasks" });
  });

  it("Pi 작업 공간의 탭도 주소로 바꾼다", () => {
    expect(routeUrl({ workspace: "pi", tab: "tmhw1k2" })).toBe("pi-desktop://open/pi/tmhw1k2");
    expect(parseRoute("pi-desktop://open/pi/tmhw1k2")).toEqual({ workspace: "pi", tab: "tmhw1k2" });
    expect(parseRoute("pi-desktop://open/pi/a%2Fb")).toBeUndefined();
  });

  it("모르는 주소·탭·이상한 명령은 받지 않는다", () => {
    expect(parseRoute("pi-desktop://open/mate/settings")).toBeUndefined();
    expect(parseRoute("pi-desktop://open/other/x")).toBeUndefined();
    expect(parseRoute("pi-desktop://open/agent/a%20b")).toBeUndefined();
    expect(parseRoute("pi-desktop://open/agent/%E0")).toBeUndefined();
    expect(parseRoute("https://example.com")).toBeUndefined();
  });

  it("명령 줄 인자에서 주소를 찾는다 (알림 센터에서 눌러 앱이 열릴 때)", () => {
    expect(routeFromArgv(["C:\\Pi Desktop.exe", "--flag", "pi-desktop://open/mate/runs"])).toEqual({ workspace: "mate", tab: "runs" });
    expect(routeFromArgv(["C:\\Pi Desktop.exe"])).toBeUndefined();
  });

  it("토스트 XML은 글자를 이스케이프하고 주소를 launch에 둔다", () => {
    const xml = toastXml('임무 완료: "A" & <B>', "", "pi-desktop://open/mate/inbox");
    expect(xml).toContain('activationType="protocol" launch="pi-desktop://open/mate/inbox"');
    expect(xml).toContain("임무 완료: &quot;A&quot; &amp; &lt;B&gt;");
    expect(xml).not.toContain("<text></text>");
    expect(xml).not.toContain("audio");
    expect(toastXml("끝", "", "pi-desktop://open/pi/t1", true)).toContain('<audio silent="true"/>');
  });
});
