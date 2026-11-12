import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Mate가 쓴 글(대화 답·인박스·실행 기록)의 마크다운.
 * 링크는 늘 새 창으로 연다: Mate 화면은 Pi Desktop 창 안의 프레임(휴대폰 웹은 탭)이라,
 * 그냥 열면 Mate 화면 자체가 그 주소로 바뀌어 빈 화면이 되고 돌아올 수 없다.
 * 새 창 요청은 main이 받아 http(s)만 바깥 브라우저로 연다.
 */
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

export function MarkdownText({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
