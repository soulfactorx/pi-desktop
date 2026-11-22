import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { listenWebServer, type RunningServer } from "../src/server/http-server";

describe("웹 서버 공통 바탕 (server/http-server)", () => {
  let dir: string;
  let running: RunningServer;
  let base: string;
  let token: string;
  const connected: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "web-shell-http-"));
    writeFileSync(join(dir, "index.html"), "<p>화면</p>");
    running = await listenWebServer({
      app: "시험 앱",
      version: "1.2.3",
      port: 0,
      host: "127.0.0.1",
      dataDir: dir,
      publicDir: dir,
      maxPayload: 1024,
      route: (req, res) => {
        if (req.url !== "/app-route") return false;
        res.writeHead(200).end("앱 경로");
        return true;
      },
      accept: (url) => url.searchParams.get("client") !== "bad",
      connect: (ws, url) => {
        connected.push(url.searchParams.get("client") ?? "");
        ws.close();
      },
    });
    base = `http://127.0.0.1:${(running.server!.address() as AddressInfo).port}`;
    token = readFileSync(join(dir, "token"), "utf8").trim();
  });
  afterAll(() => {
    running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("토큰이 든 주소를 dataDir/url에 쓴다", () => {
    expect(readFileSync(join(dir, "url"), "utf8").trim()).toBe(running.url);
    expect(running.url).toContain(`#token=${token}`);
  });

  it("토큰 확인: 맞으면 앱 이름과 버전, 틀리면 401", async () => {
    const ok = await fetch(`${base}/api/auth`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await ok.json()).toEqual({ ok: true, app: "시험 앱", version: "1.2.3" });
    expect((await fetch(`${base}/api/auth`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("앱 경로를 먼저 묻고, 나머지는 화면 파일로 내준다", async () => {
    expect(await (await fetch(`${base}/app-route`)).text()).toBe("앱 경로");
    expect(await (await fetch(`${base}/`)).text()).toBe("<p>화면</p>");
  });

  it("다른 사이트의 요청은 막는다", async () => {
    expect((await fetch(`${base}/`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("WebSocket은 토큰과 앱의 확인을 거친 연결만 넘긴다", async () => {
    const open = (query: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${query}`);
        ws.once("open", () => resolve(true));
        ws.once("error", () => resolve(false));
      });
    expect(await open("token=nope&client=a")).toBe(false);
    expect(await open(`token=${token}&client=bad`)).toBe(false);
    expect(await open(`token=${token}&client=good`)).toBe(true);
    expect(connected).toEqual(["good"]);
  });
});

describe("한 포트: 다른 앱을 경로 아래에 붙인다 (mount)", () => {
  let dir: string;
  let main: RunningServer;
  let sub: RunningServer;
  let base: string;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "web-shell-mount-"));
    writeFileSync(join(dir, "index.html"), "<p>주 화면</p>");
    const subPublic = mkdtempSync(join(tmpdir(), "web-shell-mount-pub-"));
    writeFileSync(join(subPublic, "index.html"), "<p>붙은 화면</p>");
    main = await listenWebServer({ app: "주 앱", version: "1", maxPayload: 1024, port: 0, host: "127.0.0.1", dataDir: dir, publicDir: dir, accept: () => true, connect: (ws) => ws.close() });
    base = `http://127.0.0.1:${(main.server!.address() as AddressInfo).port}`;
    sub = await listenWebServer({
      app: "붙은 앱",
      version: "2",
      maxPayload: 1024,
      port: 0,
      host: "127.0.0.1",
      dataDir: join(dir, "sub"),
      publicDir: subPublic,
      mount: { prefix: "/sub/", tokenFile: join(dir, "token"), baseUrl: `${base}/` },
      accept: () => true,
      connect: (ws) => ws.close(),
    });
    token = readFileSync(join(dir, "token"), "utf8").trim();
  });
  afterAll(() => {
    sub.close();
    main.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("같은 토큰으로 경로 아래 주소를 알리고, 따로 듣지 않는다", () => {
    expect(sub.url).toBe(`${base}/sub/#token=${token}`);
    expect(sub.server).toBeUndefined();
    expect(readFileSync(join(dir, "sub", "url"), "utf8").trim()).toBe(sub.url);
  });

  it("경로 아래 요청은 붙은 앱이, 나머지는 주 앱이 받는다", async () => {
    const auth = await fetch(`${base}/sub/api/auth`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await auth.json()).toEqual({ ok: true, app: "붙은 앱", version: "2" });
    expect(await (await fetch(`${base}/sub/`)).text()).toBe("<p>붙은 화면</p>");
    expect(await (await fetch(`${base}/`)).text()).toBe("<p>주 화면</p>");
    const bare = await fetch(`${base}/sub`, { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/sub/");
    expect((await fetch(`${base}/sub/`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("경로 아래 WebSocket도 붙은 앱으로 넘긴다", async () => {
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/sub/ws?token=${token}`);
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });
});
