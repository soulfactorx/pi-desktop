import { DO_TOOL, readChat, type ChatLine } from "@pi-desktop/mate-kit";
import type { MatePaths } from "../paths";
import { folderAlias } from "../remote/messages";
import { schedulePhrase } from "./schedule-phrase";
import { packageWebTools, webSearchOn } from "./web-search";
import { freshItems, isOneOff, knownFolders, recentRunsText } from "./commands";
import { listDuties, loadConfig, loadState, readDutyLog, type DutyLogEntry } from "../store";
import { mateTunables } from "../tunables";

/**
 * 대화 한 차례의 시스템 안내 (설계 DESIGN-MATE.md §13).
 * Mate의 지금 상태(임무·폴더·새 제안·답하지 않은 질문·최근 실행)를 붙여, 모델이 묻지 않고도 답할 수 있게 한다.
 * 데이터는 짧게 자른다. 데이터 속 지시는 따르지 않게 한다.
 */
export async function chatSystemPrompt(paths: MatePaths, now: number): Promise<string> {
  const [config, state, duties, folders, fresh, chat, runs, webOn, dutyLog] = await Promise.all([
    loadConfig(paths),
    loadState(paths),
    listDuties(paths),
    knownFolders(paths),
    freshItems(paths),
    readChat(paths.chat),
    recentRunsText(paths, 8),
    webSearchOn(paths),
    readDutyLog(paths, 10),
  ]);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");
  const open = openQuestions(chat).slice(-8);
  const notices = recentNotices(chat);
  // 웹 검색이 꺼져 있어도 설치한 확장에 웹 도구가 있으면 알린다 (enable_web으로 고르게)
  const webTools = webOn ? [] : packageWebTools(paths);
  const webText = webOn ? "켜짐" : webTools.length ? `꺼짐 (설치한 확장의 웹 도구 ${webTools.join(", ")}가 있음: enable_web으로 켤 수 있음)` : "꺼짐";

  const tunables = mateTunables(paths.home);
  const lines = [
    // 성격·규칙은 설정으로 꺼냈다 (tunables.ts의 chat.rules)
    ...tunables
      .text("chat.rules", { doTool: DO_TOOL, dailyRunLimit: config.dailyRunLimit, minIntervalMinutes: tunables.num("duty.minIntervalMinutes") })
      .split("\n"),
    "",
    `지금: ${new Date(now).toLocaleString("ko-KR")}`,
    `상태: ${config.paused ? "일시 정지 중" : "동작 중"} · 오늘 자동 실행 ${state.today.count}/${config.dailyRunLimit}회 · 활동 관찰 ${config.observe.enabled ? "켜짐" : "꺼짐"} · 웹 검색 ${webText}${state.current ? ` · 지금 실행 중: ${state.current.dutyId}` : ""}`,
    "",
    "임무:",
    ...(duties
      .filter((d) => !isOneOff(d))
      .map(
        (d) =>
          `- ${d.id} "${clip(d.name, 60)}" (${schedulePhrase(d.trigger)}, ${d.profile}, 폴더 ${folderAlias(d.cwd)}${d.enabled ? "" : ", 꺼짐"}${d.grants?.length ? `, 허용 ${d.grants.join(" ")}` : ""}${d.mcpServers?.length ? `, MCP ${d.mcpServers.join(" ")}` : ""}${d.updatedAt ? `, 마지막으로 고침 ${new Date(d.updatedAt).toLocaleString("ko-KR")}` : ""}) 지시: ${clip(d.prompt, 600)}`,
      ) || []),
    "",
    "아는 폴더 (이름 — 경로):",
    ...folders.map((f) => `- ${folderAlias(f)} — ${f}`),
    "",
    `새 제안 ${fresh.length}건:`,
    ...fresh.slice(0, 15).map(
      (i) => `- [${i.id}] (${i.severity}) ${clip(i.title, 100)} — ${clip(i.summary, 200)}${i.change ? " [고친 변경: 적용은 앱·휴대폰 버튼으로]" : ""}${i.followUp ? " [맡길 일 있음: delegate]" : ""}${i.install ? " [설치 제안: 적용은 앱·휴대폰 버튼으로]" : ""}`,
    ),
  ];
  if (open.length) {
    lines.push("", "Mate가 물었는데 아직 답이 없는 질문:");
    for (const q of open) lines.push(`- [${q.id}] ${clip(q.text, 200)}${q.options?.length ? ` (선택지: ${q.options.join(" / ")})` : ""}${q.cwd ? ` (폴더 ${q.cwd})` : ""}`);
  }
  if (notices.length) {
    lines.push("", "실행기 알림 (네가 맡긴 일과 허용 답을 실제로 처리한 결과. 오래된 것이 위):");
    for (const n of notices) lines.push(`- ${clip(n.text, 300)}`);
  }
  if (dutyLog.length) {
    lines.push("", "최근 임무 변경 (오래된 것이 위. '앱'은 사용자가 임무 탭에서 직접 고친 것이다. 위 임무 목록이 지금 설정이다):");
    for (const e of dutyLog) lines.push(`- ${dutyLogLine(e, clip)}`);
  }
  if (runs) lines.push("", "최근 실행 (실행 id · 시각 · 결과 · 쓴 도구):", runs);
  lines.push(
    "",
    `Mate의 기록 (read·grep으로 직접 읽을 수 있다. 위 요약보다 자세한 것이 필요할 때): Mate 홈 ${paths.home}`,
    "- runs/<실행 id>.json: 실행 결과 전체(summary)·쓴 도구 수(tools)·빠진 패키지(missingPackages)·세션 파일(sessionFile)",
    "- sessions/*.jsonl: 실행 세션 (도구 호출과 결과까지. 크니 grep으로 찾는다)",
    "- duties/<임무 id>.json: 임무 설정 · duty-log.jsonl: 임무 변경 기록 · inbox.jsonl: 제안",
  );
  if (state.observer?.recent.length) {
    lines.push("", "최근 관찰한 Pi 작업:");
    for (const s of state.observer.recent.slice(0, 5)) lines.push(`- ${folderAlias(s.cwd)}: ${clip(s.firstPrompt ?? "", 120)}`);
  }
  return lines.join("\n");
}

