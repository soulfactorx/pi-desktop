import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProposal, makeProposal } from "@pi-desktop/mate-kit";
import { delegateInboxItem, NEED_FOLDER } from "../src/delegate";
import { matePaths, type MatePaths } from "../src/paths";
import { getDuty, loadInboxState, takeRequests } from "../src/store";
import { eventDetail } from "../src/system/watch";
import { parseWindowsHealth } from "../src/system/sources";
import { scrubLines } from "../src/system/privacy";

/** "Mate에게 맡기기": git이 아닌 폴더도 고치기로, 폴더를 모르는 제안은 폴더를 고르게 (설계 DESIGN-MATE.md §5) */
describe("제안 맡기기", () => {
  let base: string;
  let paths: MatePaths;
  let project: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "mate-delegate-"));
    paths = matePaths(join(base, "home"));
    await mkdir(paths.home, { recursive: true });
    project = join(base, "docker-app");
    await mkdir(project);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const propose = async (cwd: string) => {
    const item = makeProposal({ title: "Dockerfile 고치기", summary: "베이스 이미지가 낡았다", followUp: { prompt: "Dockerfile의 FROM을 node:22로", cwd } }, { dutyId: "observer", runId: "r" });
    await appendProposal(paths.inbox, item);
    return item;
  };

  it("git 저장소가 아닌 폴더도 고치기(act)로 맡긴다", async () => {
    const item = await propose(project);
    const duty = await delegateInboxItem(paths, item.id);
    expect((await getDuty(paths, duty.id))?.profile).toBe("act");
    expect(duty.cwd).toBe(project);
    expect((await takeRequests(paths)).map((r) => r.dutyId)).toEqual([duty.id]);
    expect((await loadInboxState(paths))[item.id]).toBeTruthy();
  });

  it("Mate 홈에서 만든 제안은 폴더를 고르라고 하고, 고른 폴더에서 실행한다", async () => {
    const item = await propose(paths.home);
    await expect(delegateInboxItem(paths, item.id)).rejects.toThrow(NEED_FOLDER);
    expect((await loadInboxState(paths))[item.id]).toBeUndefined();
    const duty = await delegateInboxItem(paths, item.id, undefined, project);
    expect(duty.cwd).toBe(project);
    expect(duty.profile).toBe("act");
    expect(duty.prompt).toContain("사용자가 이 폴더를 골랐다");
  });

  it("없는 폴더면 알린다", async () => {
    const item = await propose(project);
    await expect(delegateInboxItem(paths, item.id, undefined, join(base, "nope"))).rejects.toThrow(/폴더가 없어요/);
  });
});

describe("시스템 오류 제안의 자세히 보기", () => {
  it("Windows 이벤트의 전체 메시지를 읽고, 가린 뒤 날짜별 횟수·확인할 곳과 함께 보인다", () => {
    const reading = parseWindowsHealth(
      JSON.stringify({
        events: [{ p: "Docker Desktop", i: 7, l: 2, t: "2026-11-17T01:00:00Z", m: "엔진을 시작하지 못했습니다.", d: "엔진을 시작하지 못했습니다.\r\n\r\n원인: C:\\Users\\kim\\AppData\\docker.log 에서 10.0.0.5 연결 거부" }],
      }),
    );
    const raw = reading.events[0]!;
    expect(raw.detail).toContain("원인");
    const detail = scrubLines(raw.detail!, "C:\\Users\\kim", "kim");
    expect(detail).not.toContain("kim");
    expect(detail).toContain("<IP>");
    const now = Date.parse("2026-11-17T03:00:00Z");
    const text = eventDetail(
      { key: "Docker Desktop#7", source: "Docker Desktop", id: "7", level: "error", message: raw.message, detail, days: { "2026-11-17": 3, "2026-11-16": 1 }, firstAt: now - 86_400_000, lastAt: raw.at },
      "이벤트 뷰어",
      now,
    );
    expect(text).toContain("이벤트 ID 7");
    expect(text).toContain("2026-11-17 3회");
    expect(text).toContain("원인");
    expect(text).toContain("Mate에게 자세히 묻기");
  });
});

describe("시스템 로그 가리기", () => {
  it("긴 공급자 이름은 가리지 않고, 도메인\\컴퓨터 계정은 가린다", async () => {
    const { scrubSource, scrubText } = await import("../src/system/privacy");
    expect(scrubSource("Microsoft-Windows-CertificateServicesClient-CertEnroll", "C:\\Users\\kim", "kim")).toBe("Microsoft-Windows-CertificateServicesClient-CertEnroll");
    expect(scrubText("통한 SKCC\\SKAX26N00713$의 SCEP 인증서 등록 실패", "C:\\Users\\kim", "kim")).toBe("통한 <컴퓨터 계정>의 SCEP 인증서 등록 실패");
  });
});
