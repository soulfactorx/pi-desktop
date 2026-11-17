import type { SystemObserveConfig, SystemView } from "@pi-desktop/mate-runner/system-types";
import { useEffect, useState } from "react";
import type { Overview } from "../shared/api";
import type { Act } from "./App";
import { relativeTime } from "./mate-view";

/**
 * 시스템 관찰 (설계 DESIGN-MATE.md §10.1). 활동 탭 아래에 둔다.
 * 출처마다 따로 켜고, 무엇을 보고·남기고·보내는지 켜기 전에 보인다. 모델로 보내는 요약은 미리 볼 수 있다.
 */

const SOURCES: Array<{ key: keyof Omit<SystemObserveConfig, "ignore">; label: string; hint: string; confirm?: string; sub?: boolean }> = [
  {
    key: "health",
    label: "시스템 건강",
    hint: "오류 로그(Windows 이벤트 로그·Linux journalctl의 오류 이상), 실패한 서비스·예약 작업, 디스크 남은 용량을 1시간마다 봅니다",
  },
  {
    key: "habits",
    label: "되풀이하는 작업 찾기",
    hint: "비슷한 Pi 요청(활동 관찰이 켜져 있을 때)을 며칠씩 되풀이하면 임무로 만들지 대화로 묻습니다",
  },
  {
    key: "shellHistory",
    label: "셸 기록도 읽기",
    hint: "bash·zsh·fish·PowerShell 기록에서 프로그램 이름과 하위 명령만 셉니다 (git commit -m \"…\" → git commit). 인자·경로·비밀번호처럼 보이는 줄과 ssh·export 같은 명령은 아예 버립니다",
    confirm:
      "셸 기록을 읽을까요?\n\n· 프로그램 이름과 하위 명령만 남기고 인자는 모두 버립니다 (git commit -m \"…\" → git commit)\n· 공백으로 시작한 줄, 비밀번호·토큰이 들어간 듯한 줄, ssh·export·gpg 같은 명령은 아예 세지 않습니다\n· 기록은 이 기기의 Mate 데이터에만 두고, 끄면 바로 지웁니다",
    sub: true,
  },
  {
    key: "apps",
    label: "켜져 있는 프로그램",
    hint: "몇 분마다 창이 있는 프로그램의 이름만 세어 하루에 몇 시간 켜져 있었는지 모읍니다. 창 제목·문서 이름·인자는 보지 않습니다",
    confirm:
      "켜져 있는 프로그램을 셀까요?\n\n· 5분마다 프로그램 이름만 봅니다 (창 제목·열린 문서·인자는 보지 않음)\n· '켜져 있던 시간'이지 실제로 쓴 시간은 아닙니다\n· 무시할 이름에 적은 프로그램은 세지 않고, 끄면 바로 지웁니다",
  },
  {
    key: "analyze",
    label: "모델로 분석",
    hint: "하루 한 번 아래 '보낼 요약'만 Mate 모델에게 보내 필요한 작업을 1~2개 제안받습니다. 이 실행은 제안·질문만 할 수 있고 파일·명령은 쓰지 못합니다. 끄면 이 기기 밖으로 아무것도 나가지 않습니다",
    confirm:
      "모델로 분석할까요?\n\n· 하루 한 번 '보낼 요약 보기'에 나오는 글만 모델 제공자에게 보냅니다 (오류 출처·횟수와 가린 한 줄, 명령 모양, 프로그램 이름·시간)\n· 날것의 로그·명령·파일은 보내지 않습니다\n· 끄면 보내지 않습니다",
  },
];

