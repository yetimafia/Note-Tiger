#!/usr/bin/env bash
# Builds dist/NoteTiger-Setup-<version>.exe from Linux.
# Needs: node/npm, mingw-w64 (x86_64-w64-mingw32-gcc), nsis (makensis).
#   sudo apt install gcc-mingw-w64-x86-64 nsis
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=$(node -p "require('./package.json').version")
NODE_VERSION=${NODE_VERSION:-24.22.2}
BUILD=$ROOT/build
STAGE=$BUILD/stage
OUT=$ROOT/dist/NoteTiger-Setup-$VERSION.exe

echo "==> Note Tiger $VERSION (Node $NODE_VERSION)"
rm -rf "$STAGE" && mkdir -p "$STAGE/runtime" "$STAGE/app" "$ROOT/dist"

echo "==> Windows Node runtime"
if [ ! -f "$BUILD/node-$NODE_VERSION.exe" ]; then
  (cd "$BUILD" && npm pack "node-win-x64@$NODE_VERSION" --silent >/dev/null \
    && tar -xzf "node-win-x64-$NODE_VERSION.tgz" package/bin/node.exe \
    && mv package/bin/node.exe "node-$NODE_VERSION.exe" && rm -rf package "node-win-x64-$NODE_VERSION.tgz")
fi
cp "$BUILD/node-$NODE_VERSION.exe" "$STAGE/runtime/node.exe"

echo "==> App files"
cp index.js web.js ui.html package.json package-lock.json test-speech.js setup-local-ai.bat .env.example "$STAGE/app/"

echo "==> Windows packages"
(cd "$STAGE/app" && npm ci --os=win32 --cpu=x64 --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
# Drop native binaries for other platforms.
for d in "$STAGE"/app/node_modules/onnxruntime-node/bin/napi-v*/; do
  rm -rf "$d/darwin" "$d/linux" "$d/win32/arm64"
done
rm -rf "$STAGE"/app/node_modules/@types

echo "==> Launcher"
(cd launcher \
  && x86_64-w64-mingw32-windres launcher.rc -O coff -o "$BUILD/launcher.res" \
  && x86_64-w64-mingw32-gcc -O2 -s -municode -mwindows -DUNICODE -D_UNICODE launcher.c "$BUILD/launcher.res" \
       -o "$STAGE/Note Tiger.exe" -lshell32 -lwinhttp -luser32 -static-libgcc)

echo "==> Installer"
(cd installer && makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT" installer.nsi)
ls -lh "$OUT"
sha256sum "$OUT"
