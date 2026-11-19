/**
 * 동영상 첨부 (설계 §4.1 "이미지 붙여넣기"). Pi와 모델은 동영상을 받지 않으므로(Pi의 입력은 글·이미지),
 * 동영상에서 고르게 장면을 뽑아 JPEG 이미지로 붙이고, 입력창에 어떤 동영상의 몇 초 장면인지 적는다.
 * 브라우저(Electron·휴대폰 웹)가 재생할 수 있는 형식(mp4·webm·mov 등)만 된다.
 * Pi Desktop의 같은 파일과 같은 내용 (Mate는 다른 앱의 파일을 가져오지 않는다).
 */

/** 동영상 하나에서 뽑는 장면 수 (남은 첨부 자리보다 많으면 줄인다) */
export const VIDEO_FRAMES = 6;
/** 장면 이미지의 긴 변 */
const MAX_SIDE = 1280;

export interface VideoFrame {
  name: string;
  mimeType: "image/jpeg";
  /** base64 (data URL 접두사 없음) */
  data: string;
  size: number;
  /** 동영상 안의 시각(초) */
  at: number;
}

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|3gp)$/i;

export function isVideoFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith("video/") || (!file.type && VIDEO_EXT.test(file.name));
}

/** 길이를 count 구간으로 나눈 각 구간의 가운데 시각 */
export function frameTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => Math.round(((duration * (i + 0.5)) / n) * 100) / 100);
}

/** 초 → 0:07, 1:02:03 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 입력창에 붙이는 설명 (모델이 이미지가 동영상의 장면임을 알게) */
export function videoNote(name: string, duration: number, frames: readonly { at: number }[]): string {
  const length = Number.isFinite(duration) && duration > 0 ? ` · 길이 ${formatClock(duration)}` : "";
  return `(동영상 ${name}${length}: 장면 ${frames.length}개를 시간순 이미지로 붙였습니다 — ${frames.map((f) => formatClock(f.at)).join(", ")})`;
}

/** 쓰던 글 끝에 설명을 한 줄로 붙인다 */
export function withVideoNote(draft: string, note: string): string {
  const before = draft.replace(/\s+$/, "");
  return before ? `${before}\n${note}\n` : `${note}\n`;
}

function once(target: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("동영상을 읽는 데 시간이 너무 걸립니다")), timeoutMs);
    const onEvent = () => done();
    const onError = () => done(new Error("이 동영상 형식은 열 수 없습니다 (mp4·webm을 써 보세요)"));
    const done = (error?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    target.addEventListener(event, onEvent);
    target.addEventListener("error", onError);
  });
}

/** 동영상에서 count개 장면을 뽑는다. 동영상 전체를 메모리에 읽지 않는다 (재생기가 필요한 부분만 읽음) */
export async function videoFrames(file: File, count: number): Promise<{ duration: number; frames: VideoFrame[] }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const loaded = once(video, "loadeddata", 20_000);
    video.src = url;
    await loaded;
    const duration = video.duration;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("장면을 그릴 수 없습니다");
    const frames: VideoFrame[] = [];
    const base = file.name || "동영상";
    for (const at of frameTimes(duration, count)) {
      if (Math.abs(video.currentTime - at) > 0.01) {
        const seeked = once(video, "seeked", 15_000);
        video.currentTime = at;
        await seeked;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.82).split(",", 2)[1] ?? "";
      if (!data) continue;
      frames.push({ name: `${base} ${formatClock(at)}`, mimeType: "image/jpeg", data, size: Math.floor((data.length * 3) / 4), at });
    }
    if (frames.length === 0) throw new Error("장면을 뽑지 못했습니다");
    return { duration, frames };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
