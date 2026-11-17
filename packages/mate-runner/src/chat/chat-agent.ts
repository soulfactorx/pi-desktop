import { packageDirs, packageToolNames } from "@pi-desktop/pi-resources";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { appendChat, appendChatQuestion, CONFIRM_OPTIONS, extensionEntries, isToolGrant, PERMISSION_OPTIONS, readChat, readChatActions, readInbox, type ChatLine } from "@pi-desktop/mate-kit";
import { applySetting, applyTunable, settingRisk, tunableRisk, writeGuide } from "./settings";
import { delegateInboxItem } from "../delegate";
import { isolationDirOf, runPi as defaultRunPi, type PiLaunch } from "../executor";
import type { MatePaths } from "../paths";
import { folderAlias, parseCommand } from "../remote/messages";
import { addRequest, deleteDuty, dutyIdFrom, listDuties, listRuns, loadConfig, readJson, saveConfig, saveDuty, setInboxStatus, writeJsonAtomic } from "../store";
import { enableWebSearch, webChoices, webSearchOn, webSetup } from "./web-search";
import { localDateKey } from "../schedule";
import { CHAT_DUTY_ID, type Duty } from "../types";
import { askPermission } from "../permission";
import type { Exec } from "../watchers";
import { COMMAND_HELP, findDuty, findFolder, instruct, runCommand, type ChatSource, type CommandContext } from "./commands";
import { chatImagesOf, removeChatImages } from "./chat-images";
import { chatPromptParts, openQuestions } from "./context";
import { parseSchedulePhrase } from "./schedule-phrase";
import { mateDefault, mateTunables } from "../tunables";

/**
 * Mate 대화 담당 (설계 DESIGN-MATE.md §13).
 * 앱(chat/requests 폴더)과 휴대폰(submit)에서 온 말을 한 번에 하나씩 처리한다. 임무 실행과 따로 돈다.
 * "/" 명령은 모델 없이 바로 답하고, 그 밖의 말은 Pi(대화 권한: 읽기 + mate_do)로 답한다.
 * 같은 Pi 세션(mate-chat-<번호>)을 이어 써서 앞의 말을 기억한다. "새 대화"는 번호를 올린다.
 * mate_do로 맡긴 일은 답한 뒤 처리하고, 시작한 실행이 끝나면 결과를 대화에 남긴다.
 */

export interface ChatRequest {
  text: string;
  source: ChatSource;
  /** Mate 질문에 대한 답이면 그 질문 줄 id */
  answerTo?: string;
  /** 앱이 사용자 줄을 이미 남겼으면 그 id (없으면 여기서 남김) */
  lineId?: string;
  /** 함께 보낸 이미지 파일 (Mate 홈의 chat/images 안. 답한 뒤 지운다) */
  images?: string[];
}

/** chat/state.json (실행기가 씀, 앱은 읽기만) */
export interface ChatState {
  /** 대화 번호. Pi 세션 id가 mate-chat-<번호> */
  epoch: number;
  /** 지금 답을 만드는 중 */
  busy?: { since: number; source: ChatSource };
  /** 대화에서 시작한 실행: 임무 id → 요청 시각·출처 (끝나면 결과를 남긴다) */
  pending: Record<string, { at: number; source: ChatSource }>;
  /** 오늘 대화 비용 */
  cost?: { date: string; usd: number };
}

export interface ChatAgentOptions {
  paths: MatePaths;
  kitDir: string;
  locatePi: () => Promise<PiLaunch>;
  exec: Exec;
  log: (message: string) => void;
  now?: () => number;
  /** 테스트에서 바꿔 끼움 */
  runPi?: typeof defaultRunPi;
}

const TICK_MS = Number(process.env.PI_DESKTOP_MATE_CHAT_TICK_MS) || mateDefault<number>("chat.tickMs");

export async function loadChatState(paths: MatePaths): Promise<ChatState> {
  const raw = await readJson<Partial<ChatState>>(paths.chatState, {});
  return { epoch: raw.epoch ?? 1, pending: raw.pending ?? {}, ...(raw.busy ? { busy: raw.busy } : {}), ...(raw.cost ? { cost: raw.cost } : {}) };
}

/** 앱이 대화 요청을 넣는다 (사용자 줄은 앱이 먼저 남김) */
export async function addChatRequest(paths: MatePaths, request: ChatRequest, now = Date.now()): Promise<void> {
  await mkdir(paths.chatRequests, { recursive: true });
  await writeJsonAtomic(join(paths.chatRequests, `${now}-${Math.random().toString(36).slice(2, 8)}.json`), request);
}

export class ChatAgent {
  private state: ChatState = { epoch: 1, pending: {} };
  private queue: ChatRequest[] = [];
  private working = false;
  private timer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private abort = new AbortController();
  /** 지금 답하는 사용자의 요청 (웹 검색을 켠 뒤 다시 답할 때) */
  private currentRequest: string | undefined;
  private readonly listeners = new Set<(line: ChatLine) => void>();

