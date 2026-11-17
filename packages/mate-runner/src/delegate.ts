import { readInbox } from "@pi-desktop/mate-kit";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { MatePaths } from "./paths";
import { addRequest, saveDuty, setInboxStatus } from "./store";
import type { Duty } from "./types";
import { execCommand, type Exec } from "./watchers";
import { isInside } from "./workspace";

/** 맡길 폴더를 모를 때 (제안이 Mate 홈에서 만들어짐). 앱은 이 글로 알아보고 폴더를 고르게 한다 */
export const NEED_FOLDER = "맡길 폴더를 골라 주세요";

/**
 * 한 번만 도는 임무를 만들어 바로 실행을 요청한다 ("Mate에게 맡기기", 휴대폰 지시).
 * 임무로 남겨 두므로 실행 기록·세션을 볼 수 있고 다시 돌릴 수 있다.
 * 고치기는 별도 작업 공간에서 한다: git 저장소면 worktree, 아니면 폴더 복사본 (workspace.ts).
 */
export async function requestOneOff(
  paths: MatePaths,
  input: { idPrefix: string; name: string; cwd: string; prompt: string; wantAct: boolean },
  _exec: Exec = execCommand,
  now = Date.now(),
): Promise<Duty> {
  const duty = await saveDuty(paths, {
    id: `${input.idPrefix}-${now.toString(36)}`,
    name: input.name.slice(0, 80),
    enabled: true,
    cwd: input.cwd,
    prompt: input.prompt,
    profile: input.wantAct ? "act" : "propose",
    trigger: { kind: "manual" },
    createdAt: now,
  });
  await addRequest(paths, duty.id, now);
  return duty;
}

/** Mate 홈(실행 기록·관찰자 실행이 도는 곳)은 고칠 프로젝트 폴더가 아니다 */
export function isMateHome(paths: MatePaths, folder: string): boolean {
  return resolve(folder) === resolve(paths.home) || isInside(folder, paths.home);
}

/**
 * 제안의 "맡길 일"을 고치기로 실행한다. 제안은 확인함으로 둔다.
 * folder를 주면 그 폴더에서 한다 (제안이 Mate 홈에서 만들어져 폴더를 모를 때 사용자가 고른다).
 */
export async function delegateInboxItem(paths: MatePaths, itemId: string, exec: Exec = execCommand, folder?: string): Promise<Duty> {
  const item = (await readInbox(paths.inbox)).find((i) => i.id === itemId);
  if (!item?.followUp) throw new Error("맡길 일이 없는 제안입니다");
  const cwd = folder?.trim() || item.followUp.cwd;
  if (folder?.trim()) {
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`폴더가 없어요: ${cwd}`);
  }
  if (isMateHome(paths, cwd)) throw new Error(`${NEED_FOLDER}: 이 제안은 Mate 데이터 폴더에서 만들어져 어느 프로젝트를 고칠지 몰라요`);
  // 관찰자에게 맡길 일을 그것만으로 실행할 수 있게 쓰라고 했으므로 지시는 그대로 쓴다. 폴더를 새로 골랐으면 그 안에서 찾게 한다
  const prompt = cwd === item.followUp.cwd ? item.followUp.prompt : `${item.followUp.prompt}\n\n(사용자가 이 폴더를 골랐다. 고칠 파일은 이 폴더 안에서 찾는다)`;
  const duty = await requestOneOff(paths, { idPrefix: "delegated", name: `맡긴 일: ${item.title}`, cwd, prompt, wantAct: true }, exec);
  await setInboxStatus(paths, [item.id], "accepted");
  return duty;
}
