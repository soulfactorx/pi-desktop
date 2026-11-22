#!/bin/sh
# Pi Web 실행 명령 (설계 §5.10, §5.11). 설치 스크립트(install-termux.sh)가 $PREFIX/bin/pi-web에서 이 파일을 부른다.
#
#   pi-web [앱] [명령]
#
# 앱:   (없음)  Pi Web과 Agent·Mate 작업 공간을 한 프로세스·한 포트로 (8787, Agent는 /agent/, Mate는 /mate/). 화면 아래 작업 공간 막대로 바꾼다
#               log·open·update 등 그 밖의 명령은 Pi Web
#       desktop Pi Web만 — Pi 관리·로그인·채팅 (포트 8787)
#       agent   Agent만 따로 — 승인·지식베이스·스킬·예약 작업 (포트 8788)
#       mate    Mate만 따로 — 임무 시간표·인박스·텔레그램 (포트 8789)
#       all     (없음)과 같다
# 명령: start(기본: 켜고 브라우저를 연다) | run(앞에서 실행) | stop | restart | status | url | open | log
#       service install|uninstall|status (리눅스 서버·클라우드 VM: 부팅하면 systemd가 켠다)
#       update | uninstall | version (앱과 상관없이 묶음 전체)
#
# 환경 변수: PI_WEB_PORT(앱마다 기본값), PI_WEB_HOST(기본 127.0.0.1, 다른 기기에서 열려면 0.0.0.0), PI_WEB_HOME(기본 ~/.pi-web), PI_WEB_NO_OPEN=1
#           PI_WEB_TLS_CERT·PI_WEB_TLS_KEY(HTTPS 인증서·키), PI_WEB_PUBLIC_HOST(접속 주소에 쓸 도메인·공인 IP)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PI_WEB_HOME=${PI_WEB_HOME:-$HOME/.pi-web}
export PI_WEB_HOME
# 설치 스크립트가 받은 Node.js·사용자 npm 위치 (리눅스 서버). systemd 서비스로 떠도 같은 환경이 되게 여기서 읽는다
# shellcheck disable=SC1091
if [ -f "$PI_WEB_HOME/env" ]; then . "$PI_WEB_HOME/env"; fi

# 앱을 고른다: 서버 폴더, 데이터 폴더, 포트, 이름
use_app() {
  case "$1" in
    desktop)
      APP_DIR=$ROOT
      DATA_DIR=$PI_WEB_HOME/data
      DEFAULT_PORT=8787
      NAME="Pi Web"
      ;;
    agent)
      APP_DIR=$ROOT/agent
      DATA_DIR=$PI_WEB_HOME/agent
      DEFAULT_PORT=8788
      NAME="Pi Agent Web"
      ;;
    mate)
      APP_DIR=$ROOT/mate
      DATA_DIR=$PI_WEB_HOME/mate
      DEFAULT_PORT=8789
      NAME="Pi Mate Web"
      ;;
  esac
  APP=$1
  PORT=${PI_WEB_PORT:-$DEFAULT_PORT}
  LOG=$DATA_DIR/server.log
  PID_FILE=$DATA_DIR/server.pid
  URL_FILE=$DATA_DIR/url
}

running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

any_running() {
  for a in desktop agent mate; do
    use_app "$a"
    if running; then return 0; fi
  done
  return 1
}

# Termux가 화면이 꺼진 뒤에도 서버를 멈추지 않게 한다 (Termux:API 앱 없이도 된다)
wake_lock() {
  if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock || true; fi
}

wake_unlock() {
  if command -v termux-wake-unlock >/dev/null 2>&1; then termux-wake-unlock || true; fi
}

