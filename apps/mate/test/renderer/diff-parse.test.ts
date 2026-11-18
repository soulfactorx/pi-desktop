import { describe, expect, it } from "vitest";
import { parseDiff } from "../../src/renderer/diff-parse";

const PATCH = `diff --git a/Dockerfile b/Dockerfile
index 1111111..2222222 100644
--- a/Dockerfile
+++ b/Dockerfile
@@ -1,4 +1,5 @@
 FROM node:20
-COPY docker/ /opt/docker/
+RUN --mount=type=bind,source=docker,target=/tmp/docker \\
+    cp -r /tmp/docker /opt/docker
 WORKDIR /app
\\ No newline at end of file
diff --git a/.dockerignore b/.dockerignore
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/.dockerignore
@@ -0,0 +1,2 @@
+node_modules
+--- 이 줄은 내용이다
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
GIT binary patch
literal 10
`;

describe("diff 나누기", () => {
  it("파일마다 나누고, 더한 줄·뺀 줄과 줄 번호를 센다", () => {
    const files = parseDiff(PATCH);
    expect(files.map((f) => f.path)).toEqual(["Dockerfile", ".dockerignore", "logo.png"]);
    const [docker, ignore, logo] = files;
    expect([docker!.added, docker!.removed]).toEqual([2, 1]);
    expect(docker!.lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx", "meta"]);
    expect(docker!.lines[2]).toMatchObject({ kind: "del", oldNo: 2, text: "COPY docker/ /opt/docker/" });
    expect(docker!.lines[4]).toMatchObject({ kind: "add", newNo: 3 });
    expect(docker!.lines[5]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
    // 새 파일, 그리고 "+---"로 시작하는 내용 줄을 머리말로 잘못 읽지 않는다
    expect(ignore).toMatchObject({ note: "새 파일", added: 2, removed: 0 });
    expect(ignore!.lines.at(-1)!.text).toBe("--- 이 줄은 내용이다");
    expect(logo!.note).toBe("바이너리");
  });

  it("git 머리말이 없는 diff -u도 읽고, Windows 줄 끝을 견딘다", () => {
    const files = parseDiff("--- a.txt\r\n+++ b.txt\r\n@@ -1 +1 @@\r\n-one\r\n+two\r\n");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "b.txt", added: 1, removed: 1 });
  });
});
