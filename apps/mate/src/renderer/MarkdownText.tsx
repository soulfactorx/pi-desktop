import Markdown, { type Components } from "react-markdown";
import { isValidElement, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import { DiffView } from "./DiffView";

/**
 * Mate가 쓴 글(대화 답·인박스·실행 기록)의 마크다운.
 * 링크는 늘 새 창으로 연다: Mate 화면은 Pi Desktop 창 안의 프레임(휴대폰 웹은 탭)이라,
 * 그냥 열면 Mate 화면 자체가 그 주소로 바뀌어 빈 화면이 되고 돌아올 수 없다.
 * 새 창 요청은 main이 받아 http(s)만 바깥 브라우저로 연다.
 */
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  // ```diff 블록은 색·줄 번호가 있는 diff 화면으로 그린다
  pre: ({ node: _node, children, ...props }) => {
    const diff = diffSource(children);
    return diff === undefined ? <pre {...props}>{children}</pre> : <DiffView text={diff} />;
  },
};

function diffSource(children: ReactNode): string | undefined {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return undefined;
  if (!/\blanguage-(diff|patch)\b/.test(child.props.className ?? "")) return undefined;
  const text = child.props.children;
  return typeof text === "string" ? text : Array.isArray(text) ? text.join("") : undefined;
}

export function MarkdownText({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
