import { describe, expect, it } from "vitest";
import { frameNavigation } from "../../src/main/navigation";

const root = "file:///opt/Pi%20Desktop/resources/app/out/renderer";

describe("frameNavigation", () => {
  it("작업 공간 화면 파일로 가는 것(처음 열기·다시 불러오기)은 둔다", () => {
    expect(frameNavigation(`${root}/mate/index.html`, root)).toBe("allow");
    expect(frameNavigation(`${root}/agent/index.html#x`, `${root}/`)).toBe("allow");
  });

  it("응답 속 웹 링크는 프레임에서 열지 않고 바깥 브라우저로 보낸다", () => {
    expect(frameNavigation("https://news.ycombinator.com/item?id=1", root)).toBe("external");
    expect(frameNavigation("http://example.com/", root)).toBe("external");
  });

  it("그 밖의 주소와 화면 폴더 밖의 파일은 막는다", () => {
    expect(frameNavigation("file:///etc/passwd", root)).toBe("block");
    expect(frameNavigation(`${root}/../../secret.html`, root)).toBe("block");
    expect(frameNavigation(`${root}-other/index.html`, root)).toBe("block");
    expect(frameNavigation("javascript:alert(1)", root)).toBe("block");
    expect(frameNavigation("data:text/html,hi", root)).toBe("block");
    expect(frameNavigation("not a url", root)).toBe("block");
  });
});
