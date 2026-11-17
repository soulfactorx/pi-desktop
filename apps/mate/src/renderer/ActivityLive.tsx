import {
  LIVE_SOURCE_LABELS,
  SESSION_APP_LABELS,
  SYSTEM_EVENT_LABELS,
  TOPIC_LABELS,
  type InsightTopic,
  type LiveSource,
  type LiveView,
} from "@pi-desktop/mate-runner/activity-types";
import { useState } from "react";
import type { ActivityRecord } from "../shared/api";
import { relativeTime } from "./mate-view";

/**
 * 활동 탭의 "지금 관찰 중"과 자세한 활동 기록 (설계 DESIGN-MATE.md §10.2).
 * 실행기가 30초마다 관찰하며 출처별로 남긴 한 줄을 보이고, 활동 탭을 보는 동안은 몇 초마다 다시 읽는다.
 */

const ORDER: LiveSource[] = ["sessions", "projects", "health", "history", "apps", "analysis"];

function folderName(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? cwd;
}

/** "3분 뒤", "곧" */
function until(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  if (s <= 30) return "곧";
  if (s < 3600) return `${Math.round(s / 60)}분 뒤`;
  return `${Math.round(s / 3600)}시간 뒤`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function LivePanel({ live, now, alive }: { live: LiveView; now: number; alive: boolean }) {
  const steps = ORDER.flatMap((key) => (live.steps[key] ? [[key, live.steps[key]!] as const] : []));
  const fresh = live.tickAt > 0 && now - live.tickAt < 90_000;
  return (
    <section className="live-panel" aria-live="polite">
      <div className="live-head">
        <span className={`live-dot ${alive && fresh ? "on" : "off"}`} aria-hidden="true" />
        <strong>지금 관찰 중</strong>
        <span className="muted small-text">
          {!alive ? "실행기가 꺼져 있어 관찰하지 않습니다" : live.tickAt ? `마지막 확인 ${relativeTime(live.tickAt, now)} · 30초마다 확인` : "첫 확인을 기다리는 중"}
        </span>
      </div>
      {live.doing && (
        <div className="live-doing">
          <span className="spinner" aria-hidden="true" /> {live.doing.what} ({duration(now - live.doing.since)}째)
        </div>
      )}
      {live.running && (
        <div className="live-doing">
          <span className="spinner" aria-hidden="true" /> 관찰자가 살펴보는 중: {live.running.cause} ({duration(now - live.running.since)}째)
        </div>
      )}
      {steps.length > 0 && (
        <table className="live-steps">
          <tbody>
            {steps.map(([key, step]) => (
              <tr key={key} className={step.ok ? undefined : "bad"}>
                <th scope="row">{LIVE_SOURCE_LABELS[key]}</th>
                <td>{step.note}</td>
                <td className="muted nowrap">{step.at > 0 ? relativeTime(step.at, now) : "아직"}</td>
                <td className="muted nowrap">{step.next ? `다음 ${until(step.next, now)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {live.active.length > 0 && (
        <>
          <h3>진행 중인 Pi 작업</h3>
          <ul className="cards">
            {live.active.map((a, i) => (
              <li key={`${a.cwd}-${i}`} className="card activity">
                <div className="card-head">
                  <span className="chip warn">진행 중</span>
                  {a.app && <span className={`chip app-${a.app}`}>{SESSION_APP_LABELS[a.app]}</span>}
                  <strong className="title">{a.firstPrompt ?? "(요청 없음)"}</strong>
                  <span className="muted">{folderName(a.cwd)}</span>
                </div>
                <div className="duty-meta">
                  <span>요청 {a.prompts}번</span>
                  {a.tools > 0 && <span>도구 {a.tools}번</span>}
                  <span>마지막 활동 {relativeTime(a.lastAt, now)}</span>
                  <span className="muted">조용하면 {until(a.endsAt, now)} "작업 끝"으로 봄</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {live.queue.length > 0 && (
        <>
          <h3>관찰자가 살펴볼 차례</h3>
          <ul className="small-text">
            {live.queue.map((q, i) => (
              <li key={i}>
                {TOPIC_LABELS[q.topic as InsightTopic] ?? q.topic}: {q.title} <span className="muted">({folderName(q.cwd)})</span>
              </li>
            ))}
          </ul>
          <div className="muted small-text">사용자가 쉬는 때(진행 중인 작업이 없을 때) 하나씩 살펴봅니다.</div>
        </>
      )}
    </section>
  );
}

/** 활동 기록 한 줄. 누르면 자세히 펼친다 */
export function ActivityRow({ record, now }: { record: ActivityRecord; now: number }) {
  const [open, setOpen] = useState(false);
  const head = (chip: React.ReactNode, title: React.ReactNode, meta: React.ReactNode, hasDetails: boolean) => (
    <div
      className={`card-head${hasDetails ? " clickable" : ""}`}
      {...(hasDetails ? { role: "button", tabIndex: 0, "aria-expanded": open, onClick: () => setOpen((v) => !v), onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && setOpen((v) => !v) } : {})}
    >
      {chip}
      <strong className="title">{title}</strong>
      <span className="muted">
        {meta}
        {hasDetails && <span className="expand-mark"> {open ? "▾" : "▸"}</span>}
      </span>
    </div>
  );

  if (record.kind === "session-ended") {
    const s = record.session;
    const folder = folderName(s.cwd);
    // Mate 대화는 Mate 홈의 chat 폴더에서 연다
    const name = s.app === "mate" && folder === "chat" ? "Mate 대화" : folder;
    const tools = Object.entries(s.tools ?? {}).sort((a, b) => b[1] - a[1]);
    const hasDetails = Boolean(s.promptLog?.length || tools.length || s.commandLog?.length || s.editedFiles.length || s.failures.length);
    return (
      <li className="card activity">
        {head(
          <>
            <span className="chip">작업 끝</span>
            {s.app && <span className={`chip app-${s.app}`}>{SESSION_APP_LABELS[s.app]}</span>}
          </>,
          s.firstPrompt ?? "(요청 없음)",
          `${name} · ${relativeTime(record.at, now)}`,
          hasDetails,
        )}
        <div className="duty-meta">
          <span>요청 {s.prompts}번</span>
          <span>{duration(s.lastAt - s.startedAt)}</span>
          {s.editedFiles.length > 0 && <span title={s.editedFiles.join("\n")}>고친 파일 {s.editedFiles.length}개</span>}
          {s.commands > 0 && <span>명령 {s.commands}번{s.ranTests ? " (테스트 포함)" : ""}</span>}
          {s.failures.length > 0 && <span className="bad-text" title={s.failures.join("\n")}>실패 {s.failures.length}번</span>}
          {s.modelErrors.length > 0 && <span className="bad-text">모델 오류: {s.modelErrors.at(-1)}</span>}
          {s.model && <span className="muted">{s.model}</span>}
          {s.tokens ? <span className="muted">{s.tokens.toLocaleString("ko-KR")} 토큰{s.costUsd ? ` · $${s.costUsd.toFixed(3)}` : ""}</span> : null}
        </div>
        {open && (
          <div className="activity-details small-text">
            {s.promptLog && s.promptLog.length > 0 && (
              <Detail label={`요청 (${s.promptLog.length}${s.prompts > s.promptLog.length ? `/${s.prompts}` : ""})`}>
                <ol>
                  {s.promptLog.map((p, i) => (
                    <li key={i}>
                      <span className="muted">{new Date(p.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span> {p.text}
                    </li>
                  ))}
                </ol>
              </Detail>
            )}
            {tools.length > 0 && <Detail label="쓴 도구">{tools.map(([name, n]) => `${name} ${n}`).join(" · ")}</Detail>}
            {s.editedFiles.length > 0 && <Detail label="고친 파일">{s.editedFiles.join(", ")}</Detail>}
            {s.commandLog && s.commandLog.length > 0 && (
              <Detail label="명령">
                <ul className="mono">
                  {s.commandLog.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </Detail>
            )}
            {s.failures.length > 0 && (
              <Detail label="실패한 명령">
                <ul className="mono bad-text">
                  {s.failures.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </Detail>
            )}
            <div className="muted">요청·명령은 앞부분만, 비밀값은 가려서 남깁니다. 모델 답변은 남기지 않습니다.</div>
          </div>
        )}
      </li>
    );
  }
  if (record.kind === "suggested") {
    return (
      <li className="card activity">
        {head(<span className="chip sev-info">알림</span>, record.title, `${TOPIC_LABELS[record.topic as InsightTopic] ?? record.topic} · ${record.via === "rule" ? "규칙" : "관찰자"} · ${relativeTime(record.at, now)}`, false)}
      </li>
    );
  }
  if (record.kind === "system") {
    const details = record.details ?? [];
    return (
      <li className="card activity">
        {head(<span className="chip">{SYSTEM_EVENT_LABELS[record.what] ?? record.what}</span>, record.title, relativeTime(record.at, now), details.length > 0)}
        {open && details.length > 0 && (
          <ul className="activity-details small-text">
            {details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </li>
    );
  }
  if (record.kind === "observer-run") {
    return (
      <li className="card activity">
        {head(
          <span className={`chip ${record.status === "done" ? "" : "warn"}`}>관찰자 실행</span>,
          record.cause,
          `${record.status === "done" ? `제안 ${record.proposals}개` : record.status} · ${duration(record.durationMs)}${record.costUsd ? ` · $${record.costUsd.toFixed(3)}` : ""} · ${relativeTime(record.at, now)}`,
          false,
        )}
      </li>
    );
  }
  return null;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail">
      <strong>{label}</strong>
      <div>{children}</div>
    </div>
  );
}
