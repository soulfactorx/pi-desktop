#!/bin/sh
# Pi Web 설치 스크립트 — Android Termux·리눅스 서버(클라우드 VM)에 Pi와 웹 서버를 한 번에 설치하고 켠다 (설계 §5.10, §5.11).
# 묶음에는 Pi Desktop(pi-web)과 Agent(pi-web agent)·Mate(pi-web mate) 웹 버전이 함께 들어 있다.
#
#   curl -fsSL https://github.com/__PI_WEB_REPO__/releases/latest/download/install-termux.sh | sh
#   wget -qO- https://github.com/__PI_WEB_REPO__/releases/latest/download/install-termux.sh | sh   (curl이 없을 때)
#
# 옵션 (sh -s -- <옵션>):
#   --terminal        내장 터미널(Pi /login, 셸)을 쓰도록 node-pty를 빌드한다 (빌드 도구 수백 MB를 받는다)
#   --version vX.Y.Z  그 릴리스를 설치한다 (기본: 최신)
#   --file <경로>     내려받지 않고 가지고 있는 pi-web.tar.gz로 설치한다
#   --no-pi           Pi(@earendil-works/pi-coding-agent)를 설치하지 않는다
#   --no-start        설치만 하고 켜지 않는다
#
# 다시 실행하면 업데이트한다 (데이터·토큰·내장 터미널은 그대로 둔다).
# 리눅스에서 Node.js 22.19 이상이 없으면 깐다: 패키지 관리자(apk·apt·dnf·pacman·zypper, root 또는 sudo·doas)로,
# 그래도 맞는 버전이 없으면 nodejs.org의 공식 바이너리를 $PI_WEB_HOME/node에 받는다 (glibc).
# POSIX sh로 쓴다 (bash가 없는 Alpine 등에서도 돈다).
set -eu
# shellcheck disable=SC3040
(set -o pipefail) 2>/dev/null && set -o pipefail

REPO="${PI_WEB_REPO:-__PI_WEB_REPO__}"
PI_WEB_HOME="${PI_WEB_HOME:-$HOME/.pi-web}"
PI_PACKAGE="@earendil-works/pi-coding-agent"
VERSION="latest"
FILE=""
TERMINAL=0
INSTALL_PI=1
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --terminal) TERMINAL=1 ;;
    --version) VERSION="$2"; shift ;;
    --file) FILE="$2"; shift ;;
    --no-pi) INSTALL_PI=0 ;;
    --no-start) START=0 ;;
    *) echo "모르는 옵션입니다: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m주의: %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[1;31m실패: %s\033[0m\n' "$*" >&2; exit 1; }

TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then TERMUX=1; fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)'
}

# 내려받기: curl이 없으면 wget (Alpine은 busybox wget이 있다)
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# root가 아니면 sudo나 doas로 패키지를 깐다
SUDO=""
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  elif command -v doas >/dev/null 2>&1; then
    SUDO=doas
  fi
fi
can_install() { [ "$(id -u)" = 0 ] || [ -n "$SUDO" ]; }

# 패키지 관리자로 Node.js·npm과 받기 도구를 깐다. 저장소의 Node가 오래되었으면 아래 공식 바이너리로 넘어간다
install_node_packages() {
  if command -v apk >/dev/null 2>&1; then
    step "Alpine 패키지 설치 (Node.js, npm, curl, tar)"
    $SUDO apk add --no-cache nodejs npm curl tar ca-certificates
    if ! node_ok; then
      # 저장소의 nodejs가 22.19보다 오래되었으면 최신판(nodejs-current)으로 바꾼다 (둘은 함께 설치할 수 없다)
      $SUDO apk del nodejs >/dev/null 2>&1 || true
      $SUDO apk add --no-cache nodejs-current npm
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    step "apt 패키지 설치 (Node.js, npm, curl, tar)"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -q
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl ca-certificates tar xz-utils
    node_ok || $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm || true
  elif command -v dnf >/dev/null 2>&1; then
    step "dnf 패키지 설치 (Node.js, npm, curl, tar)"
    $SUDO dnf install -y curl tar xz
    node_ok || $SUDO dnf install -y nodejs npm || true
  elif command -v pacman >/dev/null 2>&1; then
    step "pacman 패키지 설치 (Node.js, npm, curl, tar)"
    $SUDO pacman -Sy --noconfirm --needed curl tar xz nodejs npm
  elif command -v zypper >/dev/null 2>&1; then
    step "zypper 패키지 설치 (Node.js, npm, curl, tar)"
    $SUDO zypper -n install curl tar xz nodejs npm || true
  else
    warn "알 수 없는 패키지 관리자입니다. Node.js는 공식 바이너리로 받습니다."
  fi
}

