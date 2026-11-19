import { describe, expect, it } from "vitest";
import { formatClock, frameTimes, isVideoFile, videoNote, withVideoNote } from "../../src/renderer/video-frames";
import * as mate from "../../../mate/src/renderer/video-frames";

describe("동영상 장면 뽑기 규칙", () => {
  it("길이를 고르게 나눈 구간의 가운데에서 뽑는다", () => {
    expect(frameTimes(60, 6)).toEqual([5, 15, 25, 35, 45, 55]);
    expect(frameTimes(Number.POSITIVE_INFINITY, 6)).toEqual([0]);
    expect(frameTimes(10, 0)).toEqual([5]);
  });

  it("동영상 파일을 알아보고, 시각을 읽기 좋게 쓴다", () => {
    expect(isVideoFile({ type: "video/mp4", name: "a.mp4" })).toBe(true);
    expect(isVideoFile({ type: "", name: "clip.MOV" })).toBe(true);
    expect(isVideoFile({ type: "image/png", name: "a.png" })).toBe(false);
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(3723)).toBe("1:02:03");
  });

  it("입력창에 어떤 동영상의 어느 장면인지 적는다", () => {
    const note = videoNote("clip.mp4", 42, [{ at: 3.5 }, { at: 10.5 }]);
    expect(note).toBe("(동영상 clip.mp4 · 길이 0:42: 장면 2개를 시간순 이미지로 붙였습니다 — 0:03, 0:10)");
    expect(withVideoNote("이거 봐 줘  ", note)).toBe(`이거 봐 줘\n${note}\n`);
    expect(withVideoNote("", note)).toBe(`${note}\n`);
    expect(mate.videoNote("clip.mp4", 42, [{ at: 3.5 }])).toBe(videoNote("clip.mp4", 42, [{ at: 3.5 }]));
  });
});
