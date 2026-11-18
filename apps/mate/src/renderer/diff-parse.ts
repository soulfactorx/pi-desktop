/**
 * unified diff(git diff)를 파일·줄 단위로 나눈다. 화면(DiffView)이 GitHub처럼 색·줄 번호로 보인다.
 * 형식을 모르는 줄은 버리지 않고 "meta"로 남긴다.
 */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 바꾸기 전·뒤 줄 번호 (해당하는 쪽만) */
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  path: string;
  /** 새 파일·지운 파일·이름 바꿈·바이너리 */
  note?: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function cleanPath(p: string): string {
  const s = p.trim().replace(/^"|"$/g, "");
  return s === "/dev/null" ? "" : s.replace(/^[ab]\//, "");
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const open = (path: string): DiffFile => {
    file = { path, added: 0, removed: 0, lines: [] };
    files.push(file);
    inHunk = false;
    return file;
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
      open(m ? m[2]! : raw.slice("diff --git ".length));
      continue;
    }
    // git 머리말이 없는 diff (diff -u)
    if (!inHunk && raw.startsWith("--- ") && (!file || file.lines.length > 0)) open(cleanPath(raw.slice(4)));
    if (!file) {
      if (raw.trim()) open("").lines.push({ kind: "meta", text: raw });
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("--- ")) {
        if (!file.path) file.path = cleanPath(raw.slice(4));
      } else if (raw.startsWith("+++ ")) {
        const p = cleanPath(raw.slice(4));
        if (p) file.path = p;
      } else if (raw.startsWith("new file")) file.note = "새 파일";
      else if (raw.startsWith("deleted file")) file.note = "지움";
      else if (raw.startsWith("rename to ")) file.note = "이름 바꿈";
      else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) file.note = file.note ? `${file.note} · 바이너리` : "바이너리";
      continue;
    }
    if (raw.startsWith("+")) {
      file.added++;
      file.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      file.removed++;
      file.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (raw.startsWith("\\")) {
      file.lines.push({ kind: "meta", text: raw.slice(2) });
    } else if (raw !== "") {
      inHunk = false;
    }
  }
  return files.filter((f) => f.path || f.lines.length > 0);
}