# nodejs.org의 공식 바이너리(LTS)를 $PI_WEB_HOME/node에 받는다. root 권한이 필요 없다. glibc 리눅스만
install_node_binary() {
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) fail "이 CPU($(uname -m))용 Node.js 바이너리가 없습니다. Node.js 22.19 이상을 직접 설치하세요." ;;
  esac
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    fail "musl 리눅스에서는 패키지 관리자로 Node.js 22.19 이상을 설치하세요 (Alpine: apk add nodejs-current npm)."
  fi
  base="https://nodejs.org/dist/latest-v24.x"
  step "Node.js 공식 바이너리 받기 ($base, linux-$arch)"
  tmp=$(mktemp -d)
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  file=$(grep " node-v[0-9.]*-linux-$arch.tar.gz\$" "$tmp/SHASUMS256.txt" | awk '{print $2}' | head -n 1)
  [ -n "$file" ] || fail "Node.js 바이너리 목록에서 linux-$arch를 찾지 못했습니다"
  fetch "$base/$file" "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) >/dev/null || fail "Node.js 바이너리의 체크섬이 맞지 않습니다"
  rm -rf "$PI_WEB_HOME/node"
  mkdir -p "$PI_WEB_HOME/node"
  tar -xzf "$tmp/$file" -C "$PI_WEB_HOME/node" --strip-components=1
  rm -rf "$tmp"
  PATH="$PI_WEB_HOME/node/bin:$PATH"
  export PATH
}

# 1. Node.js와 받기 도구
if [ "$TERMUX" = 1 ]; then
  # 먼저 설치된 패키지를 모두 올린다. 일부만 올리면 새 curl이 예전 openssl과 맞지 않아
  # "CANNOT LINK EXECUTABLE curl: cannot locate symbol SSL_…"로 실행되지 않는다 (Termux는 부분 업그레이드를 지원하지 않는다).
  # 설정 파일을 바꿀지 묻는 창이 뜨면 멈추므로, 사용자가 고친 설정은 그대로 둔다(--force-confold).
  step "Termux 패키지 업그레이드 (pkg upgrade)"
  export DEBIAN_FRONTEND=noninteractive
  pkg upgrade -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef
  step "Termux 패키지 설치 (Node.js LTS, curl, tar)"
  packages="curl tar"
  # 이미 맞는 Node가 있으면(nodejs 패키지 등) 그대로 쓴다. nodejs와 nodejs-lts는 함께 설치할 수 없다.
  node_ok || packages="nodejs-lts $packages"
  # shellcheck disable=SC2086
  pkg install -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef $packages
fi
if [ "$TERMUX" = 0 ]; then
  # 전에 받아 둔 공식 바이너리가 있으면 쓴다
  if [ -x "$PI_WEB_HOME/node/bin/node" ]; then PATH="$PI_WEB_HOME/node/bin:$PATH"; export PATH; fi
  if ! node_ok || ! command -v npm >/dev/null 2>&1 || { ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; }; then
    if can_install; then
      install_node_packages
    else
      warn "root가 아니고 sudo·doas도 없어 패키지를 깔 수 없습니다. Node.js는 공식 바이너리로 받습니다."
    fi
  fi
  if ! node_ok || ! command -v npm >/dev/null 2>&1; then install_node_binary; fi
fi
node_ok || fail "Node.js 22.19 이상이 필요합니다. Termux라면: pkg install nodejs-lts"
command -v npm >/dev/null 2>&1 || fail "npm이 없습니다"
echo "Node $(node --version)"

# 실행 환경: 공식 바이너리를 받았거나, npm 전역 위치에 쓸 수 없어 사용자 위치를 쓰면 pi-web이 늘 같은 환경으로 돌게 적어 둔다
mkdir -p "$PI_WEB_HOME"
: >"$PI_WEB_HOME/env.new"
if [ -x "$PI_WEB_HOME/node/bin/node" ] && [ "$(command -v node)" = "$PI_WEB_HOME/node/bin/node" ]; then
  echo "PATH=\"$PI_WEB_HOME/node/bin:\$PATH\"; export PATH" >>"$PI_WEB_HOME/env.new"
