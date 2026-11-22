import { TOPIC_LABELS, type InsightTopic } from "@pi-desktop/mate-runner/activity-types";
import { useEffect, useState } from "react";
import type { Overview } from "../shared/api";
import type { Act } from "./App";
import { relativeTime } from "./mate-view";
import { pickFolder } from "./folder-pick";
import { SystemSection } from "./SystemSection";
import { ActivityRow, LivePanel } from "./ActivityLive";

/**
 * 활동 관찰 (설계 DESIGN-MATE.md §10, M4).
 * 켜면 Pi 세션 기록과 최근 작업한 저장소를 보고, 작업이 끝났을 때 도울 거리를 인박스에 남긴다.
 */
export function ActivityView({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const { observe } = overview.config;
  const view = overview.observe;
  const [quiet, setQuiet] = useState(String(observe.quietMinutes));
  const [limit, setLimit] = useState(String(observe.dailySuggestionLimit));
  useEffect(() => {
    setQuiet(String(observe.quietMinutes));
    setLimit(String(observe.dailySuggestionLimit));
  }, [observe.quietMinutes, observe.dailySuggestionLimit]);
  const sys = observe.system;
  // 활동 관찰이나 시스템 관찰 중 하나라도 켜져 있으면 "지금 관찰 중"과 활동 기록을 보인다
  const watching = observe.enabled || sys.health || sys.habits || sys.apps;
  const save = (patch: Partial<typeof observe>) => void act(() => window.mate.saveConfig({ observe: patch }));

  return (
    <>
    <section className="form">
      <label className="radio">
        <input type="checkbox" checked={observe.enabled} onChange={() => save({ enabled: !observe.enabled })} />
        <strong>활동 관찰</strong>
        <span className="muted">작업이 끝날 때마다 Mate가 도울 거리를 찾아 알려 줍니다</span>
      </label>
      <div className="muted small-text privacy">
        <div>
          <strong>보는 것</strong>: Pi Desktop·터미널 Pi·Pi Desktop Agent 세션 기록(요청, 고친 파일, 실패한 명령, 오류. 읽기만 함)과 최근 작업한 저장소의 git 상태. Mate 자신의 임무·대화도 활동에 남깁니다 (알림·"작업을 마치면" 계기에는 쓰지 않음).
        </div>
        <div>
          <strong>보지 않는 것</strong>: 화면, 키 입력, 다른 프로그램(아래 시스템 관찰을 따로 켜야 이름만 봅니다). 파일 내용·모델 답변은 기록하지 않고, 요청·명령은 앞부분만 남기며 비밀값처럼
          보이는 것은 가립니다. 기록은 이 PC의 Mate 데이터 폴더에만 있습니다.
        </div>
        <div>
          <strong>알리는 것</strong>: 연결 오류로 끝난 세션, push 안 한 커밋(하루), 커밋 안 한 변경(이틀)은 바로. 고치고 테스트를 안 돌림·같은 실패
          반복은 쉬는 때 관찰자가 살펴보고 필요할 때만. 계속 버리는 주제는 덜 알립니다.
        </div>
      </div>

      {watching && <LivePanel live={view.live} now={now} alive={overview.runner.alive} />}

      {view.failed.length > 0 && (
        <div className="card observe-failed" role="status">
          <div>
            <strong>제대로 살펴보지 못한 관찰 {view.failed.length}건</strong>
            <span className="muted small-text">
              {" "}
              관찰자 실행이 실패했습니다 (API 키 만료·로그인 끊김 등). 키를 고친 뒤 다시 살펴보세요.
              {view.retryAt ? ` 자동으로 ${relativeTime(view.retryAt, now)} 다시 합니다.` : " 세 번 실패해 자동으로는 다시 하지 않습니다."}
            </span>
          </div>
          <ul className="small-text">
            {view.failed.map((f, i) => (
              <li key={i}>
                {f.title}
                <span className="muted">
                  {" "}
                  · {TOPIC_LABELS[f.topic as InsightTopic] ?? f.topic} · {f.status} {f.attempts > 1 ? `${f.attempts}번` : ""}
                  {f.at ? ` · ${relativeTime(f.at, now)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="primary" disabled={!overview.runner.alive} onClick={() => void act(() => window.mate.observeRetry())}>
              다시 살펴보기
            </button>
            {!overview.runner.alive && <span className="muted small-text">실행기가 꺼져 있습니다</span>}
          </div>
        </div>
      )}

      {observe.enabled && (
        <>
          <div className="row">
            <label className="inline">
              조용한 시간(분)
              <input type="number" min={1} max={120} value={quiet} onChange={(e) => setQuiet(e.target.value)} onBlur={() => save({ quietMinutes: Number(quiet) })} />
            </label>
            <label className="inline">
              하루 제안 상한
              <input type="number" min={0} max={50} value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={() => save({ dailySuggestionLimit: Number(limit) })} />
            </label>
            <span className="muted small-text">
              오늘 {view.today.count}/{observe.dailySuggestionLimit}건 알림 · 관찰자 대기 {view.queue}건
            </span>
          </div>
          <ExcludedFolders excluded={observe.excluded} onChange={(excluded) => save({ excluded })} />

          <h2>배운 것</h2>
          {Object.keys(view.feedback).length === 0 ? (
            <div className="muted small-text">아직 관찰 제안에 대한 반응이 없습니다.</div>
          ) : (
            <div className="kv">
              {Object.entries(view.feedback).map(([topic, f]) => {
                const muted = f.dismissed >= 3 && f.accepted === 0;
                return (
                  <FragmentRow key={topic} label={TOPIC_LABELS[topic as InsightTopic] ?? topic}>
                    {f.shown}번 알림 · 받아들임 {f.accepted} · 버림 {f.dismissed}
                    {muted && <span className="chip warn">덜 알리는 중</span>}
                  </FragmentRow>
                );
              })}
            </div>
          )}

          {view.projects.length > 0 && (
            <>
              <h2>최근 작업한 저장소</h2>
              <ul className="cards">
                {view.projects.map((p) => (
                  <li key={p.cwd} className="card">
                    <div className="card-head">
                      <strong className="title">{p.cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)}</strong>
                      <span className="chip">{p.branch}</span>
                      <span className="muted small-text path">{p.cwd}</span>
                    </div>
                    <div className="duty-meta">
                      <span>{p.ahead === undefined ? "원격 브랜치 없음" : p.ahead > 0 ? `push 안 한 커밋 ${p.ahead}개` : "원격과 같음"}</span>
                      <span>{p.dirty > 0 ? `커밋 안 한 파일 ${p.dirty}개${p.dirtySince ? ` (${relativeTime(p.dirtySince, now)}부터)` : ""}` : "변경 없음"}</span>
                      <span className="muted">확인: {relativeTime(p.checkedAt, now)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

        </>
      )}
    </section>
    <SystemSection overview={overview} now={now} act={act} />
    {watching && (
      <section className="form">
        <h2>최근 활동</h2>
        {view.activity.length === 0 && (
          <div className="muted small-text">
            아직 기록이 없습니다. Pi Desktop·터미널 Pi·Agent로 작업하고 {observe.quietMinutes}분 쉬거나, 시스템 관찰에서 새로 본 것이 있으면 여기에 나타납니다.
          </div>
        )}
        <ul className="cards">
          {view.activity.map((record, i) => (
            <ActivityRow key={i} record={record} now={now} />
          ))}
        </ul>
        <div className="muted small-text">줄을 누르면 요청·쓴 도구·명령 같은 자세한 내용을 펼칩니다.</div>
      </section>
    )}
    </>
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

function ExcludedFolders({ excluded, onChange }: { excluded: string[]; onChange: (excluded: string[]) => void }) {
  return (
    <div className="excluded">
      <span>관찰하지 않을 폴더</span>
      {excluded.length === 0 && <span className="muted small-text">없음 (모든 Pi 세션)</span>}
      {excluded.map((folder) => (
        <span key={folder} className="chip">
          {folder}{" "}
          <button className="link" onClick={() => onChange(excluded.filter((f) => f !== folder))} title="빼기">
            ×
          </button>
        </span>
      ))}
      <button
        className="small"
        onClick={async () => {
          const dir = await pickFolder();
          if (dir && !excluded.includes(dir)) onChange([...excluded, dir]);
        }}
      >
        폴더 추가
      </button>
    </div>
  );
}
