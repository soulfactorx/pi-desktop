import { Notification } from "electron";

/**
 * OS 알림과, 알림을 눌렀을 때 갈 곳 (Agent·Mate 작업 공간의 알림).
 *
 * Windows는 화면에서 사라진 알림을 알림 센터에 쌓는다. 거기서 누르면 Electron의 click 이벤트가 오지 않는 일이 많다
 * (그 사이 알림 객체가 정리되었거나, 이미 화면의 토스트가 아니어서). 그래서 Windows에서는 알림에 앱 주소(pi-desktop://)를
 * 실어 두고, 누르면 Windows가 그 주소로 앱을 연다 → 단일 인스턴스가 second-instance로 받아 그 화면으로 간다 (index.ts).
 * 화면에 떠 있는 알림은 지금처럼 click으로도 간다 (둘 다 와도 같은 화면을 한 번 더 여는 것뿐이다).
 */

export const APP_PROTOCOL = "pi-desktop";

/** 알림을 누르면 갈 곳 */
export type NotificationRoute =
  /** Mate 작업 공간의 탭 */
  | { workspace: "mate"; tab: "chat" | "runs" | "inbox" }
  /** Agent 작업 공간의 메뉴 명령 (page:tasks, open-chat:<세션 id> …) */
  | { workspace: "agent"; command: string };

export function routeUrl(route: NotificationRoute): string {
  const target = route.workspace === "mate" ? route.tab : route.command;
  return `${APP_PROTOCOL}://open/${route.workspace}/${encodeURIComponent(target)}`;
}

/** 앱 주소를 갈 곳으로 푼다. 모르는 주소면 undefined */
export function parseRoute(url: string): NotificationRoute | undefined {
  const match = new RegExp(`^${APP_PROTOCOL}://open/(mate|agent)/([^/?#]+)/?$`).exec(url.trim());
  if (!match) return undefined;
  let target: string;
  try {
    target = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  if (match[1] === "mate") return target === "chat" || target === "runs" || target === "inbox" ? { workspace: "mate", tab: target } : undefined;
  // 메뉴 명령은 page:이름, open-chat:세션 id, new-chat 같은 짧은 글자만 받는다
  return /^[\w:.-]{1,200}$/.test(target) ? { workspace: "agent", command: target } : undefined;
}

/** 명령 줄 인자 중 앱 주소 (Windows가 알림을 눌러 앱을 열 때 넘긴다) */
export function routeFromArgv(argv: readonly string[]): NotificationRoute | undefined {
  for (const arg of argv) {
    if (arg.startsWith(`${APP_PROTOCOL}://`)) return parseRoute(arg);
  }
  return undefined;
}

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** 누르면 앱 주소를 여는 Windows 토스트 (알림 센터에서 눌러도 앱이 그 주소를 받는다) */
export function toastXml(title: string, body: string, url: string): string {
  return [
    `<toast activationType="protocol" launch="${escapeXml(url)}">`,
    "<visual><binding template=\"ToastGeneric\">",
    `<text>${escapeXml(title)}</text>`,
    body ? `<text>${escapeXml(body)}</text>` : "",
    "</binding></visual>",
    "</toast>",
  ].join("");
}

/** 알림 객체를 잡아 둔다. 놓으면 정리되어 화면의 알림을 눌러도 click이 오지 않을 수 있다 */
const kept = new Set<Notification>();
const KEEP_MAX = 50;

/**
 * 알림을 띄운다. onClick은 화면에 떠 있는 알림을 눌렀을 때, route는 Windows 알림 센터에서 눌렀을 때 쓴다.
 */
export function showAppNotification(options: { title: string; body: string; route?: NotificationRoute; onClick: () => void }): void {
  const { title, body, route, onClick } = options;
  const notification = new Notification({
    title,
    body,
    ...(process.platform === "win32" && route ? { toastXml: toastXml(title, body, routeUrl(route)) } : {}),
  });
  kept.add(notification);
  if (kept.size > KEEP_MAX) kept.delete(kept.values().next().value!);
  notification.on("click", () => {
    kept.delete(notification);
    onClick();
  });
  notification.show();
}