fi
if [ "$TERMUX" = 0 ] && [ "$(id -u)" != 0 ]; then
  npm_prefix=$(npm prefix -g 2>/dev/null || echo "")
  if [ -z "$npm_prefix" ] || ! { mkdir -p "$npm_prefix/lib" 2>/dev/null && [ -w "$npm_prefix/lib" ]; }; then
    # 시스템 전역 위치(/usr 등)에 쓸 수 없다: Pi를 ~/.local에 설치한다 (pi-web·Agent가 npm root -g로 찾는다)
    NPM_CONFIG_PREFIX="$HOME/.local"
    export NPM_CONFIG_PREFIX
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    echo "NPM_CONFIG_PREFIX=\"$HOME/.local\"; export NPM_CONFIG_PREFIX; PATH=\"$HOME/.local/bin:\$PATH\"; export PATH" >>"$PI_WEB_HOME/env.new"
  fi
fi
if [ -s "$PI_WEB_HOME/env.new" ]; then mv "$PI_WEB_HOME/env.new" "$PI_WEB_HOME/env"; else rm -f "$PI_WEB_HOME/env.new" "$PI_WEB_HOME/env"; fi

# 2. Pi
if [ "$INSTALL_PI" = 1 ]; then
  if command -v pi >/dev/null 2>&1; then
    echo "Pi가 이미 설치되어 있습니다 ($(command -v pi)). 업데이트는 화면의 Pi 관리 창에서 합니다."
  else
    step "Pi 설치 (npm install -g $PI_PACKAGE)"
    npm install -g "$PI_PACKAGE"
  fi
fi

# 3. 웹 묶음 받기
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || fail "파일이 없습니다: $FILE"
  cp "$FILE" "$work/pi-web.tar.gz"
else
  case "$REPO" in *__PI_WEB_REPO*) fail "릴리스 저장소를 모릅니다. PI_WEB_REPO=owner/repo를 주거나 --file을 쓰세요." ;; esac
  if [ "$VERSION" = latest ]; then
    url="https://github.com/$REPO/releases/latest/download/pi-web.tar.gz"
  else
    url="https://github.com/$REPO/releases/download/$VERSION/pi-web.tar.gz"
  fi
  step "Pi Web 받기 ($url)"
  fetch "$url" "$work/pi-web.tar.gz"
fi
tar -xzf "$work/pi-web.tar.gz" -C "$work"
[ -f "$work/pi-web/server.mjs" ] || fail "묶음 안에 server.mjs가 없습니다"

# 4. 바꿔 넣기: 켜져 있는 서버(Pi Desktop·Agent·Mate)는 끄고 설치 뒤 다시 켠다. 전에 빌드한 node-pty(node_modules)는 옮겨 온다
step "설치 ($PI_WEB_HOME/app)"
mkdir -p "$PI_WEB_HOME"
# systemd 서비스(pi-web service install)로 돌고 있으면 서비스로 멈추고 다시 켠다 (직접 끄면 systemd가 다시 띄운다)
service_on=0
if [ "$TERMUX" = 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet pi-web.service 2>/dev/null; then
  service_on=1
  systemctl --user stop pi-web.service || true
elif [ "$TERMUX" = 0 ] && [ -f /etc/init.d/pi-web ] && command -v rc-service >/dev/null 2>&1 && $SUDO rc-service pi-web status >/dev/null 2>&1; then
  # OpenRC 서비스 (Alpine)
  service_on=2
  $SUDO rc-service pi-web stop || true
fi
was_running=""
for app in desktop agent mate; do
  case "$app" in
    desktop) pid_file="$PI_WEB_HOME/data/server.pid" ;;
    *) pid_file="$PI_WEB_HOME/$app/server.pid" ;;
  esac
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then was_running="$was_running $app"; fi
done
# 먼저 켜져 있던 것을 다 적은 뒤 끈다 (새 실행 명령의 "pi-web stop"은 세 앱을 함께 끈다)
for app in $was_running; do
  case "$app" in
    desktop) pid_file="$PI_WEB_HOME/data/server.pid" ;;
    *) pid_file="$PI_WEB_HOME/$app/server.pid" ;;
  esac
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    if [ "$app" = desktop ]; then
      # 예전 실행 명령(v0.1.12까지)은 앱 이름을 모른다. Pi Desktop은 이름 없이 끈다
      PI_WEB_HOME="$PI_WEB_HOME" sh "$PI_WEB_HOME/app/bin/pi-web" stop || true
    elif [ -f "$PI_WEB_HOME/app/bin/pi-web" ]; then
      PI_WEB_HOME="$PI_WEB_HOME" sh "$PI_WEB_HOME/app/bin/pi-web" "$app" stop || true
    else
      kill "$(cat "$pid_file")" 2>/dev/null || true
    fi
  fi
