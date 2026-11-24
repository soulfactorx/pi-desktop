import { useEffect, useRef, useState } from "react";
import type { AssistantBlock, ChatItem } from "./chat-state";
import { formatMessageTime, formatUsageLine } from "./format";
import { Markdown } from "./markdown/Markdown";
import { resendCandidate } from "./run-status";
import { ToolCard, type ToolCardActions } from "./ToolCards";
import { ChatNavigator } from "./ChatNavigator";
import { QuoteAsk } from "./QuoteAsk";
import { useLightbox, type LightboxImage } from "./ImageLightbox";
import { workingStatus } from "./working-status";

/** 대화 목록. 새 내용이 오면 사용자가 위로 스크롤해 둔 경우가 아니면 맨 아래로 따라간다. */
export function ChatView({
  items,
  running,
  actions,
  onResend,
  onQuote,
}: {
  items: ChatItem[];
  running: boolean;
  actions: ToolCardActions;
  /** 오류로 끝난 마지막 응답의 질문을 입력창에 다시 채운다 */
  onResend?: (text: string) => void;
  /** 대화에서 고른 글을 입력창에 인용으로 넣는다 ("이 부분 묻기") */
  onQuote?: (text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const resend = running ? undefined : resendCandidate(items);
  const lightbox = useLightbox();

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.length === 0 && <p className="empty">세션을 열고 메시지를 보내 보세요.</p>}
      {items.map((item) => (
        <Item
          key={item.key}
          item={item}
          actions={actions}
          onOpenImage={lightbox.open}
          onResend={resend && onResend && item.key === resend.anchorKey ? () => onResend(resend.text) : undefined}
        />
      ))}
      {running && <Working items={items} />}
      <ChatNavigator scroller={scroller} turnSelector=".msg.user" />
      {onQuote && <QuoteAsk root={scroller} onQuote={onQuote} />}
      {lightbox.element}
    </div>
  );
}

/**
 * "Pi가 작업 중…" 줄: 걸린 시간·지금 하는 일, 새 출력이 오래 없으면 그 시간과 안내 (working-status.ts).
 * 이 화면이 작업을 처음 본 때부터 센다 (세션을 다시 열면 그때부터).
 */
function Working({ items }: { items: ChatItem[] }) {
  const [startedAt] = useState(() => Date.now());
  const lastActivity = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  // 새 출력(델타·도구 결과)이 오면 items가 바뀐다
  useEffect(() => {
    lastActivity.current = Date.now();
  }, [items]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const status = workingStatus(items, startedAt, lastActivity.current, now);
  return (
    <div className={`working${status.quiet ? " quiet" : ""}`} role="status">
      <span className="working-dot" aria-hidden="true" />
      <span>
        Pi가 작업 중… <span className="working-doing">{status.doing}</span> · {status.elapsed}
        {status.quiet && <span className="working-quiet"> · 새 출력 없음 {status.quiet}</span>}
      </span>
      {status.hint && <div className="working-hint">{status.hint}</div>}
    </div>
  );
}

function Item({
  item,
  actions,
  onResend,
  onOpenImage,
}: {
  item: ChatItem;
  actions: ToolCardActions;
  onResend: (() => void) | undefined;
  /** 보낸 이미지를 크게 본다 */
  onOpenImage: (images: LightboxImage[], index: number) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          {item.images && item.images.length > 0 && (
            <div className="msg-images">
              {item.images.map((image, i) => (
                <img
                  key={i}
                  className="zoomable"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`첨부 이미지 ${i + 1}`}
                  title="누르면 크게 봅니다"
                  onClick={() => onOpenImage(item.images!.map((im, j) => ({ src: `data:${im.mimeType};base64,${im.data}`, name: `첨부 이미지 ${j + 1}` })), i)}
                />
              ))}
            </div>
          )}
          {item.text}
          {item.at !== undefined && <div className="msg-meta">{formatMessageTime(item.at)}</div>}
        </div>
      );
    case "assistant":
      return (
        <div className={`msg assistant${item.done ? "" : " streaming"}`}>
          {item.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
          {item.stopReason === "error" && (
            <div className="error-line">
              <span>오류: {item.errorMessage ?? "알 수 없음"}</span>
              {onResend && <ResendButton onClick={onResend} />}
            </div>
          )}
          {item.stopReason === "aborted" && <div className="muted">중단됨</div>}
          {item.done && (item.at !== undefined || item.usage) && (
            <div
              className="msg-meta"
              title={
                item.usage
                  ? `입력 ${item.usage.input} · 캐시 쓰기 ${item.usage.cacheWrite} · 캐시 읽기 ${item.usage.cacheRead} · 출력 ${item.usage.output} 토큰`
                  : undefined
              }
            >
              {[item.at !== undefined ? formatMessageTime(item.at) : "", item.usage ? formatUsageLine(item.usage) : ""].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      );
    case "tool":
      return <ToolCard item={item} actions={actions} />;
    case "notice":
      return (
        <div className={`notice ${item.level}`}>
          {item.detail ? (
            // TUI처럼 눌러서 요약 내용을 펼쳐 본다
            <details className="notice-detail">
              <summary>{item.text}</summary>
              <div className="notice-detail-body">
                <Markdown text={item.detail} />
              </div>
            </details>
          ) : (
            item.text
          )}
          {onResend && <ResendButton onClick={onResend} />}
        </div>
      );
  }
}

function ResendButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="small resend" onClick={onClick} title="이 질문을 입력창에 다시 채웁니다. 고쳐서 보낼 수 있습니다">
      다시 보내기
    </button>
  );
}

function Block({ block }: { block: AssistantBlock }) {
  if (block.type === "thinking") {
    return block.text ? (
      <details className="thinking">
        <summary>생각</summary>
        <div>{block.text}</div>
      </details>
    ) : null;
  }
  if (block.type === "toolCall") return null; // 툴 실행 카드에서 따로 보여준다.
  return <Markdown text={block.text} />;
}
