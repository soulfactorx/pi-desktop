import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVICE_WORKER_PATH, WebPaths } from "../protocol";
import { bearerToken, isLoopbackAddress, loadOrCreateToken, requestAllowed, tokenMatches } from "./auth";
import { SERVICE_WORKER_SOURCE } from "./service-worker";
import { handleShareRequest } from "./share-inbox";
import { serveStatic } from "./static-files";

export interface HttpServerOptions {
  /** 화면에 보일 이름 (토큰 확인 응답) */
  app: string;
  version: string;
  port: number;
  host: string;
  /** 토큰·주소 파일·공유받은 이미지를 두는 곳 */
  dataDir: string;
  /** 화면 파일 (vite 결과) */
  publicDir: string;
  /** WebSocket 메시지 하나의 최대 크기 (이미지·파일이 base64로 한 메시지에 담긴다) */
  maxPayload: number;
  /** 주소·출처 확인을 마친 HTTP 요청 중 앱이 먼저 처리할 것. 처리했으면 true */
  route?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** 토큰을 확인한 WebSocket 연결 주소의 나머지 값 확인. false면 끊는다 */
  accept?: (url: URL) => boolean;
  /** 받아들인 WebSocket 연결 */
  connect: (ws: WebSocket, url: URL) => void;
}

/**
 * 클라우드 VM 등에서 다른 기기로 열 때의 설정 (환경 변수, 세 앱이 함께 쓴다).
 * - PI_WEB_TLS_CERT·PI_WEB_TLS_KEY: 인증서·키 파일(PEM). 있으면 HTTPS로 연다 (알림·홈 화면 앱은 HTTPS에서만 된다)
 * - PI_WEB_PUBLIC_HOST: 접속 주소에 쓸 이름 (인증서의 도메인, VM의 공인 IP 등). 없으면 이 기기의 주소들을 보인다
 */
export interface PublicOptions {
  tls?: { cert: string; key: string };
  publicHost?: string;
}

export function publicOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PublicOptions {
  const cert = env.PI_WEB_TLS_CERT?.trim();
  const key = env.PI_WEB_TLS_KEY?.trim();
  if (Boolean(cert) !== Boolean(key)) throw new Error("PI_WEB_TLS_CERT와 PI_WEB_TLS_KEY를 함께 주세요");
  const publicHost = env.PI_WEB_PUBLIC_HOST?.trim();
  return { ...(cert && key ? { tls: { cert, key } } : {}), ...(publicHost ? { publicHost } : {}) };
}

/** 주소에 넣을 호스트 (IPv6는 대괄호) */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * 접속 주소들. 첫 줄이 대표 주소(브라우저를 열 때 쓴다). 모든 주소(0.0.0.0)에서 들으면 이 기기의 바깥 주소들도 함께 보인다
 * (클라우드 VM·같은 와이파이의 다른 기기에서 열 주소).
 */
export function accessUrls(
  listenHost: string,
  port: number,
  token: string,
  options: PublicOptions,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const scheme = options.tls ? "https" : "http";
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::";
  const hosts: string[] = [];
  if (options.publicHost) hosts.push(options.publicHost);
  if (wildcard) {
    for (const list of Object.values(interfaces)) {
      for (const a of list ?? []) if (!a.internal && a.family === "IPv4") hosts.push(a.address);
    }
    hosts.push("127.0.0.1");
  } else {
    hosts.push(listenHost);
  }
  return [...new Set(hosts)].map((h) => `${scheme}://${urlHost(h)}:${port}/#token=${token}`);
}

export interface RunningServer {
  server: Server;
  /** 토큰이 든 접속 주소 (dataDir/url에도 쓴다) */
  url: string;
  close: () => void;
}

/**
 * 웹 버전 서버의 공통 바탕 (설계 DESIGN.md §5.10 "보안", §5.11). Pi Desktop·Agent·Mate 웹 서버가 함께 쓴다.
 * - 주소·출처 확인 (127.0.0.1이면 다른 사이트가 부르지 못하게)
 * - 휴대폰 공유 받기, 서비스 워커, 토큰 확인(/api/auth), 화면 파일
 * - 토큰을 확인한 WebSocket을 앱에 넘기고, 말없이 끊긴 연결은 정리한다
 * 서버가 뜨면 토큰이 든 주소를 dataDir/url에 쓴다 (pi-web url이 읽어 보여 준다).
 */
export function listenWebServer(options: HttpServerOptions, pub: PublicOptions = publicOptionsFromEnv()): Promise<RunningServer> {
  const token = loadOrCreateToken(join(options.dataDir, "token"));
  const loopbackOnly = isLoopbackAddress(options.host);
  const allowed = (req: IncomingMessage) => requestAllowed({ host: req.headers.host, origin: req.headers.origin }, loopbackOnly);

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // 다른 앱이 보낸 공유는 Origin이 이 서버가 아니므로 주소(Host)만 본다
    if (handleShareRequest(req, res, requestAllowed({ host: req.headers.host }, loopbackOnly))) return;
    if (!allowed(req)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("허용하지 않는 주소입니다");
      return;
    }
    const path = req.url?.split("?")[0];
    if (path === SERVICE_WORKER_PATH) {
      // 서비스 워커는 사이트 전체(/)를 맡는다. 바뀌면 바로 새것을 쓰도록 캐시하지 않는다
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
      res.end(SERVICE_WORKER_SOURCE);
      return;
    }
    if (path === WebPaths.auth) {
      const ok = tokenMatches(token, bearerToken(req.headers.authorization));
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(ok ? { ok: true, app: options.app, version: options.version } : { ok: false }));
      return;
    }
    if (options.route?.(req, res)) return;
    void serveStatic(options.publicDir, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  };
  const server: Server = pub.tls ? createHttpsServer({ cert: readFileSync(pub.tls.cert), key: readFileSync(pub.tls.key) }, handler) : createServer(handler);

  const sockets = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WebPaths.socket || !allowed(req) || !tokenMatches(token, url.searchParams.get("token")) || options.accept?.(url) === false) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      let alive = true;
      ws.on("pong", () => (alive = true));
      // 휴대폰 브라우저가 백그라운드로 가면 연결이 말없이 끊긴다. 응답 없는 연결은 정리한다
      const timer = setInterval(() => {
        if (!alive) return void ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);
      ws.once("close", () => clearInterval(timer));
      options.connect(ws, url);
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`포트 ${options.port}를 이미 쓰고 있습니다. --port로 다른 포트를 고르세요.`) : error),
    );
    server.listen(options.port, options.host, () => {
      const urls = accessUrls(options.host, options.port, token, pub);
      // 같은 기기의 다른 작업 공간(Agent·Mate 화면 틀)·실행 명령이 쓰는 대표 주소. 공개 이름이 없으면 이 기기 안의 주소
      const url = pub.publicHost ? urls[0]! : urls.at(-1)!;
      writeFileSync(join(options.dataDir, "url"), `${url}\n`, { mode: 0o600 });
      // 다른 기기에서 열 주소들 (pi-web url이 함께 보인다)
      const others = urls.filter((u) => u !== url);
      if (others.length) writeFileSync(join(options.dataDir, "urls"), `${others.join("\n")}\n`, { mode: 0o600 });
      else rmSync(join(options.dataDir, "urls"), { force: true });
      resolvePromise({
        server,
        url,
        close: () => {
          sockets.close();
          server.close();
        },
      });
    });
  });
}