done
if [ -d "$PI_WEB_HOME/app/node_modules" ]; then mv "$PI_WEB_HOME/app/node_modules" "$work/pi-web/node_modules"; fi
rm -rf "$PI_WEB_HOME/app.old"
if [ -d "$PI_WEB_HOME/app" ]; then mv "$PI_WEB_HOME/app" "$PI_WEB_HOME/app.old"; fi
mv "$work/pi-web" "$PI_WEB_HOME/app"
rm -rf "$PI_WEB_HOME/app.old"
echo "$REPO" >"$PI_WEB_HOME/repo"

# 5. 내장 터미널 (선택): node-pty는 네이티브 모듈이라 Android용 미리 빌드된 파일이 없어 여기서 빌드한다
if [ "$TERMINAL" = 1 ]; then
  step "내장 터미널 준비 (node-pty 빌드)"
  if [ "$TERMUX" = 1 ]; then
    pkg install -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef python make clang binutils
    # Termux의 node-gyp는 android_ndk_path 변수가 없다고 실패한다. 빈 값을 정해 둔다.
    mkdir -p "$HOME/.gyp"
    [ -f "$HOME/.gyp/include.gypi" ] || echo "{'variables':{'android_ndk_path':''}}" >"$HOME/.gyp/include.gypi"
  elif ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    # 리눅스: node-pty는 리눅스용 미리 빌드된 파일이 없어 C++ 컴파일러·make·python3가 필요하다
    if can_install; then
      if command -v apk >/dev/null 2>&1; then
        $SUDO apk add --no-cache python3 make g++ linux-headers
      elif command -v apt-get >/dev/null 2>&1; then
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3 make g++
      elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y python3 make gcc-c++
      elif command -v pacman >/dev/null 2>&1; then
        $SUDO pacman -Sy --noconfirm --needed python make gcc
      elif command -v zypper >/dev/null 2>&1; then
        $SUDO zypper -n install python3 make gcc-c++ || true
      fi
    else
      warn "빌드 도구(python3·make·g++)가 없고 설치할 권한(root·sudo·doas)도 없습니다. 직접 설치한 뒤 다시 실행하세요."
    fi
  fi
  if (cd "$PI_WEB_HOME/app" && npm install --no-save --no-package-lock --no-audit --no-fund node-pty@1.1.0); then
    echo "내장 터미널을 쓸 수 있습니다."
  else
    warn "node-pty를 빌드하지 못했습니다. 터미널 말고 다른 기능은 그대로 쓸 수 있습니다."
  fi
fi

# 6. pi-web 명령
# root면 PATH에 늘 있는 /usr/local/bin에 둔다 (Alpine 등은 ~/.local/bin이 PATH에 없다)
if [ "$TERMUX" = 1 ]; then bin_dir="$PREFIX/bin"; elif [ "$(id -u)" = 0 ]; then bin_dir="/usr/local/bin"; else bin_dir="$HOME/.local/bin"; fi
mkdir -p "$bin_dir"
cat >"$bin_dir/pi-web" <<EOF
#!$(command -v sh)
# Pi Web 실행 명령 (install-termux.sh가 만듦)
PI_WEB_HOME="\${PI_WEB_HOME:-$PI_WEB_HOME}" exec sh "$PI_WEB_HOME/app/bin/pi-web" "\$@"
EOF
chmod 755 "$bin_dir/pi-web"
# PATH에 없으면 셸 설정에 더한다 (로그인 셸의 ~/.profile, 있으면 bash·zsh 설정). 이미 적혀 있으면 다시 쓰지 않는다
path_added=""
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    line="export PATH=\"$bin_dir:\$PATH\"  # pi-web"
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      # ~/.profile은 늘, bash·zsh 설정은 있을 때만
      if [ "$rc" != "$HOME/.profile" ] && [ ! -f "$rc" ]; then continue; fi
      if [ -f "$rc" ] && grep -qF "$bin_dir" "$rc"; then continue; fi
      printf '\n%s\n' "$line" >>"$rc"
      path_added="$path_added $rc"
    done
    ;;
esac

