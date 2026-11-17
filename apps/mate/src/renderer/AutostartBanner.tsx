import { useEffect, useState } from "react";
import type { AutostartView, Overview } from "../shared/api";
import type { Act } from "./App";
import { isWebClient } from "./clipboard-images";

/** "괜찮아요"를 누르면 다시 묻지 않는다 (설정 탭에서 언제든 켤 수 있다) */
const DISMISS_KEY = "mate-autostart-asked";

/**
 * PC를 켜면 Mate 실행기를 자동으로 시작할지 한 번 묻는다 (설계 DESIGN-MATE.md §2.3).
 * 실행기는 앱이 띄우므로, 꺼 두면 PC를 다시 켠 뒤 Pi Desktop을 열기 전까지 임무·관찰·휴대폰 연결이 멈춘다.
 * Mate에 할 일이 있을 때만(임무·활동/시스템 관찰·휴대폰 연결) 묻고, 이 PC의 실행기일 때만 묻는다.
 */
export function AutostartBanner({ overview, remote, act }: { overview: Overview; remote: boolean; act: Act }) {
  const [state, setState] = useState<AutostartView>();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const web = isWebClient();
  useEffect(() => {
    if (web || remote || dismissed) return;
    void window.mate.getAutostart().then(setState, () => undefined);
  }, [web, remote, dismissed]);

  const { config, duties } = overview;
  const sys = config.observe.system;
  const hasWork = duties.some((d) => d.enabled) || config.observe.enabled || sys.health || sys.habits || sys.apps || config.telegram.enabled;
  if (web || remote || dismissed || !hasWork || !state?.supported || state.enabled) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // 기억하지 못하면 다음에 한 번 더 묻는다
    }
    setDismissed(true);
  };
  return (
    <div className="setup-banner" role="status">
      <div className="setup-issue">
        <strong>PC를 켜면 Mate가 바로 일하게 할까요?</strong>
        <span className="muted">
          지금은 PC를 다시 켠 뒤 Pi Desktop을 열어야 Mate 실행기가 돌아, 그 전까지 임무·관찰·휴대폰 연결이 멈춥니다. 켜 두면 로그인할 때 창 없이 실행기만
          시작합니다.
        </span>
        <div className="row">
          <button
            className="small primary"
            onClick={() =>
              void act(async () => {
                const next = await window.mate.setAutostart(true);
                setState(next);
                if (next.enabled) dismiss();
              })
            }
          >
            켜기
          </button>
          <button className="small" onClick={dismiss}>
            괜찮아요 (설정에서 켤 수 있음)
          </button>
        </div>
      </div>
    </div>
  );
}