open_url() {
  [ -n "${PI_WEB_NO_OPEN:-}" ] && return 0
  [ -f "$URL_FILE" ] || return 0
  url=$(cat "$URL_FILE")
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$url" || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

show_url() {
  if [ -f "$URL_FILE" ]; then
    echo "$NAME 주소: $(cat "$URL_FILE")"
    # 모든 주소(0.0.0.0)에서 들으면 다른 기기에서 열 주소도 보인다
    if [ -s "$DATA_DIR/urls" ]; then
      echo "  다른 기기에서:"
      sed 's/^/    /' "$DATA_DIR/urls"
    fi
  elif [ "$APP" != desktop ] && [ -f "$PI_WEB_HOME/data/url" ]; then
    # 한 프로세스(pi-web start)면 Agent·Mate는 Pi Web 주소의 /agent/·/mate/에 붙어 있다 (토큰도 같다)
    echo "$NAME 주소: $(sed "s|/#|/$APP/#|" "$PI_WEB_HOME/data/url")"
    if [ -s "$PI_WEB_HOME/data/urls" ]; then
      echo "  다른 기기에서:"
      sed "s|/#|/$APP/#|; s/^/    /" "$PI_WEB_HOME/data/urls"
    fi
  else
    if [ "$APP" = desktop ]; then hint="pi-web desktop start"; else hint="pi-web $APP start"; fi
    echo "$NAME: 아직 주소가 없습니다. $hint로 켜세요."
  fi
}

# 리눅스 서버(클라우드 VM)에서 부팅하면 켜지게 systemd 사용자 서비스로 등록한다.
# 지금 셸의 PI_WEB_* 설정(주소·포트·인증서)을 서비스에 적어 둔다. 바꾸려면 설정한 뒤 다시 install한다.
SERVICE=pi-web.service
# 서비스에 적어 둘 PI_WEB_* 설정 (지금 셸의 값)
SERVICE_VARS="PI_WEB_HOST PI_WEB_PORT PI_WEB_TLS_CERT PI_WEB_TLS_KEY PI_WEB_PUBLIC_HOST"

# OpenRC (Alpine 등 systemd가 없는 리눅스): /etc/init.d/pi-web. root(또는 sudo·doas)가 필요하다
openrc_service() {
  sub=$1
  as_root=""
  if [ "$(id -u)" != 0 ]; then
    if command -v sudo >/dev/null 2>&1; then as_root=sudo; elif command -v doas >/dev/null 2>&1; then as_root=doas; else
      echo "OpenRC 서비스는 root 권한이 필요합니다 (sudo·doas도 없습니다)." >&2
      exit 1
    fi
  fi
  init=/etc/init.d/pi-web
  case "$sub" in
    install)
      for a in desktop agent mate; do
        use_app "$a"
        if running; then stop; fi
      done
      rm -f "$PI_WEB_HOME/data/url" "$PI_WEB_HOME/data/urls"
      tmp=$(mktemp)
      {
        echo "#!/sbin/openrc-run"
        echo "# pi-web service install이 만듦 (Pi Desktop·Agent·Mate 웹 서버)"
        echo "description=\"Pi Web\""
        echo "command=$(command -v sh)"
        echo "command_args=\"$ROOT/bin/pi-web run\""
        echo "command_user=\"$(id -un)\""
        echo "command_background=true"
        echo "pidfile=/run/pi-web.pid"
        echo "output_log=\"$PI_WEB_HOME/data/service.log\""
        echo "error_log=\"$PI_WEB_HOME/data/service.log\""
        echo "export HOME=\"$HOME\" PI_WEB_HOME=\"$PI_WEB_HOME\" PATH=\"$PATH\""
        for v in $SERVICE_VARS; do
          eval "val=\${$v:-}"
          if [ -n "$val" ]; then echo "export $v=\"$val\""; fi
        done
        echo "depend() { need net; after firewall; }"
      } >"$tmp"
      mkdir -p "$PI_WEB_HOME/data"
      $as_root install -m 755 "$tmp" "$init"
      rm -f "$tmp"
      $as_root rc-update add pi-web default >/dev/null
      $as_root rc-service pi-web restart
      i=0
      use_app desktop
      while [ ! -f "$URL_FILE" ] && [ "$i" -lt 75 ]; do i=$((i + 1)); sleep 0.2; done
      echo "OpenRC 서비스로 등록했습니다. 부팅하면 켜집니다 (rc-service pi-web status)."
      show_url
      ;;
    uninstall)
      $as_root rc-service pi-web stop 2>/dev/null || true
      $as_root rc-update del pi-web default 2>/dev/null || true
      $as_root rm -f "$init"
      echo "서비스를 지웠습니다. 서버도 껐습니다 (Pi 세션과 Mate 실행기는 계속 돕니다)."
      ;;
    status) $as_root rc-service pi-web status || true ;;
    *)
      echo "pi-web service install|uninstall|status" >&2
      exit 1
      ;;
  esac
}

