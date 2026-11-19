import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { MateLocalStatus } from "../../../mate/src/main/mate-main";
import type { NotificationRoute } from "./app-notification";
import { pendingAlerts, type PendingAlert } from "./pending-alerts";

/**
 * 트레이(알림 영역) 아이콘 (설계 DESIGN-ONE-APP.md §10).
 * Pi Desktop이 떠 있는 동안, 그리고 로그인할 때 창 없이 뜬 동안 보인다. Mate 실행기가 도는지 여기서 확인한다.
 * 창을 닫아도 앱은 트레이에 남는다 (끝내기는 트레이 메뉴의 "끝내기"). 앱을 끝내도 Mate 실행기는 따로 계속 돈다.
 */

export interface TrayActions {
  /** Pi Desktop 창을 연다 (없으면 만든다) */
  open(): void;
  /** Mate 작업 공간의 탭을 연다 */
  openMate(tab: "chat" | "inbox" | "runs"): void;
  /** 이 PC의 Mate 실행기가 없으면 띄운다 */
  startMate(): Promise<void>;
  /** Mate 실행기 상태. Mate 작업 공간이 꺼져 있으면 undefined */
  mateStatus(): Promise<MateLocalStatus | undefined>;
  /** 알림이 가리키는 곳으로 간다 (트레이의 알림 목록에서 누름) */
  openRoute(route: NotificationRoute): void;
  /** 새 알림 수가 바뀌었다 (작업 표시줄 표시 등) */
  alertsChanged?(count: number): void;
  quit(): void;
}

/** 트레이 알림 목록에 보이는 수 */
const ALERTS_IN_MENU = 5;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 알림 목록의 한 줄 */
export function alertLabel(alert: Pick<PendingAlert, "title" | "body" | "at">, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - alert.at) / 60_000));
  const ago = minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전` : `${Math.round(minutes / 60)}시간 전`;
  return `${clip(alert.title, 40)}${alert.body ? ` — ${clip(alert.body, 50)}` : ""} (${ago})`;
}

/** 트레이 마우스를 올렸을 때 보이는 글 */
export function trayTooltip(status: MateLocalStatus | undefined, alerts = 0): string {
  const head = alerts > 0 ? `Pi Desktop · 새 알림 ${alerts}건` : "Pi Desktop";
  return tooltipBody(status).replace(/^Pi Desktop/, head);
}

function tooltipBody(status: MateLocalStatus | undefined): string {
  if (!status) return "Pi Desktop";
  if (!status.alive) return "Pi Desktop · Mate 실행기 꺼짐";
  const parts = [status.current ? `지금 임무 실행 중 (${status.current})` : "Mate 실행기 동작 중", `오늘 자동 실행 ${status.todayRuns}회`];
  if (status.newInbox > 0) parts.push(`새 제안 ${status.newInbox}건`);
  return `Pi Desktop · ${parts.join(" · ")}`;
}

/** 트레이 메뉴 (Electron 없이 시험할 수 있게 옵션 목록만 만든다) */
export function trayMenuTemplate(
  status: MateLocalStatus | undefined,
  actions: TrayActions,
  now = Date.now(),
  alerts: { count: number; list: readonly PendingAlert[]; remove(id: number): void; clear(): void } = pendingAlerts,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: "Pi Desktop 열기", click: () => actions.open() }];
  if (alerts.count > 0) {
    items.push({ type: "separator" }, { label: `🔴 새 알림 ${alerts.count}건`, enabled: false });
    for (const alert of alerts.list.slice(0, ALERTS_IN_MENU)) {
      items.push({
        label: `  ${alertLabel(alert, now)}`,
        click: () => {
          alerts.remove(alert.id);
          if (alert.route) actions.openRoute(alert.route);
          else actions.open();
        },
      });
    }
    if (alerts.count > ALERTS_IN_MENU) items.push({ label: `  외 ${alerts.count - ALERTS_IN_MENU}건`, enabled: false });
    items.push({ label: "알림 모두 읽음", click: () => alerts.clear() });
  }
  if (status) {
    const beat = status.heartbeatAt ? ` · 마지막 확인 ${Math.max(0, Math.round((now - status.heartbeatAt) / 60_000))}분 전` : "";
    items.push(
      { type: "separator" },
      { label: status.alive ? `● Mate 실행기 동작 중${beat}` : "○ Mate 실행기 꺼짐", enabled: false },
      ...(status.current ? [{ label: `  지금 실행 중: ${status.current}`, enabled: false }] : []),
      { label: `  오늘 자동 실행 ${status.todayRuns}회`, enabled: false },
      { label: status.newInbox > 0 ? `Mate 인박스 열기 (새 제안 ${status.newInbox}건)` : "Mate 인박스 열기", click: () => actions.openMate("inbox") },
      { label: "Mate 대화 열기", click: () => actions.openMate("chat") },
      ...(status.alive ? [] : [{ label: "Mate 실행기 시작", click: () => void actions.startMate() }]),
    );
  }
  items.push({ type: "separator" }, { label: "끝내기 (Mate 실행기는 계속 돎)", click: () => actions.quit() });
  return items;
}

export interface AppTray {
  /** 상태를 다시 읽어 메뉴·툴팁을 고친다 */
  refresh(): Promise<void>;
  dispose(): void;
}

/** 상태를 다시 읽는 간격 */
const REFRESH_MS = 60_000;

/** 트레이에 맞춘 아이콘 (화면 배율 1·2배 모두 담는다) */
function trayImage(path: string): Electron.NativeImage | undefined {
  const source = nativeImage.createFromPath(path);
  if (source.isEmpty()) return undefined;
  const size = process.platform === "darwin" ? 18 : 16;
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    image.addRepresentation({ scaleFactor: scale, width: size * scale, height: size * scale, buffer: source.resize({ width: size * scale, height: size * scale, quality: "best" }).toPNG() });
  }
  return image;
}

/** @param alertIconPath 새 알림이 있을 때 쓰는 아이콘 (빨간 점을 얹은 것) */
export function createAppTray(iconPath: string, actions: TrayActions, alertIconPath?: string): AppTray | undefined {
  const image = trayImage(iconPath);
  if (!image) return undefined;
  const alertImage = (alertIconPath && trayImage(alertIconPath)) || image;
  let tray: Tray | undefined;
  try {
    tray = new Tray(image);
  } catch {
    // 트레이가 없는 데스크톱 환경 (일부 Linux)
    return undefined;
  }
  const refresh = async () => {
    const status = await actions.mateStatus().catch(() => undefined);
    if (!tray || tray.isDestroyed()) return;
    tray.setImage(pendingAlerts.count > 0 ? alertImage : image);
    tray.setToolTip(trayTooltip(status, pendingAlerts.count));
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(status, actions)));
  };
  // 알림이 오거나 읽으면 바로 아이콘·메뉴를 바꾼다
  const offAlerts = pendingAlerts.onChange(() => {
    actions.alertsChanged?.(pendingAlerts.count);
    void refresh();
  });
  // Windows·Linux는 아이콘을 누르면 창을 연다 (macOS는 누르면 메뉴가 뜬다)
  if (process.platform !== "darwin") tray.on("click", () => actions.open());
  // 메뉴를 열기 직전에 최신 상태로 (Windows는 오른쪽 클릭)
  tray.on("right-click", () => void refresh());
  tray.on("mouse-enter", () => void refresh());
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  timer.unref?.();
  return {
    refresh,
    dispose() {
      clearInterval(timer);
      offAlerts();
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = undefined;
    },
  };
}
