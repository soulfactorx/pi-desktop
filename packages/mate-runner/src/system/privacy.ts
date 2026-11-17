import { basename } from "node:path";
import { redact } from "../activity";

/**
 * 시스템 관찰의 개인정보 보호 (설계 DESIGN-MATE.md §10.1).
 * 로그 한 줄·명령·프로그램 이름은 여기를 거친 뒤에만 남긴다.
 */

/** 로그 한 줄을 남길 수 있게 가린다: 비밀값, 홈 경로·사용자 이름, 메일, IP, 주소의 경로·쿼리, 긴 16진수·base64 */
export function scrubText(text: string, home: string, user: string, limit = 160): string {
  let out = redact(String(text ?? "").replace(/\s+/g, " ").trim()).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<메일>");
  if (home) out = out.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  if (user && user.length >= 3) out = out.replace(new RegExp(escapeRegExp(user), "gi"), "<사용자>");
  out = out
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "<IP>")
    .replace(/\b([0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "<IP>")
    .replace(/\b(https?:\/\/[^/\s?#]+)[^\s]*/gi, "$1/…")
    .replace(/\b[0-9a-f]{24,}\b/gi, "[가림]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[가림]")
    // 홈 밖의 사용자 폴더 (C:\Users\이름, /home/이름, /Users/이름)
    .replace(/([\\/](?:Users|home)[\\/])[^\\/\s]+/gi, "$1<사용자>");
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 기록하지 않을 명령 (비밀이 섞이기 쉽거나 개인적인 것) */
const SENSITIVE_PROGRAMS = new Set([
  "ssh", "scp", "sftp", "mosh", "telnet", "ftp",
  "export", "set", "setx", "env", "unset", "printenv",
  "pass", "gopass", "gpg", "gpg2", "op", "bw", "keepassxc-cli", "security", "secret-tool",
  "mysql", "psql", "mongo", "mongosh", "redis-cli", "sqlite3",
  "openssl", "htpasswd", "ssh-keygen", "ssh-add", "ssh-copy-id",
  "su", "passwd", "chpasswd",
]);

const SENSITIVE_WORDS = /pass(word|wd)?|token|secret|api[_-]?key|private[_-]?key|credential|auth|bearer|cookie|session[_-]?id/i;

/** 기록하지 않을 명령인지: 공백으로 시작(셸 관례상 기록 숨김), 민감한 프로그램, 비밀을 담은 듯한 줄 */
export function isSensitiveCommand(line: string): boolean {
  if (/^\s/.test(line)) return true;
  if (SENSITIVE_WORDS.test(line)) return true;
  if (/(^|\s)[A-Za-z_][A-Za-z0-9_]*=\S/.test(line.split(/\s+/)[0] ?? "")) return true; // VAR=값 명령
  const program = programName(line);
  return program !== undefined && SENSITIVE_PROGRAMS.has(program);
}

/** 자주 써도 뜻이 없는 명령 (되풀이 작업 찾기에서 뺀다) */
const TRIVIAL = new Set([
  "cd", "ls", "ll", "la", "l", "dir", "pwd", "clear", "cls", "exit", "logout", "history", "echo", "cat", "less", "more", "head", "tail",
  "vim", "vi", "nvim", "nano", "emacs", "code", "man", "help", "which", "where", "type", "z", "j", "fg", "bg", "jobs", "true", "false",
  "source", ".", "alias", "unalias", "whoami", "date", "reset", "tree", "open", "start", "explorer", "notepad", "get-childitem", "set-location",
]);

/** 하위 명령이 뜻을 갖는 프로그램 (git pull, npm test …) */
const WITH_SUBCOMMAND = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "pi", "docker", "docker-compose", "podman", "kubectl", "helm", "terraform",
  "cargo", "go", "dotnet", "mvn", "gradle", "pip", "pip3", "poetry", "uv", "conda", "brew", "apt", "apt-get", "dnf", "yum", "pacman",
  "winget", "choco", "scoop", "systemctl", "journalctl", "make", "just", "az", "gcloud", "aws", "firebase", "vercel", "netlify", "flutter", "rustup",
]);

/** npm run X처럼 세 번째 낱말까지 보는 경우 */
const WITH_SCRIPT = new Set(["npm run", "pnpm run", "yarn run", "bun run", "docker compose"]);

/** 맨 앞 프로그램 이름 (경로·.exe를 떼고 소문자). 이상한 글자면 undefined */
export function programName(line: string): string | undefined {
  const words = line.trim().split(/\s+/);
  let i = 0;
  while (words[i] === "sudo" || words[i] === "doas" || words[i] === "time" || words[i] === "nohup" || words[i] === "&") i++;
  const raw = words[i];
  if (!raw) return undefined;
  const name = basename(raw.replace(/^["']|["']$/g, "").replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  return /^[a-z0-9][\w.+-]{0,39}$/.test(name) ? name : undefined;
}

/**
 * 명령을 "모양"으로 줄인다: 프로그램 이름과 하위 명령만 남기고 인자는 모두 버린다 (git commit -m "…" → git commit).
 * 기록하지 않을 명령·뜻 없는 명령·무시 목록의 명령은 undefined.
 * 여러 명령을 이은 줄(&&, ;, |)은 앞 명령만 본다.
 */
export function commandShape(line: string, ignore: readonly string[] = []): string | undefined {
  const first = line.split(/&&|\|\||;|\|/)[0] ?? "";
  if (isSensitiveCommand(line) || isSensitiveCommand(first)) return undefined;
  const program = programName(first);
  if (!program || TRIVIAL.has(program) || ignore.includes(program)) return undefined;
  const words = first.trim().split(/\s+/).filter((w) => !["sudo", "doas", "time", "nohup"].includes(w));
  const word = (w: string | undefined) => (w && /^[a-z][a-z0-9:_-]{0,24}$/i.test(w) && !w.startsWith("-") ? w.toLowerCase() : undefined);
  if (!WITH_SUBCOMMAND.has(program)) return program;
  const sub = word(words[1]);
  if (!sub) return program;
  const two = `${program} ${sub}`;
  if (WITH_SCRIPT.has(two)) {
    const third = word(words[2]);
    return third ? `${two} ${third}` : two;
  }
  return two;
}

/** Pi 요청을 견줄 수 있게 줄인다 (숫자·주소·경로를 빼고 앞부분만) */
export function promptShape(prompt: string): string | undefined {
  const text = prompt
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.-]*[\\/][\w.\\/-]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 6) return undefined;
  return text.slice(0, 40);
}