service_cmd() {
  sub=${1:-status}
  if [ -n "${TERMUX_VERSION:-}" ]; then
    echo "Termux에서는 Termux:Boot 앱의 ~/.termux/boot/ 스크립트에 pi-web start를 넣으세요." >&2
    exit 1
  fi
  # systemd가 PID 1이 아니면(Alpine·컨테이너 등) OpenRC를 쓴다
  if ! { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }; then
    if command -v rc-service >/dev/null 2>&1; then
      openrc_service "$sub"
      return
    fi
    echo "systemd·OpenRC가 없는 환경입니다. 부팅할 때 pi-web start를 실행하게 직접 등록하세요 (예: crontab의 @reboot)." >&2
    exit 1
  fi
  unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  case "$sub" in
    install)
      mkdir -p "$unit_dir"
      # 따로 띄운 서버가 있으면 끄고 서비스로 넘긴다
      for a in desktop agent mate; do
        use_app "$a"
        if running; then stop; fi
      done
      envs=""
      for v in $SERVICE_VARS; do
        eval "val=\${$v:-}"
        [ -n "$val" ] && envs="${envs}Environment=\"$v=$val\"
"
      done
      {
        echo "[Unit]"
        echo "Description=Pi Web (Pi Desktop·Agent·Mate 웹 서버)"
        echo "After=network-online.target"
        echo "Wants=network-online.target"
        echo
        echo "[Service]"
        echo "Type=simple"
        echo "Environment=\"PI_WEB_HOME=$PI_WEB_HOME\""
        echo "Environment=\"PATH=$PATH\""
        printf '%s' "$envs"
        echo "ExecStart=$(command -v sh) $ROOT/bin/pi-web run"
        echo "Restart=on-failure"
        echo "RestartSec=5"
        echo
        echo "[Install]"
        echo "WantedBy=default.target"
      } >"$unit_dir/$SERVICE"
      rm -f "$PI_WEB_HOME/data/url" "$PI_WEB_HOME/data/urls"
      systemctl --user daemon-reload
      systemctl --user enable --now "$SERVICE"
      # 로그인하지 않아도(부팅만 해도) 사용자 서비스가 돌게 한다. 권한이 없으면 안내만 한다
      if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
        loginctl enable-linger "$(id -un)" 2>/dev/null ||
          echo "주의: 부팅만 해도 켜지려면 한 번 실행하세요: sudo loginctl enable-linger $(id -un)" >&2
      fi
      i=0
      use_app desktop
      while [ ! -f "$URL_FILE" ] && [ "$i" -lt 75 ]; do i=$((i + 1)); sleep 0.2; done
      echo "서비스로 등록했습니다. 부팅하면 켜집니다 (systemctl --user status $SERVICE)."
      show_url
      ;;
    uninstall)
      systemctl --user disable --now "$SERVICE" 2>/dev/null || true
      rm -f "$unit_dir/$SERVICE"
      systemctl --user daemon-reload
      echo "서비스를 지웠습니다. 서버도 껐습니다 (Pi 세션과 Mate 실행기는 계속 돕니다)."
      ;;
    status) systemctl --user status "$SERVICE" --no-pager || true ;;
    *)
      echo "pi-web service install|uninstall|status" >&2
      exit 1
      ;;
  esac
}

# 한 프로세스로 띄울 때 Pi Web 서버에 주는 인자 (Agent·Mate 서버를 함께 불러온다)
EXTRA_ARGS=""

start() {
  if [ ! -f "$APP_DIR/server.mjs" ]; then
    echo "$NAME이(가) 이 묶음에 없습니다. pi-web update로 업데이트하세요." >&2
    exit 1
  fi
  if running; then
    echo "$NAME: 이미 실행 중입니다 (pid $(cat "$PID_FILE"))."
    show_url
    open_url
    return 0
  fi
  mkdir -p "$DATA_DIR"
  rm -f "$URL_FILE"
  wake_lock
  PI_WEB_DATA="$DATA_DIR" nohup node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} $EXTRA_ARGS "$@" >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  # 서버가 주소 파일을 쓰면 뜬 것이다
  i=0
  while [ ! -f "$URL_FILE" ]; do
    i=$((i + 1))
    if [ "$i" -gt 150 ] || ! running; then
      echo "$NAME을(를) 켜지 못했습니다. 기록($LOG)의 끝:" >&2
      tail -n 20 "$LOG" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 0.2
  done
  echo "$NAME을(를) 켰습니다 (pid $(cat "$PID_FILE"))."
  show_url
  open_url
}

