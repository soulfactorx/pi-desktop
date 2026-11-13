import { useMissingPackages } from "@pi-desktop/pi-resources/react";

/**
 * 설치 폴더가 없는 Pi 패키지 알림. 그 패키지의 도구는 대화에 올라가지 않는다.
 * Agent는 ~/.pi-desktop-agent/npm·git에 설치한 패키지만 쓰므로, 그 폴더를 지우면 여기서 알린다.
 */
export function MissingPackagesBanner({ connected, onError, onOpen }: { connected: boolean; onError: (message: string) => void; onOpen: () => void }) {
  const pkgs = useMissingPackages(
    { list: () => window.piAgent.packagesList(), install: (source) => window.piAgent.packageInstall(source) },
    (job) => job().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error))),
    connected,
  );
  if (pkgs.missing.length === 0) return null;
  const names = pkgs.missing.map((p) => p.name).join(", ");
  return (
    <div className="setup-banner" role="alert">
      <div className="setup-issue error">
        <strong>Pi 패키지 설치 폴더가 없습니다: {names}</strong>
        <span className="muted">
          이 패키지의 도구가 대화에 올라가지 않습니다. Agent는 ~/.pi-desktop-agent의 npm·git 폴더에 설치한 패키지만 씁니다 (~/.pi의 것과 따로).
        </span>
        <button className="small primary" disabled={Boolean(pkgs.busy)} onClick={pkgs.reinstall}>
          {pkgs.busy ? `${pkgs.busy} 설치 중…` : "다시 설치"}
        </button>
        <button className="small" onClick={onOpen}>
          패키지 화면
        </button>
      </div>
      {pkgs.failed && <pre className="small-text">{pkgs.failed}</pre>}
    </div>
  );
}
