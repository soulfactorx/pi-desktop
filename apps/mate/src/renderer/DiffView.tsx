import { useMemo, useState } from "react";
import { parseDiff, type DiffFile } from "./diff-parse";

/** 한 번에 그리는 줄 수. 넘으면 "더 보기" */
const PAGE = 400;

/**
 * 바뀐 내용을 GitHub처럼 보인다: 파일마다 접는 머리(이름, +더한 줄 −뺀 줄), 줄 번호, 더한 줄 초록·뺀 줄 빨강.
 * 마크다운의 ```diff 블록이 이 화면으로 그려진다 (MarkdownText).
 */
export function DiffView({ text }: { text: string }) {
  const files = useMemo(() => parseDiff(text), [text]);
  if (files.length === 0) return <pre>{text}</pre>;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="diff-view">
      {files.length > 1 && (
        <div className="diff-total muted">
          파일 {files.length}개 · <span className="diff-plus">+{added}</span> <span className="diff-minus">−{removed}</span>
        </div>
      )}
      {files.map((f, i) => (
        <DiffFileView key={`${f.path}:${i}`} file={f} />
      ))}
    </div>
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const lines = file.lines.slice(0, shown);
  return (
    <div className="diff-file">
      <button type="button" className="diff-file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="diff-caret">{open ? "▾" : "▸"}</span>
        <span className="diff-path">{file.path || "(파일 이름 없음)"}</span>
        {file.note && <span className="chip">{file.note}</span>}
        <span className="diff-counts">
          <span className="diff-plus">+{file.added}</span> <span className="diff-minus">−{file.removed}</span>
        </span>
      </button>
      {open && (
        <div className="diff-body">
          {file.lines.length === 0 && <div className="diff-empty muted">{file.note ?? "내용 없음"}</div>}
          <table>
            <tbody>
              {lines.map((l, i) =>
                l.kind === "hunk" || l.kind === "meta" ? (
                  <tr key={i} className={`diff-${l.kind}`}>
                    <td className="diff-no" colSpan={2} />
                    <td className="diff-text">{l.text}</td>
                  </tr>
                ) : (
                  <tr key={i} className={`diff-${l.kind}`}>
                    <td className="diff-no">{l.oldNo ?? ""}</td>
                    <td className="diff-no">{l.newNo ?? ""}</td>
                    <td className="diff-text">
                      <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                      {l.text || " "}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {file.lines.length > shown && (
            <button type="button" className="link diff-more" onClick={() => setShown(shown + PAGE * 5)}>
              나머지 {file.lines.length - shown}줄 더 보기
            </button>
          )}
        </div>
      )}
    </div>
  );
}
