import { describe, expect, it } from "vitest";
import { accessUrls, publicOptionsFromEnv } from "../src/server/http-server";

const nets = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [
    { address: "10.0.0.5", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
} as never;

describe("접속 주소 (클라우드 VM)", () => {
  it("이 기기에서만 열면 그 주소 하나", () => {
    expect(accessUrls("127.0.0.1", 8787, "T", {}, nets)).toEqual(["http://127.0.0.1:8787/#token=T"]);
  });

  it("모든 주소에서 열면 바깥 주소들과 127.0.0.1을, 공개 이름이 있으면 맨 앞에 둔다", () => {
    expect(accessUrls("0.0.0.0", 8787, "T", {}, nets)).toEqual(["http://10.0.0.5:8787/#token=T", "http://127.0.0.1:8787/#token=T"]);
    expect(accessUrls("0.0.0.0", 8788, "T", { publicHost: "pi.example.com", tls: { cert: "c", key: "k" } }, nets)).toEqual([
      "https://pi.example.com:8788/#token=T",
      "https://10.0.0.5:8788/#token=T",
      "https://127.0.0.1:8788/#token=T",
    ]);
  });

  it("환경 변수에서 인증서·공개 이름을 읽고, 인증서와 키는 함께 있어야 한다", () => {
    expect(publicOptionsFromEnv({})).toEqual({});
    expect(publicOptionsFromEnv({ PI_WEB_TLS_CERT: "/c", PI_WEB_TLS_KEY: "/k", PI_WEB_PUBLIC_HOST: " pi.example.com " })).toEqual({
      tls: { cert: "/c", key: "/k" },
      publicHost: "pi.example.com",
    });
    expect(() => publicOptionsFromEnv({ PI_WEB_TLS_CERT: "/c" })).toThrow(/함께/);
  });
});
