/**
 * 창 안의 프레임(작업 공간 iframe)이 다른 주소로 가려 할 때 어떻게 할지.
 *
 * 창의 `will-navigate`는 맨 위 프레임만 막는다. Agent·Mate 화면은 프레임이라, 응답 속 링크를 그냥 누르면
 * 그 프레임이 통째로 그 웹 페이지로 바뀐다 (대부분 프레임 안에서 열리지 않아 빈 화면이 되고, 작업 공간으로 돌아올 수 없다).
 * 그래서 프레임 이동은 앱 화면 파일(작업 공간 화면, 다시 불러오기)만 두고 모두 막는다. http(s)면 바깥 브라우저로 연다.
 *
 * - allow: 앱의 화면 파일로 가는 것 (rendererRoot 아래의 file: 주소)
 * - external: http(s) 주소 → 막고 바깥 브라우저로
 * - block: 그 밖의 것 (다른 file: 주소, javascript:, data: 등)
 */
export type FrameNavigation = "allow" | "external" | "block";

/** @param rendererRoot 앱 화면 파일 폴더의 file: 주소 (끝에 / 없이도 된다) */
export function frameNavigation(url: string, rendererRoot: string): FrameNavigation {
  const root = rendererRoot.endsWith("/") ? rendererRoot : `${rendererRoot}/`;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return "block";
  }
  // 주소를 풀어 견준다 (../로 폴더 밖을 가리키는 것을 걸러 낸다)
  if (target.protocol === "file:") return target.href.startsWith(root) ? "allow" : "block";
  if (target.protocol === "http:" || target.protocol === "https:") return "external";
  return "block";
}
