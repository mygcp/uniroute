#!/usr/bin/env sh
# UniRoute installer — downloads uni binary from GitHub Releases
# Usage: curl -fsSL https://raw.githubusercontent.com/<org>/uniroute/main/install.sh | sh
#        curl -fsSL .../install.sh | sh -s -- --version v1.1.0
set -eu

REPO="${REPO:-mygcp/uniroute}"
VERSION="${1:-latest}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
NAME="uni"

detect_platform() {
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

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/uni-$TARGET"
else
  # allow v1.1.0 or 1.1.0
  case "$VERSION" in v*) TAG="$VERSION";; *) TAG="v$VERSION";; esac
  URL="https://github.com/$REPO/releases/download/$TAG/uni-$TARGET"
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
echo "✓ Installed $BIN_DIR/$NAME (alias $BIN_DIR/uniroute)"
echo "  Run: $NAME doctor && $NAME start --daemon"
echo "  Self-update: $NAME update --check && $NAME update"
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo "  Add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
