import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIND_NODE, nodePathPrefix } from "../src/bundle";

/**
 * ssh로 명령만 실행하면 .bashrc를 읽지 않아, nvm이나 .bashrc에서 PATH를 더한 Node를 못 찾던 문제.
 * 시스템 Node(/usr/local/bin, /usr/bin)는 빼고 시험한다 (CI 기계에 있으므로).
 */
describe.skipIf(process.platform === "win32")("원격 node 찾기", () => {
  let base: string;
  const script = FIND_NODE.replace("/usr/local/bin/node /usr/bin/node /opt/node/bin/node /opt/nodejs/bin/node", "") + '\nprintf "%s" "$NODE"';
  const fakeNode = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "node"), "#!/bin/sh\necho v24.0.0\n");
    chmodSync(join(dir, "node"), 0o755);
  };
  // PATH에는 스크립트가 쓰는 도구만 둔다 (CI 기계의 /usr/bin/node 같은 것이 보이지 않게)
  const find = (home: string) => {
    const tools = join(base, "tools");
    mkdirSync(tools, { recursive: true });
    for (const t of ["sh", "bash", "ls", "sort", "tail", "timeout"]) {
      const at = execFileSync("sh", ["-c", `command -v ${t} || true`], { encoding: "utf8" }).trim();
      if (at && !existsSync(join(tools, t))) symlinkSync(at, join(tools, t));
    }
    return execFileSync(join(tools, "sh"), ["-c", script], { env: { HOME: home, PATH: tools }, encoding: "utf8" });
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "find-node-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("nvm으로 깐 Node는 가장 높은 버전을 찾는다", () => {
    fakeNode(join(base, ".nvm/versions/node/v22.9.0/bin"));
    fakeNode(join(base, ".nvm/versions/node/v26.13.1/bin"));
    expect(find(base)).toBe(join(base, ".nvm/versions/node/v26.13.1/bin/node"));
  });

  it(".bashrc에서만 PATH에 들어가는 Node는 대화형 셸에 물어 찾는다", () => {
    fakeNode(join(base, "custom/bin"));
    // Ubuntu 기본 .bashrc처럼 비대화형이면 바로 돌아간다
    writeFileSync(join(base, ".bashrc"), 'case $- in *i*) ;; *) return;; esac\nexport PATH="$HOME/custom/bin:$PATH"\n');
    expect(find(base)).toBe(join(base, "custom/bin/node"));
  });

  it("없으면 비워 둔다", () => {
    expect(find(base)).toBe("");
  });

  it("찾은 Node의 폴더를 PATH 앞에 둔다 (npm·pi를 PATH로 찾게)", () => {
    expect(nodePathPrefix("/root/.nvm/versions/node/v26.13.1/bin/node")).toBe(`PATH='/root/.nvm/versions/node/v26.13.1/bin':"$PATH"; export PATH; `);
    expect(nodePathPrefix("node")).toBe("");
  });
});
