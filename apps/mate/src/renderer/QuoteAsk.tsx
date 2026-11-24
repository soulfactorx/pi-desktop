import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Spot {
  text: string;
  left: number;
  top: number;
}

/**
 * 대화에서 글을 고르면 그 끝에 "이 부분 묻기"·"복사" 단추를 띄운다. 묻기는 고른 글을 입력창에 인용으로 넣고 입력창으로 가고,
 * 복사는 고른 글을 클립보드에 넣는다 (휴대폰에서는 길게 눌러 고른 뒤 복사 메뉴를 찾기 번거롭다).
 * 복사해서 붙여 넣지 않고 답의 일부를 짚어 다시 물을 수 있게 한다 (Pi Desktop의 QuoteAsk.tsx와 같은 내용. Mate는 다른 앱의 파일을 가져오지 않으므로 따로 둔다).
 *
 * - root 안에서 고른 글만 본다 (입력창·다른 패널의 선택은 무시).
 * - 단추를 누를 때 선택이 풀리지 않게 mousedown 기본 동작을 막는다.
 * - 화면 맨 위에 그리므로(portal) 대화 상자의 스크롤·overflow에 잘리지 않는다.
 */
export function QuoteAsk({ root, onQuote }: { root: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  const [spot, setSpot] = useState<Spot>();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const check = () => {
      const el = root.current;
      const sel = document.getSelection();
      if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return setSpot(undefined);
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setSpot(undefined);
      const text = sel.toString().trim();
      if (!text) return setSpot(undefined);
      const rects = range.getClientRects();
      const end = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // 고른 끝이 대화 상자 밖으로 스크롤되면 숨긴다
      if (end.bottom < box.top || end.top > box.bottom) return setSpot(undefined);
      const width = 230;
      const left = Math.max(8, Math.min(end.right - width / 2, window.innerWidth - width - 8));
      const below = end.bottom + 8;
      const top = below + 36 > Math.min(box.bottom, window.innerHeight) ? Math.max(8, end.top - 44) : below;
      setSpot({ text, left, top });
      setCopied(false);
    };
    const later = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(check, 150);
    };
    const el = root.current;
    document.addEventListener("selectionchange", later);
    el?.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("selectionchange", later);
      el?.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
    };
  }, [root]);

  if (!spot) return null;
  return createPortal(
    // 단추를 누를 때 선택이 풀리지 않게 mousedown 기본 동작을 막는다
    <div className="quote-ask-bar" style={{ left: spot.left, top: spot.top }} onMouseDown={(e) => e.preventDefault()}>
      <button
        type="button"
        className="quote-ask"
        title="고른 글을 입력창에 인용으로 넣고 이어서 묻습니다"
        onClick={() => {
          const from = root.current;
          onQuote(spot.text);
          document.getSelection()?.removeAllRanges();
          setSpot(undefined);
          if (from) focusComposer(from);
        }}
      >
        ↩ 이 부분 묻기
      </button>
      <button
        type="button"
        className="quote-ask"
        title="고른 글을 복사합니다"
        onClick={() => {
          void copyText(spot.text).then((ok) => {
            setCopied(ok);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setSpot(undefined), ok ? 900 : 0);
          });
        }}
      >
        {copied ? "✓ 복사함" : "⧉ 복사"}
      </button>
    </div>,
    document.body,
  );
}

/**
 * 클립보드에 글을 넣는다. 보안 연결이 아닌 웹(http로 연 휴대폰 웹)에는 navigator.clipboard가 없어
 * 지금 고른 글을 복사 명령으로 넣는다 (단추를 눌러도 선택은 그대로 남아 있다).
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 아래 복사 명령으로
  }
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** 대화 상자 가까이에 있는 입력창(쓸 수 있고 보이는 textarea)으로 가서 글 끝에 커서를 둔다 */
export function focusComposer(from: HTMLElement): void {
  requestAnimationFrame(() => {
    for (let node: HTMLElement | null = from.parentElement; node; node = node.parentElement) {
      const input = [...node.querySelectorAll("textarea")].find((t) => !t.disabled && !t.readOnly && t.offsetParent !== null);
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
        input.scrollTop = input.scrollHeight;
        return;
      }
    }
  });
}
