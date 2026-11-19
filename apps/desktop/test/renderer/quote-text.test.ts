import { describe, expect, it } from "vitest";
import { QUOTE_MAX, withQuote } from "../../src/renderer/quote-text";
import { withQuote as mateWithQuote } from "../../../mate/src/renderer/quote-text";

describe("고른 글 인용하기", () => {
  it("빈 입력창이면 인용과 빈 줄을 넣고, 쓰던 글이 있으면 그 뒤에 붙인다", () => {
    expect(withQuote("", "첫 줄\r\n\r\n둘째 줄  ")).toBe("> 첫 줄\n>\n> 둘째 줄\n\n");
    expect(withQuote("이것도 궁금해\n\n", "결과")).toBe("이것도 궁금해\n\n> 결과\n\n");
  });

  it("빈 선택은 무시하고, 너무 길면 자른다", () => {
    expect(withQuote("그대로", "   ")).toBe("그대로");
    const long = withQuote("", "가".repeat(QUOTE_MAX + 10));
    expect(long.length).toBeLessThan(QUOTE_MAX + 10);
    expect(long).toContain("…");
  });

  it("Mate도 같은 규칙이다", () => {
    expect(mateWithQuote("질문", "a\nb")).toBe(withQuote("질문", "a\nb"));
  });
});