stop() {
  if running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    case "$APP" in
      mate) echo "$NAME을(를) 껐습니다. Mate 실행기는 계속 돌며 임무 시간표를 지킵니다." ;;
      *) echo "$NAME을(를) 껐습니다. 실행 중이던 Pi 세션은 데몬에서 계속 돕니다." ;;
    esac
  else
    echo "$NAME: 실행 중이 아닙니다."
  fi
  rm -f "$PID_FILE"
  any_running || wake_unlock
}

status() {
  if running; then
    echo "$NAME: 실행 중 (pid $(cat "$PID_FILE"))"
    show_url
  else
    echo "$NAME: 꺼져 있습니다."
  fi
}

# 앱 이름이 먼저 오면 그 앱. 없으면 켜고 끄는 명령은 세 앱 모두(한 화면의 작업 공간이므로), 그 밖은 Pi Desktop
target=
case "${1:-}" in
  agent | mate | all | desktop)
    target=$1
    shift
    ;;
esac
cmd=${1:-start}
[ $# -gt 0 ] && shift
[ "$target" = all ] && target=""
if [ -z "$target" ]; then
  # 한 프로세스: Pi Web 서버가 Agent·Mate 서버를 함께 불러온다 (--workspaces). pid·기록은 Pi Web 것 하나
  target=desktop
  case "$cmd" in
    start | restart | run) EXTRA_ARGS="--workspaces" ;;
    stop)
      # 따로 띄운 Agent·Mate(pi-web agent start 등)도 함께 끈다
      for a in agent mate; do
        use_app "$a"
        if running; then stop; fi
      done
      ;;
  esac
fi

use_app "$target"

case "$cmd" in
  start) start "$@" ;;
  run)
    mkdir -p "$DATA_DIR"
    rm -f "$URL_FILE"
    wake_lock
    # systemd 등 앞에서 띄워도 status·stop이 알아보게 pid를 남긴다 (exec는 같은 pid를 쓴다)
    echo $$ >"$PID_FILE"
    PI_WEB_DATA="$DATA_DIR" exec node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} $EXTRA_ARGS "$@"
    ;;
  stop) stop ;;
  restart)
    stop
    start "$@"
    ;;
  status) status ;;
  service) service_cmd "$@" ;;
  url) show_url ;;
  open) open_url ;;
  log | logs) tail -n 100 -f "$LOG" ;;
  update)
    repo=$(cat "$PI_WEB_HOME/repo" 2>/dev/null || true)
    [ -n "$repo" ] || { echo "설치한 저장소를 모릅니다 ($PI_WEB_HOME/repo). 설치 스크립트를 다시 실행하세요." >&2; exit 1; }
    script_url="https://github.com/$repo/releases/latest/download/install-termux.sh"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$script_url" | sh -s -- "$@"; else wget -qO- "$script_url" | sh -s -- "$@"; fi
    ;;
  uninstall)
    for a in desktop agent mate; do
      use_app "$a"
      if running; then stop; fi
    done
    # Mate 실행기는 서버와 따로 돈다. 지우기 전에 멈춘다
    runner=$ROOT/mate/resources/mate-runner/mate-runner.mjs
    if [ -f "$runner" ]; then node "$runner" stop >/dev/null 2>&1 || true; fi
    rm -rf "$PI_WEB_HOME/app"
    rm -f "${PREFIX:-$HOME/.local}/bin/pi-web"
    echo "지웠습니다. 토큰·SSH 호스트 등 데이터($PI_WEB_HOME/data, agent, mate)는 남겨 두었습니다. 함께 지우려면: rm -rf $PI_WEB_HOME"
    ;;
  version | --version | -v) node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json" ;;
  help | --help | -h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)
    echo "모르는 명령입니다: $cmd (pi-web help)" >&2
    exit 1
    ;;
esac
