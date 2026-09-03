#!/usr/bin/env sh
# UniRoute installer — downloads uni binary from GitHub Releases
# Usage: curl -fsSL https://raw.githubusercontent.com/<org>/uniroute/main/install.sh | sh
#        curl -fsSL .../install.sh | sh -s -- --version v1.0.0
set -eu

REPO="${REPO:-mygcp/uniroute}"
VERSION="${1:-latest}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
NAME="uni"
LIGHT="0"
for arg in "$@"; do case "$arg" in --light) LIGHT="1";; --version) shift;; esac; done
# handle --light before version parsing
if [ "$LIGHT" = "1" ]; then
  # version may be $2 when --light is $1
  for arg in "$@"; do case "$arg" in v*|latest) VERSION="$arg";; esac; done
fi

detect_platform() {
  # Termux/Android pakai Bionic libc, bukan glibc — binary standalone
  # (bun --compile) tidak bisa jalan langsung ("cannot execute:
  # required file not found" = ELF interpreter hilang).
  OS_KERNEL=$(uname -s | tr '[:upper:]' '[:lower:]')
  OS_RELEASE=$(uname -o 2>/dev/null || echo "")
  if [ -n "${TERMUX_VERSION:-}" ] || [ "$OS_RELEASE" = "Android" ]; then
    echo "Termux/Android detected: the standalone binary needs glibc and won't run here." >&2
    echo "" >&2
    echo "Pick one:" >&2
    echo "  1) proot Ubuntu (recommended):" >&2
    echo "       pkg install proot-distro && proot-distro install ubuntu" >&2
    echo "       proot-distro login ubuntu  # then re-run this installer inside" >&2
    echo "  2) light mode with node (no binary):" >&2
    echo "       pkg install nodejs git && git clone https://github.com/${REPO} uniroute" >&2
    echo "       cd uniroute && npm ci && npm run build" >&2
    echo "       curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh -s -- --light" >&2
    exit 1
  fi
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$OS" in
    linux) OS="linux" ;;
    darwin) OS="darwin" ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
  esac
  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  echo "bun-$OS-$ARCH"
}

TARGET=$(detect_platform)
echo "→ Detected $TARGET"

if [ "$LIGHT" = "1" ]; then
  echo "→ Light mode: checking for bun or node..."
  if command -v bun >/dev/null 2>&1; then
    echo "✓ bun $(bun --version) found — installing light wrapper"
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/$NAME" <<'WRAP'
#!/bin/sh
# uni light wrapper — detects bun/node at runtime
if command -v bun >/dev/null 2>&1; then
  # try to find server.ts: cwd, or ~/.local/share/uniroute, or next to wrapper
  for d in "$PWD" "$HOME/.local/share/uniroute" "$(dirname "$0")/.."; do
    if [ -f "$d/server.ts" ] && [ -f "$d/build/server/index.js" ]; then exec bun "$d/server.ts" "$@"; fi
    if [ -f "$d/cli/uni-light.ts" ]; then exec bun "$d/cli/uni-light.ts" "$@"; fi
  done
  # fallback: try bunx via git clone
  echo "light wrapper: bun found but no server.ts/build found — clone repo: git clone https://github.com/REPO && cd uniroute && bun install && bun run build && bun cli/uni-light.ts start" >&2
  exit 1
elif command -v node >/dev/null 2>&1; then
  echo "bun not found, trying node $(node --version) — node:sqlite fallback"
  for d in "$PWD" "$HOME/.local/share/uniroute" "$(dirname "$0")/.."; do
    if [ -f "$d/server.ts" ]; then exec node --loader ts-node/esm "$d/server.ts" "$@" 2>/dev/null || exec node "$d/server.ts" "$@"; fi
  done
  echo "node found but no server.ts — git clone https://github.com/REPO && cd uniroute && npm ci && npm run build && node server.ts" >&2
  exit 1
else
  echo "Need bun or node for light mode: pkg install nodejs / curl -fsSL https://bun.sh/install | bash" >&2
  echo "Or use standalone: curl -fsSL https://raw.githubusercontent.com/REPO/main/install.sh | sh" >&2
  exit 1
fi
WRAP
    sed -i "s|REPO|${REPO}|g" "$BIN_DIR/$NAME"
    chmod +x "$BIN_DIR/$NAME"
    if [ ! -e "$BIN_DIR/uniroute" ]; then ln -sf "$NAME" "$BIN_DIR/uniroute" 2>/dev/null || true; fi
    echo "✓ Installed light wrapper $BIN_DIR/$NAME (uses bun/node at runtime)"
    echo "  Requires: git clone https://github.com/$REPO && cd uniroute && bun install && bun run build"
    echo "  Then: $NAME start --daemon"
    exit 0
  else
    echo "→ No bun/node found, falling back to standalone binary"
  fi
  ART="uni-light-$TARGET"
else
  ART="uni-$TARGET"
fi
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ART"
else
  case "$VERSION" in v*) TAG="$VERSION";; *) TAG="v$VERSION";; esac
  URL="https://github.com/$REPO/releases/download/$TAG/$ART"
fi

echo "→ Downloading $URL"
mkdir -p "$BIN_DIR"
TMP=$(mktemp)
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL"
else
  echo "Need curl or wget" >&2; exit 1
fi
chmod +x "$TMP"
mv "$TMP" "$BIN_DIR/$NAME"
# alias uniroute -> uni
if [ ! -e "$BIN_DIR/uniroute" ]; then ln -sf "$NAME" "$BIN_DIR/uniroute" 2>/dev/null || true; fi
echo "✓ Installed $BIN_DIR/$NAME (alias $BIN_DIR/uniroute) [$ART]"
if [ "$LIGHT" = "1" ]; then
  echo "  Light mode: needs bun or node + build/ (git clone && bun install && bun run build)"
  echo "  Run: $NAME doctor && $NAME start --daemon"
else
  echo "  Run: $NAME doctor && $NAME start --daemon"
  echo "  Self-update: $NAME update --check && $NAME update"
fi
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo "  Add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