  constructor(private readonly options: ChatAgentOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async start(): Promise<void> {
    const { paths } = this.options;
    await mkdir(paths.chatRequests, { recursive: true });
    await mkdir(paths.chatSessions, { recursive: true });
    this.state = await loadChatState(paths);
    // 지난번 실행기가 답하는 도중 끝났으면 그 표시는 지운다
    delete this.state.busy;
    await this.save();
    try {
      this.watcher = watch(paths.chatRequests, () => void this.pump());
    } catch {
      // 감시를 못 해도 주기 확인으로 처리된다
    }
    this.timer = setInterval(() => {
      void this.pump();
      void this.checkPending();
    }, TICK_MS);
    void this.pump();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.abort.abort();
  }

  /** 새 대화 줄이 생길 때마다 알린다 (휴대폰으로 바로 보내도록) */
  onLine(listener: (line: ChatLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.working;
  }

  /** 휴대폰 등 같은 프로세스에서 온 말 */
  submit(request: ChatRequest): void {
    this.queue.push(request);
    void this.pump();
  }

  /** 받은 말을 다 처리할 때까지 기다린다 (테스트용) */
  async whenIdle(): Promise<void> {
    while (this.working || this.queue.length > 0) await new Promise((r) => setTimeout(r, 10));
  }

  /** 받은 말을 모두 처리할 때까지 돈다 */
  async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        this.queue.push(...(await this.takeFileRequests()));
        const next = this.queue.shift();
        if (!next) break;
        await this.handle(next).catch((error: Error) => {
          this.options.log(`chat error ${error.stack ?? error.message}`);
          return this.say(next.source, `⚠️ 처리하지 못했어요: ${error.message}`, "notice");
        });
        await removeChatImages(next.images);
      }
    } finally {
      this.working = false;
    }
  }

  private async takeFileRequests(): Promise<ChatRequest[]> {
    const dir = this.options.paths.chatRequests;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const out: ChatRequest[] = [];
    for (const name of names) {
      const file = join(dir, name);
      const raw = await readJson<Partial<ChatRequest> | undefined>(file, undefined);
      await rm(file, { force: true });
      if (raw && typeof raw.text === "string" && raw.text.trim()) {
        out.push({
          text: raw.text.trim().slice(0, 4000),
          source: raw.source === "telegram" ? "telegram" : "app",
          ...(typeof raw.answerTo === "string" ? { answerTo: raw.answerTo } : {}),
          ...(typeof raw.lineId === "string" ? { lineId: raw.lineId } : {}),
          ...(chatImagesOf(this.options.paths, raw.images).length ? { images: chatImagesOf(this.options.paths, raw.images) } : {}),
        });
      } else await removeChatImages(chatImagesOf(this.options.paths, raw?.images));
    }
    return out;
  }

  private async append(line: Omit<ChatLine, "id" | "at">): Promise<ChatLine> {
    const full = await appendChat(this.options.paths.chat, { ...line, at: this.now() });
    for (const listener of this.listeners) listener(full);
    return full;
  }

  private say(source: ChatSource, text: string, kind: ChatLine["kind"] = "reply", extra: Partial<ChatLine> = {}): Promise<ChatLine> {
    return this.append({ role: "mate", kind, text, source, ...extra });
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.options.paths.chatState, this.state);
  }

  private commandContext(source: ChatSource, allowFix: boolean): CommandContext {
    return {
      paths: this.options.paths,
      exec: this.options.exec,
      now: () => this.now(),
      track: (dutyId, s) => this.track(dutyId, s),
      source,
      allowFix,
    };
  }

  private async allowFix(source: ChatSource): Promise<boolean> {
    return source === "app" || (await loadConfig(this.options.paths)).telegram.allowFix;
  }

  private async handle(request: ChatRequest): Promise<void> {
    if (!request.lineId) {
      await this.append({ role: "user", text: request.text, source: request.source, ...(request.answerTo ? { answerTo: request.answerTo } : {}) });
    }
    const text = request.text.trim();
    if (request.answerTo && (await this.answerPermission(request))) return;
    if (request.answerTo && (await this.answerConfirm(request))) return;
    // 허용 질문에 답하지 않고 다음 말을 했으면 그 질문은 닫는다 (답하지 않은 질문 배지가 계속 남지 않게)
    if (!request.answerTo) await this.expireQuestions(request.source);
    if (text.startsWith("/")) {
      const command = parseCommand(text);
      if (command && command.kind !== "chat") {
        if (command.kind === "new") return this.newConversation(request.source);
        if (command.kind === "start") return void (await this.say(request.source, COMMAND_HELP));
        const ctx = this.commandContext(request.source, await this.allowFix(request.source));
        return void (await this.say(request.source, await runCommand(ctx, command)));
      }
    }
    await this.think(request);
  }

  /**
   * 막힌 명령의 허용 질문에 답했으면 모델을 거치지 않고 바로 처리한다 (설계 §4 "권한 요청").
   * 허용하면 임무에 그 명령을 더하고 다시 실행하며, 끝나면 결과를 이 대화 출처로 알린다.
   * @returns 처리했으면 true. 허용 질문이 아니거나 예·아니요로 읽을 수 없는 답이면 false (모델이 답한다)
   */
  private async answerPermission(request: ChatRequest): Promise<boolean> {
    const { paths } = this.options;
    const lines = await readChat(paths.chat);
    const question = lines.find((l) => l.id === request.answerTo);
    const permission = question?.permission;
    if (!question || !permission) return false;
    // 넘어가서 닫힌 질문: 휴대폰에 남은 버튼 등으로 뒤늦게 답해도 처리하지 않는다
    if (lines.some((l) => l.kind === "expire" && l.answerTo === question.id)) {
      await this.say(request.source, "지난 질문이라 처리하지 않았어요. 필요하면 다시 말씀해 주세요. 다시 막히면 그때 다시 물어요.", "notice");
      return true;
    }
    const text = request.text.trim();
    // 선택지가 여럿인 질문(웹 검색을 어떤 방법으로 켤지)은 고른 것만 허용한다. 번호로 답해도 된다
    const choices = permission.choices ?? [];
    const picked = choices.find((c) => c.label === text) ?? (/^\d+$/.test(text) ? choices[Number(text) - 1] : undefined);
    const allow = choices.length ? Boolean(picked) : text === PERMISSION_OPTIONS[0] || /^(예|네|응|허용(?!하지|\s*안)|(yes|y|ok)(\s|$))/i.test(text);
    const deny = text === PERMISSION_OPTIONS[1] || /^(아니|아뇨|거절|허용하지|허용\s*안|(no|n)(\s|$))/i.test(text);
    if (!allow && !deny) return false;
    if (picked) Object.assign(permission, { commands: picked.commands, ...(picked.mcpServers ? { mcpServers: picked.mcpServers } : {}) });
    // 버튼을 두 번 눌렀거나 앱·휴대폰에서 함께 답했으면 처음 답만 따른다
    if (lines.filter((l) => l.answerTo === question.id && l.role === "user").length > 1) {
      await this.say(request.source, "이미 답한 질문이에요.", "notice");
      return true;
    }
    if (deny) {
      await this.say(request.source, `알겠어요. ${permission.commands.join(", ")}은(는) 허용하지 않았어요.`, "notice");
      return true;
    }
    if (permission.dutyId === CHAT_DUTY_ID) {
      // 대화에서 막힌 MCP 도구(또는 "웹 검색 켜기"): 설정에 더한다. 물었던 요청이 있으면 바로 다시 답한다
      if (permission.mcpServers?.length) await enableWebSearch(paths, permission.mcpServers);
      const config = await loadConfig(paths);
      await saveConfig(paths, {
        chatGrants: [...new Set([...config.chatGrants, ...permission.commands.filter(isToolGrant)])],
        ...(permission.mcpServers?.length ? { chatMcpServers: [...new Set([...config.chatMcpServers, ...permission.mcpServers])] } : {}),
      });
      this.options.log(`chat permission granted chat tools=${permission.commands.join(",")} servers=${(permission.mcpServers ?? []).join(",")}`);
      const done = permission.mcpServers?.length || picked ? "✅ 웹 검색을 켰어요." : `✅ 대화에서 ${permission.commands.join(", ")}을(를) 허용했어요.`;
      if (!permission.retry) {
        await this.say(request.source, `${done} 다시 말씀해 주시면 써 볼게요.`, "notice");
        return true;
      }
      await this.say(request.source, `${done} 방금 요청에 다시 답할게요.`, "notice");
      await this.think({ text: permission.retry, source: request.source, lineId: question.id });
      return true;
    }
    const duty = (await listDuties(paths)).find((d) => d.id === permission.dutyId);
    if (!duty) {
      await this.say(request.source, "그 임무가 이제 없어요.", "notice");
      return true;
    }
    const grants = [...new Set([...(duty.grants ?? []), ...permission.commands])];
    await saveDuty(paths, { ...duty, grants, updatedAt: this.now() }, "permission");
    await addRequest(paths, duty.id, this.now());
    await this.track(duty.id, request.source);
    this.options.log(`chat permission granted duty=${duty.id} commands=${permission.commands.join(",")}`);
    await this.say(request.source, `✅ "${duty.name}" 임무에 ${permission.commands.join(", ")}을(를) 허용했어요. 다시 실행하고, 끝나면 알려 드릴게요.`, "notice");
    return true;
  }

  /**
   * 대화가 맡긴 변경 중 확인이 필요했던 것(설정 상한 올리기·관찰 켜기·임무 지우기 등)에 답했으면 모델을 거치지 않고 처리한다.
   * @returns 처리했으면 true. 확인 질문이 아니거나 예·아니요로 읽을 수 없는 답이면 false
   */
  private async answerConfirm(request: ChatRequest): Promise<boolean> {
    const lines = await readChat(this.options.paths.chat);
    const question = lines.find((l) => l.id === request.answerTo);
    const confirm = question?.confirm;
    if (!question || !confirm) return false;
    if (lines.some((l) => l.kind === "expire" && l.answerTo === question.id)) {
      await this.say(request.source, "지난 질문이라 바꾸지 않았어요. 필요하면 다시 말씀해 주세요.", "notice");
      return true;
    }
    const text = request.text.trim();
    const yes = text === CONFIRM_OPTIONS[0] || /^(예|네|응|바꿔|바꾸기|좋아|(yes|y|ok)(\s|$))/i.test(text);
    const no = text === CONFIRM_OPTIONS[1] || /^(아니|아뇨|그만|취소|(no|n)(\s|$))/i.test(text);
    if (!yes && !no) return false;
    if (lines.filter((l) => l.answerTo === question.id && l.role === "user").length > 1) {
      await this.say(request.source, "이미 답한 질문이에요.", "notice");
      return true;
    }
    if (no) {
      await this.say(request.source, "알겠어요. 바꾸지 않았어요.", "notice");
      return true;
    }
    const note = await this.doAction(confirm.action, request.source, true).catch((error: Error) => `⚠️ ${error.message}`);
    this.options.log(`chat confirm applied ${String(confirm.action.action)}`);
    await this.say(request.source, note, "notice");
    return true;
  }

  /** 확인이 필요한 변경: 바로 하지 않고 [바꾸기]/[그만]으로 묻는다 */
  private async askConfirm(action: Record<string, unknown>, reason: string, what: string): Promise<string> {
    const text = `${what}\n${reason}. 바꿀까요?`;
    const asked = await appendChatQuestion(this.options.paths.chat, { text, options: [...CONFIRM_OPTIONS], dutyId: CHAT_DUTY_ID, confirm: { action, reason } }, this.now());
    return asked ? `❓ ${what}: 위의 질문에서 바꿀지 골라 주세요.` : `❓ ${what}: 바꿀지 묻는 질문이 이미 있어요.`;
  }

  /**
   * 답하지 않은 허용 질문(permission)을 닫는다. 화면에 보이지 않는 expire 줄을 남겨 답한 것으로 친다.
   * 같은 것이 다시 막히면 그때 다시 묻는다 (appendChatQuestion은 답한 질문을 중복으로 보지 않는다).
   * mate_ask로 물은 일반 질문은 대화 흐름과 상관없으니 그대로 둔다.
   */
  private async expireQuestions(source: ChatSource): Promise<void> {
    const open = openQuestions(await readChat(this.options.paths.chat)).filter((q) => q.permission || q.confirm);
    for (const q of open) await this.append({ role: "mate", kind: "expire", text: "답하지 않고 넘어감", source, answerTo: q.id });
    if (open.length) this.options.log(`chat expired questions ${open.map((q) => q.id).join(",")}`);
  }

  async newConversation(source: ChatSource): Promise<void> {
    this.state.epoch += 1;
    await this.save();
    await this.append({ role: "mate", kind: "divider", text: "새 대화", source });
  }

  /** 모델로 답한다 */
  private async think(request: ChatRequest): Promise<void> {
    const { paths } = this.options;
    const now = this.now();
    this.currentRequest = request.text;
    this.state.busy = { since: now, source: request.source };
    await this.save();
    try {
      const config = await loadConfig(paths);
      let prompt = request.text;
      if (request.answerTo) {
        const q = (await readChat(paths.chat)).find((l) => l.id === request.answerTo);
        if (q) prompt = `(Mate가 물었던 질문 "${q.text}"${q.cwd ? ` — 폴더 ${q.cwd}` : ""}${q.dutyId ? `, 임무 ${q.dutyId}` : ""}에 대한 사용자의 답) ${request.text}`;
      }
      const cwd = dirname(paths.chatSessions);
      const actionsPath = join(paths.chatActions, `${now}.jsonl`);
      await mkdir(paths.chatActions, { recursive: true });
      // 대화는 설정에서 고른 MCP 서버를 쓰고, 대화에서 허용한 도구만 통과한다 (DESIGN-APPS.md §3.4)
      const duty: Duty = {
        id: CHAT_DUTY_ID,
        name: "Mate 대화",
        enabled: true,
        cwd,
        prompt,
        profile: "observe",
        trigger: { kind: "manual" },
        createdAt: now,
        ...(config.chatMcpServers.length ? { mcpServers: config.chatMcpServers } : {}),
        ...(config.chatGrants.length ? { grants: config.chatGrants } : {}),
      };
      const runId = `chat-${now.toString(36)}`;
      const blockedPath = join(paths.runDir, "blocked", `${runId}.jsonl`);
      const [launch, extensions, promptParts] = await Promise.all([
        this.options.locatePi(),
        extensionEntries(this.options.kitDir),
        chatPromptParts(paths, now),
        // Mate 기능 안내 파일: 대화 모델이 무엇을 바꿀 수 있는지 필요할 때 읽는다 (바뀌었을 때만 다시 쓴다)
        writeGuide(paths).catch(() => undefined),
      ]);
      // Mate 상태는 섹션으로 나눠 mate-chat 확장이 넣는다 (바뀐 섹션만 대화에 쌓여 프롬프트 캐시가 산다)
      const sectionsPath = join(paths.chatActions, `${now}.sections.json`);
      await writeFile(sectionsPath, JSON.stringify(promptParts.sections));
      const outcome = await (this.options.runPi ?? defaultRunPi)(
        launch,
        {
          duty,
          runId,
          model: config.model,
          blockedPath,
          extensions,
          packages: packageDirs(paths.home),
          packageTools: packageToolNames(paths.home),
          home: paths.home,
          isolationDir: isolationDirOf(this.options.kitDir),
          inboxPath: paths.inbox,
          sessionsDir: paths.chatSessions,
          timeoutSec: mateTunables().num("chat.timeoutSec"),
          maxCostUsd: config.maxCostUsd,
          chat: { sessionId: `mate-chat-${this.state.epoch}`, systemPrompt: promptParts.rules, sectionsPath, actionsPath },
          ...(request.images?.length ? { images: request.images } : {}),
        },
        this.abort.signal,
      );
      this.addCost(outcome.costUsd);
      const text = outcome.status === "done" ? (outcome.summary ?? "(답이 비었어요)") : `⚠️ 답하지 못했어요: ${outcome.error ?? outcome.status}`;
      await this.say(request.source, text, "reply", outcome.tokens > 0 ? { usage: { tokens: outcome.tokens, costUsd: outcome.costUsd } } : {});
      this.options.log(`chat turn status=${outcome.status} cost=${outcome.costUsd.toFixed(4)}`);
      // 처음 쓰는 MCP 도구가 막혔으면 대화에서 허용할지 묻는다
      await askPermission(paths, duty, runId, blockedPath, this.now(), request.text).catch((error: Error) => this.options.log(`chat permission ask error ${error.message}`));
      const actions = await readChatActions(actionsPath);
      await rm(actionsPath, { force: true });
      await rm(sectionsPath, { force: true });
      const notes: string[] = [];
      for (const action of actions.slice(0, 8)) {
        notes.push(await this.doAction(action, request.source).catch((error: Error) => `⚠️ ${error.message}`));
      }
      // 고치기만 맡기고 실행은 맡기지 않았는데 사용자가 실행을 바랐으면, 실행하지 않았다고 분명히 알린다
      const changedDuty = actions.some((a) => (a.action === "update_duty" || a.action === "create_duty") && a.run !== true);
      const ran = actions.some((a) => a.action === "run_duty" || ((a.action === "update_duty" || a.action === "create_duty") && a.run === true));
      if (changedDuty && !ran && /실행|처리|돌려|돌리|다시 해|해 ?봐/.test(request.text)) {
        notes.push('ℹ️ 임무는 고쳤지만 실행은 아직 요청하지 않았어요. 바로 돌리려면 "실행해 줘"라고 말씀해 주세요.');
      }
      if (notes.length) await this.say(request.source, notes.join("\n"), "notice");
    } finally {
      delete this.state.busy;
      await this.save();
    }
  }

  private addCost(usd: number): void {
    const date = localDateKey(this.now());
    const prev = this.state.cost?.date === date ? this.state.cost.usd : 0;
    this.state.cost = { date, usd: prev + usd };
  }

  /** mate_do 한 줄을 처리하고 사용자에게 보일 한 줄을 돌려준다 */
  async doAction(action: Record<string, unknown>, source: ChatSource, confirmed = false): Promise<string> {
    const { paths } = this.options;
    const str = (key: string) => (typeof action[key] === "string" ? (action[key] as string).trim() : "");
    const allowFix = await this.allowFix(source);
    const ctx = this.commandContext(source, allowFix);
    switch (action.action) {
      case "run_duty": {
        const duty = await findDuty(paths, str("duty"));
        if (!duty) return `⚠️ 임무 "${str("duty")}"을(를) 찾지 못했어요.`;
        await addRequest(paths, duty.id, this.now());
        await this.track(duty.id, source);
        return `▶ ${duty.name} 실행을 요청했어요.`;
      }
      case "ask":
      case "fix": {
        const folder = await this.resolveFolder(str("folder"));
        if (!folder) return `⚠️ 폴더 "${str("folder")}"을(를) 모르겠어요. /folders로 목록을 보세요.`;
        if (!str("prompt")) return "⚠️ 무엇을 할지 지시가 비었어요.";
        return instruct(ctx, action.action, folder, str("prompt"));
      }
      case "accept":
      case "dismiss":
      case "delegate": {
        const item = (await readInbox(paths.inbox)).find((i) => i.id === str("item"));
        if (!item) return `⚠️ 제안 ${str("item")}을(를) 찾지 못했어요.`;
        if (action.action === "delegate") {
          if (!allowFix) return "⚠️ 휴대폰에서 맡기기는 설정에서 허용해야 해요.";
          const duty = await delegateInboxItem(paths, item.id, this.options.exec);
          await this.track(duty.id, source);
          return `🛠 맡겼어요: ${item.title}`;
        }
        if (item.change) return `⚠️ "${item.title}"은(는) 고친 변경이라 앱·휴대폰의 적용·버리기 버튼으로 처리해 주세요.`;
        if (item.install && action.action === "accept") return `⚠️ "${item.title}"은(는) 설치 제안이라 앱·휴대폰의 적용 버튼으로 처리해 주세요 (내용을 직접 보고 정하도록).`;
        await setInboxStatus(paths, [item.id], action.action === "accept" ? "accepted" : "dismissed");
        return `${action.action === "accept" ? "👍 확인함" : "🗑 버림"}: ${item.title}`;
      }
      case "enable_web": {
        if (await webSearchOn(paths)) return "🌐 웹 검색은 이미 켜져 있어요.";
        // 특정 서비스를 정해 넣지 않는다: 이미 있는 것부터 고르게 하고, 다른 방법은 알린다 (DESIGN-APPS.md §3.5 4단계)
        const choices = await webChoices(paths);
        const retry = this.currentRequest ? { retry: this.currentRequest } : {};
        const text = [
          choices.length > 1 ? "이 일에는 인터넷 검색이 필요해요. 어떤 방법으로 웹 검색을 켤까요?" : "이 일에는 인터넷 검색이 필요해요. 웹 검색을 켤까요?",
          ...choices.map((c) => `• ${c.label}: ${c.detail}`),
          "다른 방법: 스킬·MCP 탭에서 키가 필요한 검색 서버(Brave·Tavily)를 넣거나, 웹 검색 확장(예: pi-web-access)을 설치할 수 있어요.",
          "켜면 대화와 임무에서 날씨·뉴스·검색을 쓸 수 있어요. 설정 탭에서 언제든 끌 수 있어요.",
        ].join("\n");
        const one = choices.length === 1 ? choices[0]! : undefined;
        const asked = await appendChatQuestion(
          paths.chat,
          one
            ? {
                text,
                options: [...PERMISSION_OPTIONS],
                dutyId: CHAT_DUTY_ID,
                permission: { dutyId: CHAT_DUTY_ID, commands: one.commands, ...(one.mcpServers ? { mcpServers: one.mcpServers } : {}), ...retry },
              }
            : {
                text,
                options: [...choices.map((c) => c.label), PERMISSION_OPTIONS[1]],
                dutyId: CHAT_DUTY_ID,
                permission: { dutyId: CHAT_DUTY_ID, commands: [], choices: choices.map((c) => ({ label: c.label, commands: c.commands, ...(c.mcpServers ? { mcpServers: c.mcpServers } : {}) })), ...retry },
              },
          this.now(),
        );
        return asked ? "🌐 웹 검색을 어떻게 켤지 위의 질문에서 골라 주세요." : "🌐 웹 검색을 켤지 묻는 질문이 이미 있어요. 위에서 골라 주세요.";
      }
      case "create_duty": {
        const config = await loadConfig(paths);
        // 폴더와 상관없는 일(날씨·뉴스 등)은 Mate 홈의 작업 폴더에서 돈다
        const folder = str("folder") ? await this.resolveFolder(str("folder")) : await this.workspace();
        if (!folder) return `⚠️ 폴더 "${str("folder")}"을(를) 모르겠어요. 경로를 알려 주세요.`;
        const web = action.web === true;
        // 대화에서 켠 웹 검색(서버·확장 도구)을 임무에도 쓴다. 허용한 도구도 함께 (같은 것을 두 번 묻지 않게)
        const setup = web ? await webSetup(paths) : undefined;
        if (web && !setup) {
          const asked = await this.doAction({ action: "enable_web" }, source);
          return `⚠️ 웹 검색이 아직 켜져 있지 않아 임무를 만들지 않았어요. ${asked} 켠 뒤 다시 말씀해 주세요.`;
        }
        const webGrants = setup?.grants ?? [];
        const trigger = parseSchedulePhrase(str("schedule"));
        if (!trigger) return `⚠️ 실행 시점 "${str("schedule")}"을(를) 이해하지 못했어요.`;
        const name = str("name") || str("prompt").slice(0, 40);
        const profile = action.profile === "observe" || action.profile === "act" ? action.profile : "propose";
        const timeout = action.timeout === undefined ? undefined : timeoutOf(action.timeout);
        if (profile === "act" && !confirmed) return this.askConfirm(action, "고치기(act) 임무는 별도 작업 공간에서 파일을 고칩니다 (적용은 다시 승인)", `임무 "${name}"을(를) 고치기 방식으로 만들기`);
        const ids = (await listDuties(paths)).map((d) => d.id);
        const duty = await saveDuty(paths, {
          id: dutyIdFrom(name, ids),
          name,
          enabled: true,
          cwd: folder,
          prompt: str("prompt"),
          profile,
          trigger,
          ...(setup?.mcpServers.length ? { mcpServers: setup.mcpServers } : {}),
          ...(webGrants.length ? { grants: webGrants } : {}),
          ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
          createdAt: this.now(),
        }, source === "telegram" ? "phone" : "chat");
        const where = str("folder") ? ` (${folderAlias(duty.cwd)})` : "";
        const webNote = web && webGrants.length === 0 ? " 처음 실행할 때 웹 검색을 허용할지 물어요." : "";
        const runNote = action.run === true ? await this.runAfterChange(duty.id, duty.name, source) : "";
        return `🗓 임무를 만들었어요: ${duty.name}${where}.${webNote} 임무 탭에서 고칠 수 있어요.${runNote}`;
      }
      case "update_duty": {
        // 있는 임무를 고친다: 새로 만들면 허용한 명령(grants)과 실행 기록을 잃으므로 고치기를 먼저 쓴다
        const duty = await findDuty(paths, str("duty"));
        if (!duty) return `⚠️ 임무 "${str("duty")}"을(를) 찾지 못했어요. 고치지 않았어요.`;
        const changed: string[] = [];
        const next: Duty = { ...duty };
        if (str("name") && str("name") !== duty.name) {
          next.name = str("name");
          changed.push("이름");
        }
        if (str("prompt") && str("prompt") !== duty.prompt) {
          next.prompt = str("prompt");
          changed.push("지시");
        }
        if (str("folder")) {
          const folder = await this.resolveFolder(str("folder"));
          if (!folder) return `⚠️ 폴더 "${str("folder")}"을(를) 모르겠어요. "${duty.name}"을(를) 고치지 않았어요.`;
          if (folder !== duty.cwd) {
            next.cwd = folder;
            changed.push("폴더");
          }
        }
        if (str("schedule")) {
          const trigger = parseSchedulePhrase(str("schedule"));
          if (!trigger) return `⚠️ 실행 시점 "${str("schedule")}"을(를) 이해하지 못했어요. "${duty.name}"을(를) 고치지 않았어요.`;
          next.trigger = trigger;
          changed.push("실행 시점");
        }
        if ((action.profile === "observe" || action.profile === "propose" || action.profile === "act") && action.profile !== duty.profile) {
          next.profile = action.profile;
          changed.push("방식");
        }
        if (action.timeout !== undefined) {
          const timeout = timeoutOf(action.timeout);
          if (timeout !== duty.timeoutSec) {
            next.timeoutSec = timeout;
            changed.push(`시간 제한 ${duty.timeoutSec ?? mateTunables().num("duty.defaultTimeoutSec")}초→${timeout}초`);
          }
        }
        if (typeof action.model === "string") {
          const model = action.model.trim();
          if (/^(default|기본)$/i.test(model) || model === "") {
            if (duty.model) {
              next.model = undefined;
              changed.push("모델(Mate 기본으로)");
            }
          } else if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) {
            return `⚠️ 모델은 provider/id 모양이어야 해요 (${model}). "${duty.name}"을(를) 고치지 않았어요.`;
          } else if (model !== duty.model) {
            next.model = model;
            changed.push(`모델 ${model}`);
          }
        }
        let costRaised = false;
        if (action.max_cost !== undefined) {
          const cost = Number(action.max_cost);
          if (!Number.isFinite(cost) || cost < 0 || cost > 20) return `⚠️ 비용 상한은 0~20달러로 알려 주세요. "${duty.name}"을(를) 고치지 않았어요.`;
          const config = await loadConfig(paths);
          const before = duty.maxCostUsd ?? config.maxCostUsd;
          if (cost === 0 ? duty.maxCostUsd !== undefined : cost !== duty.maxCostUsd) {
            next.maxCostUsd = cost === 0 ? undefined : cost;
            const after = cost === 0 ? config.maxCostUsd : cost;
            costRaised = after > before || (after === 0 && before > 0);
            changed.push(`비용 상한 ${cost === 0 ? `$${config.maxCostUsd}(Mate 설정)` : `$${cost}`}`);
          }
        }
        if (typeof action.enabled === "boolean" && action.enabled !== duty.enabled) {
          next.enabled = action.enabled;
          changed.push(action.enabled ? "켬" : "끔");
        }
        const removeGrants = Array.isArray(action.remove_grants) ? action.remove_grants.map(String) : [];
        if (removeGrants.length && duty.grants?.some((g) => removeGrants.includes(g))) {
          next.grants = duty.grants.filter((g) => !removeGrants.includes(g));
          changed.push(`허용 빼기 ${removeGrants.join(", ")}`);
        }
        const removeMcp = Array.isArray(action.remove_mcp) ? action.remove_mcp.map(String) : [];
        if (removeMcp.length && duty.mcpServers?.some((m) => removeMcp.includes(m))) {
          next.mcpServers = duty.mcpServers.filter((m) => !removeMcp.includes(m));
          changed.push(`MCP 빼기 ${removeMcp.join(", ")}`);
        }
        // 고치기 방식으로 바꾸기·비용 상한 올리기는 사용자에게 다시 묻는다
        const risks = [
          ...(next.profile === "act" && duty.profile !== "act" ? ["고치기(act) 방식은 별도 작업 공간에서 파일을 고칩니다 (적용은 다시 승인)"] : []),
          ...(costRaised ? ["실행당 비용 상한을 올리면 한 번에 쓰는 비용이 늘 수 있습니다"] : []),
        ];
        if (risks.length && !confirmed) return this.askConfirm(action, risks.join(". "), `임무 "${duty.name}" 고치기 (${changed.join("·")})`);
        if (action.web === true) {
          const setup = await webSetup(paths);
          if (!setup) {
            const asked = await this.doAction({ action: "enable_web" }, source);
            return `⚠️ 웹 검색이 아직 켜져 있지 않아 "${duty.name}"을(를) 고치지 않았어요. ${asked} 켠 뒤 다시 말씀해 주세요.`;
          }
          const mcpServers = [...new Set([...(duty.mcpServers ?? []), ...setup.mcpServers])];
          const grants = [...new Set([...(duty.grants ?? []), ...setup.grants])];
          if (mcpServers.length) next.mcpServers = mcpServers;
          if (grants.length) next.grants = grants;
          if (mcpServers.length !== (duty.mcpServers?.length ?? 0) || grants.length !== (duty.grants?.length ?? 0)) changed.push("인터넷");
        }
        if (changed.length > 0) await saveDuty(paths, { ...next, updatedAt: this.now() }, source === "telegram" ? "phone" : "chat");
        const runNote = action.run === true ? await this.runAfterChange(duty.id, next.name, source) : "";
        if (changed.length === 0) return `"${duty.name}"은(는) 바뀐 것이 없어요.${runNote}`;
        return `✏️ 임무를 고쳤어요: ${next.name} (${changed.join("·")}).${runNote}`;
      }
      case "delete_duty": {
        const duty = await findDuty(paths, str("duty"));
        if (!duty) return `⚠️ 임무 "${str("duty")}"을(를) 찾지 못했어요.`;
        if (!confirmed) return this.askConfirm({ ...action, duty: duty.id }, "지우면 휴지통으로 가고, 휴지통 탭에서 되살릴 수 있어요", `임무 "${duty.name}" 지우기`);
        await deleteDuty(paths, duty.id, source === "telegram" ? "phone" : "chat");
        return `🗑 임무를 지웠어요: ${duty.name} (휴지통에서 되살릴 수 있어요)`;
      }
      case "set_config": {
        const setting = str("setting");
        const value = action.value as string | number | boolean;
        if (!setting || value === undefined || value === null) return "⚠️ 바꿀 설정 이름(setting)과 값(value)이 필요해요.";
        const risk = settingRisk(setting, value, await loadConfig(paths));
        if (risk && !confirmed) return this.askConfirm(action, risk, `설정 ${setting} → ${String(value)}`);
        return applySetting(paths, setting, value);
      }
      case "set_tunable": {
        const id = str("tunable");
        if (!id) return "⚠️ 바꿀 설정 항목(tunable)이 필요해요.";
        const value = action.value === undefined ? null : (action.value as string | number | boolean | null);
        const risk = tunableRisk(id);
        if (risk && !confirmed) return this.askConfirm(action, risk, `설정 항목 ${id} 바꾸기`);
        return applyTunable(id, value === null ? null : typeof value === "boolean" ? String(value) : value);
      }
      case "pause":
      case "resume":
        await saveConfig(paths, { paused: action.action === "pause" });
        return action.action === "pause" ? "⏸ 자동 실행을 멈췄어요 (지금 실행은 됨)." : "▶ 자동 실행을 다시 시작했어요.";
      default:
        return `⚠️ 모르는 할 일이에요: ${String(action.action)}`;
    }
  }

  /** 고치거나 만든 임무를 바로 실행한다 (update_duty·create_duty의 run) */
  private async runAfterChange(dutyId: string, name: string, source: ChatSource): Promise<string> {
    await addRequest(this.options.paths, dutyId, this.now());
    await this.track(dutyId, source);
    return ` ▶ ${name} 실행을 요청했어요.`;
  }

  /** 폴더와 상관없는 임무가 도는 곳 (Mate 홈의 workspace) */
  private async workspace(): Promise<string> {
    const dir = join(this.options.paths.home, "workspace");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** 아는 폴더 이름이나, 실제로 있는 절대 경로 */
  private async resolveFolder(nameOrPath: string): Promise<string | undefined> {
    const known = await findFolder(this.options.paths, nameOrPath || undefined);
    if (known) return known;
    if (nameOrPath && isAbsolute(nameOrPath)) {
      const s = await stat(nameOrPath).catch(() => undefined);
      if (s?.isDirectory()) return nameOrPath;
    }
    return undefined;
  }

  async track(dutyId: string, source: ChatSource): Promise<void> {
    this.state.pending[dutyId] = { at: this.now(), source };
    await this.save();
  }

  /** 대화에서 시작한 실행이 끝났으면 결과를 남긴다 */
  async checkPending(): Promise<void> {
    if (Object.keys(this.state.pending).length === 0) return;
    const runs = await listRuns(this.options.paths, 100);
    let changed = false;
    for (const [dutyId, { at, source }] of Object.entries(this.state.pending)) {
      const run = runs.find((r) => r.dutyId === dutyId && r.startedAt >= at - 1_000 && r.status !== "running");
      if (!run) {
        // 하루가 지나도 안 끝났으면(임무를 지움 등) 잊는다
        if (this.now() - at > 24 * 3_600_000) {
          delete this.state.pending[dutyId];
          changed = true;
        }
        continue;
      }
      const ok = run.status === "done";
      const lines = [`${ok ? "✅ 끝났어요" : "⚠️ 실패했어요"}: ${run.dutyName}`];
      if (run.error) lines.push(run.error.slice(0, 400));
      // 결과는 자르지 않는다 (휴대폰으로 보낼 때는 그쪽에서 메시지 한도에 맞춰 자른다)
      else if (run.summary) lines.push(run.summary);
      if (run.proposals) lines.push(`인박스에 ${run.proposals}건을 남겼어요.`);
      delete this.state.pending[dutyId];
      changed = true;
      await this.say(source, lines.join("\n"), "result", { dutyId, runId: run.id });
    }
    if (changed) await this.save();
  }
}

/** 실행 시간 제한(초): 30~3600 */
function timeoutOf(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 30 || n > 3600) throw new Error(`시간 제한은 30~3600초로 알려 주세요 (${String(value)})`);
  return n;
}