export function SystemSection({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const sys = overview.config.observe.system;
  const view: SystemView = overview.system;
  const [ignore, setIgnore] = useState(sys.ignore.join(", "));
  const [digest, setDigest] = useState<string>();
  useEffect(() => setIgnore(sys.ignore.join(", ")), [sys.ignore]);
  const save = (patch: Partial<SystemObserveConfig>) => void act(() => window.mate.saveConfig({ observe: { system: { ...sys, ...patch } } }));
  const toggle = (source: (typeof SOURCES)[number]) => {
    const on = !sys[source.key];
    if (on && source.confirm && !window.confirm(source.confirm)) return;
    save({ [source.key]: on });
  };
  const anyOn = sys.health || sys.habits || sys.apps;

  return (
    <section className="form system-observe">
      <h2>시스템 관찰 {view.supported && <span className="muted small-text">· {view.platform}</span>}</h2>
      {!view.supported ? (
        <div className="muted small-text">이 기기({view.platform})에서는 시스템 로그·프로그램 목록을 볼 수 없어 시스템 관찰을 쓰지 않습니다.</div>
      ) : (
        <>
          <div className="muted small-text privacy">
            <div>
              <strong>남기는 것</strong>: 요약뿐입니다. 오류는 출처·번호·횟수와 가린 한 줄(홈 경로·사용자 이름·메일·IP·주소·비밀값을 가림), 명령은 프로그램과
              하위 명령, 프로그램은 이름과 켜져 있던 시간. 날것의 로그·명령·창 제목은 남기지 않습니다.
            </div>
            <div>
              <strong>어디에</strong>: 이 기기의 Mate 데이터에만, 최근 며칠 치만 둡니다 (설정의 '시스템 관찰 기록 보관', 기본 14일). 출처를 끄면 그 기록은 바로 지우고, 아래에서 언제든 모두 지울 수 있습니다.
            </div>
            <div>
              <strong>밖으로</strong>: '모델로 분석'을 켰을 때만 하루 한 번 요약을 모델에게 보냅니다. 알림·질문은 모델 없이 규칙으로 만듭니다.
            </div>
          </div>
          {SOURCES.map((source) => (
            <label key={source.key} className="radio" style={source.sub ? { marginLeft: "1.6em" } : undefined}>
              <input
                type="checkbox"
                checked={sys[source.key]}
                disabled={(source.key === "shellHistory" && !sys.habits) || (source.key === "analyze" && !anyOn)}
                onChange={() => toggle(source)}
              />
              <strong>{source.label}</strong>
              <span className="muted">{source.hint}</span>
            </label>
          ))}
          <label className="inline">
            무시할 이름
            <input
              value={ignore}
              placeholder="예: steam, discord, kubectl"
              onChange={(e) => setIgnore(e.target.value)}
              onBlur={() => save({ ignore: ignore.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) })}
            />
            <span className="muted small-text">적은 낱말이 들어간 프로그램·명령은 세지도 알리지도 않습니다 (쉼표로 구분)</span>
          </label>
          <div className="row">
            <button type="button" disabled={!anyOn} onClick={() => void act(async () => setDigest((await window.mate.systemDigest()) || "아직 모은 것이 없습니다."))}>
              보낼 요약 보기
            </button>
            <button
              type="button"
              className="danger"
              disabled={!anyOn}
              onClick={() => {
                if (window.confirm("시스템 관찰이 모은 기록(오류 요약·명령 모양·프로그램 시간·물어본 기록)을 모두 지울까요? 설정은 그대로입니다.")) {
                  setDigest(undefined);
                  void act(() => window.mate.systemClear());
                }
              }}
            >
              모은 기록 지우기
            </button>
            {view.analyzedAt && <span className="muted small-text">마지막 분석: {relativeTime(view.analyzedAt, now)}</span>}
          </div>
          {digest && (
            <pre className="system-digest" aria-label="모델에게 보낼 요약">
              {digest}
            </pre>
          )}

          {Object.values(view.problems).filter(Boolean).length > 0 && (
            <ul className="muted small-text">
              {Object.values(view.problems)
                .filter(Boolean)
                .map((p) => (
                  <li key={p}>⚠️ {p}</li>
                ))}
            </ul>
          )}

          {sys.health && (view.disks.length > 0 || view.failed.length > 0 || view.events.length > 0) && (
            <>
              <h3>시스템 건강</h3>
              <ul className="cards">
                {view.disks.map((d) => {
                  const pct = d.total > 0 ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
                  return (
                    <li key={d.mount} className="card">
                      <div className="card-head">
                        <span className={`chip ${pct >= 90 ? "warn" : ""}`}>디스크</span>
                        <strong className="title">{d.mount}</strong>
                        <span className="muted">
                          {pct}% 사용 · 남은 {(d.free / 1024 ** 3).toFixed(1)}GB
                        </span>
                      </div>
                    </li>
                  );
                })}
                {view.failed.map((f) => (
                  <li key={`${f.kind}:${f.name}`} className="card">
                    <div className="card-head">
                      <span className="chip warn">실패</span>
                      <strong className="title">{f.name}</strong>
                      <span className="muted">
                        {f.kind === "task" ? "예약 작업" : "서비스"} · {relativeTime(f.since, now)}부터
                      </span>
                    </div>
                  </li>
                ))}
                {view.events.slice(0, 10).map((e) => (
                  <li key={e.key} className="card">
                    <div className="card-head">
                      <span className={`chip ${e.level === "critical" ? "warn" : ""}`}>{e.level === "critical" ? "위험" : "오류"}</span>
                      <strong className="title">
                        {e.source} #{e.id}
                      </strong>
                      <span className="muted">
                        {Object.values(e.days).reduce((a, b) => a + b, 0)}회 · 마지막 {relativeTime(e.lastAt, now)}
                      </span>
                    </div>
                    {e.message && <div className="muted small-text">{e.message}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {sys.habits && (
            <>
              <h3>되풀이하는 작업</h3>
              {view.habits.length === 0 ? (
                <div className="muted small-text">
                  아직 찾지 못했습니다. 며칠 동안 같은 명령 묶음·요청을 되풀이하면 여기에 나오고, 임무로 만들지 대화로 묻습니다
                  {sys.shellHistory ? ` (지금까지 센 명령 ${view.shellCommands}개)` : ""}.
                </div>
              ) : (
                <ul className="cards">
                  {view.habits.map((h) => (
                    <li key={h.key} className="card">
                      <div className="card-head">
                        <span className="chip">{h.kind === "pi" ? "Pi 요청" : "명령"}</span>
                        <strong className="title">{h.label}</strong>
                        <span className="muted">
                          {h.span}일 중 {h.days}일{h.hour !== undefined ? ` · 주로 ${h.hour}시쯤` : ""}
                          {h.weekdays ? " · 평일" : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {sys.apps && (
            <>
              <h3>켜져 있던 프로그램{view.appsDate ? ` (${view.appsDate})` : ""}</h3>
              {view.apps.length === 0 ? (
                <div className="muted small-text">아직 모은 것이 없습니다.</div>
              ) : (
                <div className="kv">
                  {view.apps.map((a) => (
                    <FragmentRow key={a.name} label={a.name}>
                      {a.minutes >= 60 ? `${Math.floor(a.minutes / 60)}시간 ${a.minutes % 60}분` : `${a.minutes}분`}
                    </FragmentRow>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <span>{children}</span>
    </>
  );
}
