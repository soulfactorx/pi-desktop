import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true, getLoginItemSettings: () => ({}) } }));
const { linuxDesktopEntry, linuxDesktopFile, linuxEntryExe, repairLinuxAutostart } = await import("../../src/main/autostart");

/** 리눅스(AppImage) 로그인 자동 시작: 업데이트로 AppImage 이름이 바뀌어도 새 파일을 가리킨다 */
describe.skipIf(process.platform !== "linux")("리눅스 자동 시작 항목", () => {
  let config: string;
  let previous: string | undefined;

  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), "autostart-"));
    previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(config, { recursive: true, force: true });
  });

  it("항목의 실행 파일을 읽고 쓴다 (공백·따옴표 경로)", () => {
    const exe = '/home/me/Apps/Pi "Desktop"/Pi-Desktop-0.7.28-x86_64.AppImage';
    const text = linuxDesktopEntry(exe);
    expect(text).toContain("--mate-runner-only");
    expect(text).toContain("X-KDE-autostart-after=panel");
    expect(linuxEntryExe(text)).toBe(exe);
    expect(linuxEntryExe("Exec=/usr/bin/pi --x")).toBe("/usr/bin/pi");
  });

  it("업데이트로 바뀐 AppImage 경로로 고치고, 항목이 없으면 만들지 않는다", async () => {
    expect(await repairLinuxAutostart("/apps/Pi-Desktop-0.7.28-x86_64.AppImage")).toBe(false);
    const file = linuxDesktopFile();
    await mkdir(join(file, ".."), { recursive: true });
    // 옛 형식·옛 버전 파일을 가리키는 항목
    await writeFile(file, '[Desktop Entry]\nType=Application\nExec="/apps/Pi-Desktop-0.7.20-x86_64.AppImage" --mate-runner-only\n');
    expect(await repairLinuxAutostart("/apps/Pi-Desktop-0.7.28-x86_64.AppImage")).toBe(true);
    expect(linuxEntryExe(await readFile(file, "utf8"))).toBe("/apps/Pi-Desktop-0.7.28-x86_64.AppImage");
    // 이미 맞으면 다시 쓰지 않는다
    expect(await repairLinuxAutostart("/apps/Pi-Desktop-0.7.28-x86_64.AppImage")).toBe(false);
  });
});
