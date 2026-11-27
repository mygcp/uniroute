#!/usr/bin/env sh
# UniRoute installer: prefers lightweight gzipped bundle (~1 MB) when Bun or Node.js >= 22.5
# is installed, with an explicit warning before falling back to the ~85 MB standalone binary.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mygcp/uniroute/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/mygcp/uniroute/main/install.sh | sh -s -- --version v1.1.0
#   curl -fsSL https://raw.githubusercontent.com/mygcp/uniroute/main/install.sh | sh -s -- --binary
set -eu

REPO="${REPO:-mygcp/uniroute}"
VERSION="latest"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
UNIROUTE_HOME="${UNIROUTE_HOME:-$HOME/.local/share/uniroute}"
APP_DIR="$UNIROUTE_HOME/app"
NAME="uni"
MODE="auto"
YES="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary|--standalone) MODE="binary"; shift ;;
    --bundle|--light) MODE="bundle"; shift ;;
    --yes|-y) YES="1"; shift ;;
    --version)
      if [ $# -lt 2 ]; then echo "Missing value for --version" >&2; exit 1; fi
      VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    -h|--help)
      cat <<'EOF'
UniRoute installer

Options:
  --version TAG     Install a specific release tag (default: latest)
  --bundle          Force lightweight gzipped bundle (requires Bun or Node >= 22.5)
  --binary          Force standalone compiled binary (~85 MB)
  -y, --yes         Skip interactive confirmation when falling back to binary
  -h, --help        Show this help
EOF
      exit 0 ;;
    v*|latest) VERSION="$1"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

download_file() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -qO "$out" "$url" 2>/dev/null || wget -O "$out" "$url"
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi
}

release_asset_url() {
  asset="$1"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/$REPO/releases/latest/download/$asset"
  else
    case "$VERSION" in v*) TAG="$VERSION" ;; *) TAG="v$VERSION" ;; esac
    echo "https://github.com/$REPO/releases/download/$TAG/$asset"
  fi
}

detect_runtime() {
  if command -v bun >/dev/null 2>&1; then
    echo "bun:$(bun --version 2>/dev/null || echo unknown)"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    nver="$(node -v 2>/dev/null | sed 's/^v//')"
    nmaj="$(echo "$nver" | cut -d. -f1)"
    nmin="$(echo "$nver" | cut -d. -f2)"
    if [ -n "$nmaj" ] && [ -n "$nmin" ] && [ "$nmaj" -gt 22 ] 2>/dev/null; then
      echo "node:$nver"
      return 0
    fi
    if [ "$nmaj" -eq 22 ] 2>/dev/null && [ "$nmin" -ge 5 ] 2>/dev/null; then
      echo "node:$nver"
      return 0
    fi
  fi
  return 1
}

detect_platform() {
  OS_RELEASE="$(uname -o 2>/dev/null || echo "")"
  if [ -n "${TERMUX_VERSION:-}" ] || [ "$OS_RELEASE" = "Android" ]; then
    echo "termux"
    return 0
  fi
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$OS" in
    linux) OS="linux" ;;
    darwin) OS="darwin" ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
  esac
  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  echo "$OS-$ARCH"
}

write_bundle_launcher() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/$NAME" <<EOF
#!/usr/bin/env sh
set -eu
export UNIROUTE_INSTALL_MODE="bundle"
export UNIROUTE_APP_DIR="$APP_DIR"
ENTRY="\$UNIROUTE_APP_DIR/uni.mjs"
if command -v bun >/dev/null 2>&1; then
  exec bun "\$ENTRY" "\$@"
elif command -v node >/dev/null 2>&1; then
  NVER="\$(node -v 2>/dev/null | sed 's/^v//')"
  NMAJ="\$(echo "\$NVER" | cut -d. -f1)"
  NMIN="\$(echo "\$NVER" | cut -d. -f2)"
  if [ "\$NMAJ" = "22" ] && [ "\$NMIN" -lt 13 ] 2>/dev/null; then
    exec node --no-warnings=ExperimentalWarning --experimental-sqlite "\$ENTRY" "\$@"
  fi
  exec node --no-warnings=ExperimentalWarning "\$ENTRY" "\$@"
else
  echo "[uni] Bun or Node.js >= 22.5 is required to run the bundle install." >&2
  echo "  Install Bun (https://bun.sh) or Node.js 22+, or reinstall with --binary." >&2
  exit 1