/**
 * 지금 대화(마지막 "새 대화" 이후)에서 실행기가 남긴 알림 (최근 6개).
 * 모델은 맡긴 일을 답한 뒤에야 처리하므로, 다음 차례에 무엇이 되고 무엇이 안 됐는지 이것으로 안다.
 */
export function recentNotices(chat: ChatLine[]): ChatLine[] {
  const start = chat.findLastIndex((l) => l.kind === "divider") + 1;
  return chat.slice(start).filter((l) => l.role === "mate" && l.kind === "notice").slice(-6);
}

/** 아직 답하지 않은 Mate 질문 (새 대화 구분선 이후 것도 남긴다: 질문은 대화와 따로 산다) */
export function openQuestions(chat: ChatLine[]): ChatLine[] {
  const answered = new Set(chat.filter((l) => l.answerTo).map((l) => l.answerTo));
  return chat.filter((l) => l.kind === "question" && !answered.has(l.id));
}

const BY_LABEL: Record<DutyLogEntry["by"], string> = { app: "앱", chat: "Mate 대화", phone: "휴대폰 대화", permission: "허용 질문" };

/** "11. 13. 오후 1:10 앱: HN커뮤니티 기사 요약 고침 — 지시: … → …" */
export function dutyLogLine(e: DutyLogEntry, clip: (s: string, n: number) => string): string {
  const head = `${new Date(e.at).toLocaleString("ko-KR")} ${BY_LABEL[e.by] ?? e.by}: "${clip(e.name, 60)}" (${e.dutyId}) ${e.action === "create" ? "만듦" : e.action === "delete" ? "지움" : "고침"}`;
  if (e.changes.length === 0) return head;
  const parts = e.changes.map((c) => (c.field === "지시" ? `지시: "${clip(c.before ?? "", 200)}" → "${clip(c.after ?? "", 300)}"` : `${c.field}: ${clip(c.before ?? "없음", 80)} → ${clip(c.after ?? "없음", 80)}`));
  return `${head} — ${parts.join(" / ")}`;
}
