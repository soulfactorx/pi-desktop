import { useCallback, useEffect, useState } from "react";
import type { WorkspaceId, WorkspacesState } from "../shared/api";
import { App } from "./App";
import { isWebClient } from "./clipboard-images";
import { UpdateStrip, useUpdateState } from "./UpdateBadge";

/**
 * 웹에서는 Agent·Mate가 같은 서버의 /agent/·/mate/ 아래에 있다 (한 포트, pi-web start). 지금 연 주소에 붙여 연다
 * (포트 포워딩·다른 기기에서 열어도 그대로). 따로 띄운 서버(pi-web agent start)는 다른 포트의 주소를 알려 주므로
 * 호스트만 지금 연 주소로 바꾼다.
 */
function frameUrl(url: string): string {
  if (!isWebClient()) return url;
  if (url.startsWith("/")) return new URL(url, window.location.href).href;
  try {
    const next = new URL(url);
    next.hostname = window.location.hostname;
    return next.href;
  } catch {
    return url;
  }
}

/**
 * 창의 뿌리 (설계 DESIGN-ONE-APP.md): 작업 공간 막대 + 작업 공간들.
 * - "pi" 작업 공간은 지금까지의 Pi Desktop 화면(App)이다. 켜고 끄거나 바꿔도 다시 그리지 않도록 늘 같은 자리에 두고 숨기기만 한다.
 * - 켠 플러그인(지금은 Agent·Mate 미리 보기)은 그 앱의 화면을 iframe으로 연다. 한 번 연 프레임은 숨겨도 남아 대화가 이어진다.
 * - 켠 플러그인이 없으면(기본, 웹) 막대 없이 지금과 똑같다.
 */
export function Shell() {
  const [state, setState] = useState<WorkspacesState>();
  const [active, setActive] = useState<WorkspaceId>("pi");
  // 한 번이라도 보인 플러그인만 프레임을 만든다 (켜 두기만 하고 열지 않은 화면은 불러오지 않는다)
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // 앱 업데이트 상태: Pi 작업 공간은 탭 바의 배지로, Agent·Mate 작업 공간은 위쪽 띠로 보인다
  const update = useUpdateState();

  const refresh = useCallback(() => {
    window.piDesktop.workspacesState().then(setState, () => setState(undefined));
  }, []);

  const show = useCallback((id: WorkspaceId) => {
    setActive(id);
    // Pi 화면이 숨었는지 알 수 있게 둔다 (App.tsx의 알림: 다른 작업 공간을 보는 동안에는 지금 탭 소식도 알린다)
    document.documentElement.dataset.workspace = id;
    if (id !== "pi") setOpened((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
    void window.piDesktop.workspaceShown(id).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    // main이 작업 공간을 바꾸라고 할 때 (알림을 누름·메뉴바·켜고 끄기)
    const offShow = window.piDesktop.onShowWorkspace((id) => {
      refresh();
      show(id);
    });
    // 읽지 않은 알림 수가 바뀌었을 때
    const offChanged = window.piDesktop.onWorkspacesChanged(refresh);
    // 휴대폰 웹: Agent·Mate 서버는 pi-web 명령으로 켜고 끈다. 화면으로 돌아올 때 다시 본다
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offShow();
      offChanged();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, show]);

  const plugins = (state?.plugins ?? []).filter((p) => p.enabled && p.url);
  // 꺼진 플러그인을 보고 있었으면 Pi로 돌아간다
  useEffect(() => {
    if (active !== "pi" && state && !plugins.some((p) => p.id === active)) show("pi");
  }, [active, state, plugins, show]);

  return (
    <div className="space-root">
      {plugins.length > 0 ? (
        <nav className="space-bar" aria-label="작업 공간">
          <button type="button" className={active === "pi" ? "on" : ""} title="Pi" aria-label="Pi 작업 공간" onClick={() => show("pi")}>
            Pi
          </button>
          {plugins.map((p) => (
            <button key={p.id} type="button" className={active === p.id ? "on" : ""} title={p.name} aria-label={`${p.name} 작업 공간`} onClick={() => show(p.id)}>
              {p.id === "agent" ? "A" : p.id === "mate" ? "M" : String(p.id).slice(0, 1).toUpperCase()}
              {p.unread ? (
                <span className="space-badge" aria-label={`읽지 않은 알림 ${p.unread}개`}>
                  {p.unread > 99 ? "99+" : p.unread}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="space-pane" hidden={active !== "pi"}>
        <App />
      </div>
      {plugins
        .filter((p) => opened[p.id])
        .map((p) => (
          <div key={p.id} className="space-pane plugin" hidden={active !== p.id}>
            <UpdateStrip state={update} />
            <iframe
              className="space-frame"
              title={p.name}
              src={frameUrl(p.url!)}
              onLoad={() => void window.piDesktop.workspaceReady(p.id).catch(() => undefined)}
            />
          </div>
        ))}
    </div>
  );
}
