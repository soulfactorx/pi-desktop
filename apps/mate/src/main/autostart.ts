import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 로그인 때 띄운 실행이면 창 없이 실행기만 확인하고 끝낸다 */
export const RUNNER_ONLY_ARG = "--mate-runner-only";

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
  /** 지원하지 않을 때 이유 */
  reason?: string;
}

/**
 * 로그인할 때 실행기 시작 (설계 DESIGN-MATE.md §2.3, M3).
 *
 * 실행기는 앱이 띄우므로, PC를 다시 켠 뒤 앱을 열지 않으면 시간표가 멈춘다.
 * 로그인 항목으로 앱을 `--mate-runner-only`로 띄워 실행기만 확인하고 바로 끝낸다 (창 없음).
 * - Windows·macOS: Electron 로그인 항목 (macOS는 인자를 넘길 수 없어 wasOpenedAtLogin으로 구분)
 * - Linux: ~/.config/autostart/pi-desktop-mate.desktop
 * 개발 실행(설치본이 아님)에서는 electron.exe가 등록되므로 지원하지 않는다.
 */
export function isRunnerOnlyLaunch(): boolean {
  if (process.argv.includes(RUNNER_ONLY_ARG)) return true;
  return process.platform === "darwin" && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

export function linuxDesktopFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "pi-desktop-mate.desktop");
}

/** 리눅스 로그인 항목 내용. 패널(트레이)이 뜬 뒤 조금 늦게 띄운다 (KDE·GNOME) */
export function linuxDesktopEntry(exe: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Pi Desktop Mate (실행기)",
    "Comment=PC를 켜면 Mate 실행기를 띄우고 트레이에 Pi Desktop을 둡니다",
    `Exec="${exe.replace(/(["`$\\])/g, "\\$1")}" ${RUNNER_ONLY_ARG}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-Autostart-Delay=5",
    "X-KDE-autostart-after=panel",
    "",
  ].join("\n");
}

/** 로그인 항목의 실행 파일 경로 (Exec 첫 낱말). 읽지 못하면 undefined */
export function linuxEntryExe(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("Exec="));
  if (!line) return undefined;
  const exec = line.slice("Exec=".length).trim();
  if (exec.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(exec);
    return m ? m[1]!.replace(/\\(.)/g, "$1") : undefined;
  }
  return exec.split(/\s+/)[0];
}

/** 로그인 때 띄울 실행 파일. AppImage는 실행 중인 파일이 임시 마운트라 원래 AppImage 경로(APPIMAGE)를 쓴다 */
function launchExe(): string {
  return process.env.APPIMAGE || process.execPath;
}

/**
 * 리눅스 로그인 항목이 지금 실행 파일을 가리키게 고친다.
 * AppImage를 자동 업데이트하면 새 버전 이름의 파일로 바뀌고 옛 파일은 지워진다 (electron-updater).
 * 그대로 두면 로그인 항목이 없는 파일을 가리켜 PC를 켜도 뜨지 않는다. 앱이 뜰 때마다, 그리고 업데이트가 파일 이름을 바꿀 때 고친다.
 * @param exe 가리킬 실행 파일 (업데이트가 알려 준 새 AppImage 경로). 없으면 지금 실행 파일
 */
export async function repairLinuxAutostart(exe = launchExe()): Promise<boolean> {
  if (process.platform !== "linux" || !app.isPackaged) return false;
  const file = linuxDesktopFile();
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  if (linuxEntryExe(text) === exe && text === linuxDesktopEntry(exe)) return false;
  await writeFile(file, linuxDesktopEntry(exe), "utf8");
  return true;
}

export function getAutostart(): AutostartState {
  // 휴대폰 웹(pi-web)은 Electron이 아니다: 로그인 항목이 없고, Termux를 켤 때 pi-web을 띄우는 것은 Termux:Boot가 맡는다
  if (!process.versions.electron) return { supported: false, enabled: false, reason: "휴대폰 웹에서는 Termux:Boot에 pi-web start를 걸어 두면 폰을 켤 때 함께 뜹니다" };
  if (!app.isPackaged) return { supported: false, enabled: false, reason: "설치본에서만 쓸 수 있습니다" };
  if (process.platform === "linux") return { supported: true, enabled: existsSync(linuxDesktopFile()) };
  const settings = app.getLoginItemSettings(process.platform === "win32" ? { args: [RUNNER_ONLY_ARG] } : undefined);
  return { supported: true, enabled: settings.openAtLogin };
}

export async function setAutostart(enabled: boolean): Promise<AutostartState> {
  const state = getAutostart();
  if (!state.supported) return state;
  if (process.platform === "linux") {
    const file = linuxDesktopFile();
    if (enabled) {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, linuxDesktopEntry(launchExe()), "utf8");
    } else {
      await rm(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === "win32" ? { args: [RUNNER_ONLY_ARG] } : {}) });
  }
  return getAutostart();
}
