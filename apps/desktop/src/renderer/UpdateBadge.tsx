import { useEffect, useState } from "react";
import type { UpdateState } from "../shared/api";

/** 앱 업데이트 상태를 구독한다 */
export function useUpdateState(): UpdateState | undefined {
  const [state, setState] = useState<UpdateState | undefined>();
  useEffect(() => {
    void window.piDesktop.updateState().then(setState, () => {});
    return window.piDesktop.onUpdateState(setState);
  }, []);
  return state;
}

/** 배지에 보일 글. 보일 것이 없으면 undefined (최신이거나 아직 확인 전·개발 실행) */
export function updateBadgeText(state: UpdateState | undefined): string | undefined {
  if (!state) return undefined;
  switch (state.status) {
    case "downloading":
      return `업데이트 받는 중 ${state.percent ?? 0}%`;
    case "downloaded":
      return `다시 시작해 ${state.version} 설치`;
    case "available":
      return state.mode === "auto" ? `새 버전 ${state.version} 업데이트…` : `새 버전 ${state.version}`;
    default:
      return undefined;
  }
}

/**
 * 탭 바의 업데이트 배지 (M5 자동 업데이트). 새 버전을 찾으면 누를 때 업데이트할지 묻고(main의 창),
 * 내려받았으면 눌러서 다시 시작하며 설치한다. 자동 설치가 안 되는 곳(서명 없는 macOS·deb)은 릴리스 페이지를 연다.
 */
export function UpdateBadge({ state }: { state: UpdateState | undefined }) {
  const text = updateBadgeText(state);
  if (!state || !text) return null;
  const clickable = state.status === "downloaded" || state.status === "available";
  return (
    <button
      type="button"
      className={`update-badge ${state.status}`}
      disabled={!clickable}
      onClick={() => {
        if (state.status === "downloaded") void window.piDesktop.installUpdate();
        else if (state.status === "available") void window.piDesktop.confirmUpdate();
      }}
      title={
        state.status === "downloaded"
          ? `지금 ${state.current}입니다. 누르면 앱을 다시 시작하며 ${state.version}을(를) 설치합니다 (열린 Pi 세션은 Host Agent에서 계속 돕니다).`
          : state.status === "available"
            ? state.mode === "auto"
              ? `지금 ${state.current}입니다. 누르면 ${state.version}(으)로 업데이트할지 묻습니다.`
              : `지금 ${state.current}입니다. 이 OS에서는 자동 설치가 되지 않아 릴리스 페이지에서 내려받습니다.`
            : `지금 ${state.current}입니다.`
      }
    >
      {text}
    </button>
  );
}

/**
 * Agent·Mate 작업 공간 위의 업데이트 띠. 업데이트 배지는 Pi 작업 공간 위쪽(탭 바)에만 있어,
 * 다른 작업 공간을 보는 동안에는 메뉴의 "업데이트 확인"으로 시작한 내려받기가 보이지 않았다.
 * 새 버전을 찾았을 때·내려받는 동안(진행 막대)·내려받은 뒤(다시 시작해 설치)만 보인다.
 */
export function UpdateStrip({ state }: { state: UpdateState | undefined }) {
  const text = updateBadgeText(state);
  if (!state || !text) return null;
  const percent = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)));
  return (
    <div className={`update-strip ${state.status}`} role="status">
      <span className="update-strip-text">
        {state.status === "downloading" ? `Pi Desktop ${state.version ?? "새 버전"} 업데이트 받는 중 ${percent}%` : text}
      </span>
      {state.status === "downloading" && (
        <span className="update-strip-bar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
      )}
      {state.status === "downloaded" && (
        <button type="button" className="small primary" onClick={() => void window.piDesktop.installUpdate()}>
          다시 시작해 설치
        </button>
      )}
      {state.status === "available" && (
        <button type="button" className="small" onClick={() => void window.piDesktop.confirmUpdate()}>
          {state.mode === "auto" ? "업데이트…" : "릴리스 페이지"}
        </button>
      )}
    </div>
  );
}