fi
EOF
  chmod +x "$BIN_DIR/$NAME"
  ln -sf "$NAME" "$BIN_DIR/uniroute" 2>/dev/null || true
}

install_bundle() {
  URL="$(release_asset_url "uni-bundle.tar.gz")"
  echo "-> Downloading lightweight bundle ($URL)"
  TMP_TGZ="$(mktemp)"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_TGZ" "$TMP_DIR"' EXIT
  download_file "$URL" "$TMP_TGZ"
  tar -xzf "$TMP_TGZ" -C "$TMP_DIR"
  mkdir -p "$UNIROUTE_HOME"
  rm -rf "$APP_DIR.bak"
  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$APP_DIR.bak"
  fi
  mv "$TMP_DIR" "$APP_DIR"
  write_bundle_launcher
  echo ""
  echo "Installed UniRoute lightweight bundle to $APP_DIR"
  echo "Launcher: $BIN_DIR/$NAME (alias: $BIN_DIR/uniroute)"
  echo "Next: $NAME doctor && $NAME start --daemon"
  echo "Update or switch versions anytime: $NAME update --list"
}

install_binary() {
  TARGET="$(detect_platform)"
  if [ "$TARGET" = "termux" ]; then
    echo "Termux/Android uses Bionic libc, so the glibc standalone binary cannot run here." >&2
    echo "Install Node.js 22+ instead and re-run for the ~1 MB bundle:" >&2
    echo "  pkg install nodejs && curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh" >&2
    exit 1
  fi
  ART="uni-$TARGET"
  URL="$(release_asset_url "$ART")"
  echo "-> Downloading standalone binary ($URL)"
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  download_file "$URL" "$TMP"
  chmod +x "$TMP"
  mv "$TMP" "$BIN_DIR/$NAME"
  ln -sf "$NAME" "$BIN_DIR/uniroute" 2>/dev/null || true
  echo ""
  echo "Installed UniRoute standalone binary to $BIN_DIR/$NAME (alias: $BIN_DIR/uniroute)"
  echo "Next: $NAME doctor && $NAME start --daemon"
  echo "Update or switch versions anytime: $NAME update --list"
}

RUNTIME=""
if RUNTIME="$(detect_runtime)"; then
  RT_NAME="${RUNTIME%%:*}"
  RT_VER="${RUNTIME#*:}"
  if [ "$MODE" = "binary" ]; then
    echo "-> Detected $RT_NAME $RT_VER, installing standalone binary as requested (--binary)."
    install_binary
  else
    echo "-> Detected $RT_NAME $RT_VER. Installing lightweight gzipped bundle (~1 MB instead of ~85 MB binary)."
    install_bundle
  fi
else
  if [ "$MODE" = "bundle" ]; then
    echo "Error: --bundle was requested, but neither Bun nor Node.js >= 22.5 was found." >&2
    echo "Install Bun:    curl -fsSL https://bun.sh/install | bash" >&2
    echo "Install Node:   https://nodejs.org (v22.5 or newer)" >&2
    exit 1
  fi

  echo ""
  echo "WARNING: Neither Bun nor Node.js (>= 22.5) was found on this system."
  echo "  UniRoute itself is only ~1 MB gzipped, while the standalone binary embeds"
  echo "  the full ~85 MB runtime."
  echo ""
  echo "  Recommended: install Bun or Node.js 22+ first, then re-run this installer"
  echo "  for a ~1 MB install and ~1 MB updates:"
  echo "    Bun:     curl -fsSL https://bun.sh/install | bash"
  echo "    Node.js: https://nodejs.org"
  echo ""

  if [ "$MODE" = "binary" ] || [ "$YES" = "1" ]; then
    install_binary
  elif [ -r /dev/tty ]; then
    printf "Continue installing the ~85 MB standalone binary anyway? [y/N] "
    read -r ANS </dev/tty || ANS=""
    case "$ANS" in
      y|Y|yes|YES) install_binary ;;
      *)
        echo "Aborted. Install Bun or Node.js 22+, then re-run this installer."
        exit 0 ;;
    esac
  else
    echo "Non-interactive shell detected. Install Bun/Node.js 22+ first, or re-run with --binary." >&2
    exit 1
  fi
fi

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
