import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface LightboxImage {
  src: string;
  name?: string;
}

/**
 * 이미지를 화면 가득 크게 본다. 첨부한 이미지(입력창·보낸 질문)를 누르면 열린다.
 * Esc·바깥 누르기로 닫고, ←/→로 같은 묶음의 다른 이미지로 간다. 이미지를 누르면 원본 크기 ↔ 화면에 맞춤.
 * Pi Desktop·Agent가 같이 쓰고, Mate는 같은 내용의 파일을 따로 둔다.
 */
export function ImageLightbox({ images, index, onClose }: { images: LightboxImage[]; index: number; onClose: () => void }) {
  const [at, setAt] = useState(Math.min(Math.max(0, index), images.length - 1));
  const [actual, setActual] = useState(false);
  const move = useCallback(
    (step: number) => {
      setActual(false);
      setAt((i) => (i + step + images.length) % images.length);
    },
    [images.length],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && images.length > 1) move(-1);
      else if (e.key === "ArrowRight" && images.length > 1) move(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [images.length, move, onClose]);
  const image = images[at];
  if (!image) return null;
  return createPortal(
    <div className={`lightbox${actual ? " actual" : ""}`} role="dialog" aria-modal="true" aria-label="이미지 크게 보기" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{image.name ?? "이미지"}</span>
        {images.length > 1 && (
          <span className="lightbox-count">
            {at + 1} / {images.length}
          </span>
        )}
        <a className="lightbox-button" href={image.src} download={image.name || "image"} title="내려받기">
          ⤓
        </a>
        <button type="button" className="lightbox-button" onClick={onClose} title="닫기 (Esc)" aria-label="닫기">
          ×
        </button>
      </div>
      <div className="lightbox-stage">
        <img
          src={image.src}
          alt={image.name ?? "이미지"}
          title={actual ? "누르면 화면에 맞춥니다" : "누르면 원본 크기로 봅니다"}
          onClick={(e) => {
            e.stopPropagation();
            setActual(!actual);
          }}
        />
      </div>
      {images.length > 1 && (
        <>
          <button type="button" className="lightbox-nav prev" aria-label="이전 이미지" onClick={(e) => (e.stopPropagation(), move(-1))}>
            ‹
          </button>
          <button type="button" className="lightbox-nav next" aria-label="다음 이미지" onClick={(e) => (e.stopPropagation(), move(1))}>
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** 크게 보기를 여는 함수와, 화면에 둘 요소 */
export function useLightbox(): { open: (images: LightboxImage[], index: number) => void; element: ReactNode } {
  const [view, setView] = useState<{ images: LightboxImage[]; index: number }>();
  const open = useCallback((images: LightboxImage[], index: number) => setView({ images, index }), []);
  const element = view ? <ImageLightbox images={view.images} index={view.index} onClose={() => setView(undefined)} /> : null;
  return { open, element };
}