# fish는 ~/.profile을 읽지 않고, 로그인 셸이면 /etc/profile의 PATH(/usr/local/bin 등)도 받지 않는다.
# fish가 있으면 지금 PATH와 상관없이 conf.d에 pi-web·Node·Pi 위치를 더한다 (있으면 덮어쓴다)
if [ "$TERMUX" = 0 ] && { command -v fish >/dev/null 2>&1 || [ -d "$HOME/.config/fish" ]; }; then
  fish_dirs="$bin_dir"
  [ -d "$PI_WEB_HOME/node/bin" ] && fish_dirs="$PI_WEB_HOME/node/bin $fish_dirs"
  if [ -f "$PI_WEB_HOME/env" ] && grep -q NPM_CONFIG_PREFIX "$PI_WEB_HOME/env"; then fish_dirs="$HOME/.local/bin $fish_dirs"; fi
  mkdir -p "$HOME/.config/fish/conf.d"
  {
    echo "# pi-web: install-termux.sh가 만듦 (fish는 ~/.profile을 읽지 않는다)"
    for d in $fish_dirs; do
      echo "test -d '$d'; and not contains -- '$d' \$PATH; and set -gx PATH '$d' \$PATH"
    done
  } >"$HOME/.config/fish/conf.d/pi-web.fish"
  path_added="$path_added $HOME/.config/fish/conf.d/pi-web.fish"
fi

step "완료: Pi Web $(sh "$PI_WEB_HOME/app/bin/pi-web" version)"
if [ -n "$path_added" ]; then
  echo "PATH에 $bin_dir를 더했습니다 (${path_added# }). 새 터미널부터 pi-web을 쓸 수 있고, 지금 터미널에서는: . ~/.profile (fish: source ~/.config/fish/conf.d/pi-web.fish)"
fi
cat <<'EOF'
  pi-web          Pi Desktop을 켜고 브라우저를 엽니다 (주소는 pi-web url)
  pi-web agent    Pi Desktop Agent를 켭니다 (승인·지식베이스·스킬·예약 작업)
  pi-web mate     Pi Desktop Mate를 켭니다 (임무 시간표·인박스·텔레그램)
  pi-web all      세 앱을 모두 켭니다
  pi-web stop     서버를 끕니다 (Pi 세션은 계속 돕니다. agent·mate·all도 같다: pi-web mate stop)
  pi-web update   최신 버전으로 업데이트합니다
  pi-web service install   (리눅스 서버·클라우드 VM) 부팅하면 켜지게 systemd 서비스로 등록합니다

LLM 로그인: 화면의 "프로바이더"에서 API 키를 넣습니다. 내장 터미널(셸, OAuth 로그인 /login)은 pi-web update --terminal로 한 번 준비합니다.
EOF
if [ "$TERMUX" = 1 ]; then
  cat <<'EOF'
휴대폰이 Termux를 멈추지 않게 하려면 (갤럭시 기준):
  - 설정 → 애플리케이션 → Termux → 배터리 → "제한 없음"
  - 개발자 옵션 → "하위 프로세스 제한 사용 중지" 켜기 (Android 14 이상)
  - 알림 창의 Termux 알림에서 "Acquire wakelock" (pi-web이 자동으로 걸어 둡니다)
EOF
else
  cat <<'EOF'
서버(클라우드 VM)에서 다른 기기로 열기: SSH 터널(ssh -L 8787:localhost:8787 …), 또는 PI_WEB_HOST=0.0.0.0과
HTTPS 인증서(PI_WEB_TLS_CERT·PI_WEB_TLS_KEY) — 자세히는 저장소 README의 "리눅스 서버·클라우드 VM에서 쓰기"
EOF
fi

if [ "$service_on" = 1 ]; then
  systemctl --user start pi-web.service && echo "서비스(pi-web.service)로 다시 켰습니다." || warn "서비스를 다시 켜지 못했습니다 (systemctl --user status pi-web.service)"
elif [ "$service_on" = 2 ]; then
  $SUDO rc-service pi-web start && echo "서비스(OpenRC pi-web)로 다시 켰습니다." || warn "서비스를 다시 켜지 못했습니다 (rc-service pi-web status)"
elif [ -n "$was_running" ]; then
  # 업데이트: 켜져 있던 것만 다시 켠다. Pi Web이 켜져 있었으면 Agent·Mate 작업 공간과 한 프로세스로 켠다 (브라우저도 그것만 연다)
  case " $was_running " in
    *" desktop "*)
      sh "$PI_WEB_HOME/app/bin/pi-web" start || warn "Pi Web을 다시 켜지 못했습니다 (pi-web log)"
      ;;
    *)
      for app in $was_running; do
        # 하나를 켜지 못해도 나머지는 켠다
        PI_WEB_NO_OPEN=1 sh "$PI_WEB_HOME/app/bin/pi-web" "$app" start || warn "pi-web $app을 다시 켜지 못했습니다 (pi-web $app log)"
      done
      ;;
  esac
elif [ "$START" = 1 ]; then
  sh "$PI_WEB_HOME/app/bin/pi-web" start
fi
