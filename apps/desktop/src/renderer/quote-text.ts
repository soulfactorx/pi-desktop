/** 인용해서 묻기에 넣는 글의 최대 길이. 넘으면 앞부분만 넣는다 */
export const QUOTE_MAX = 4000;

/**
 * 고른 글을 마크다운 인용(> )으로 바꿔 입력창 글 끝에 붙인다. 그 아래 빈 줄에 이어서 질문을 쓰게 한다.
 * (Pi Desktop·Agent·Mate가 같은 규칙을 쓴다. Mate는 같은 내용의 파일을 따로 둔다)
 */
export function withQuote(draft: string, selected: string): string {
  let text = selected.replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  if (!text) return draft;
  if (text.length > QUOTE_MAX) text = `${text.slice(0, QUOTE_MAX)}…`;
  const quote = text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const before = draft.replace(/\s+$/, "");
  return `${before ? `${before}\n\n` : ""}${quote}\n\n`;
}
