#!/usr/bin/env bash
# Builds dist/NoteTiger-Setup-<version>.exe from Linux.
# Needs: node/npm, mingw-w64 (x86_64-w64-mingw32-gcc), nsis (makensis).
#   sudo apt install gcc-mingw-w64-x86-64 nsis
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=$(node -p "require('./package.json').version")
NODE_VERSION=${NODE_VERSION:-26.13.0}
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
cp server.js index.js config.js store.js ai.js site.js library.js campaign.js spelling.js backup.js updater.js squirrel.js voices.js alerts.js book.js council.js sheets.js builder.js rules5e.js compare-council.mjs compare-council.bat web.js ui.html tiger.png package.json package-lock.json test-speech.js setup-local-ai.bat .env.example "$STAGE/app/"
cp -r site "$STAGE/app/site"
cp -r fonts "$STAGE/app/fonts"

echo "==> Windows packages"
(cd "$STAGE/app" && npm ci --os=win32 --cpu=x64 --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
# Drop native binaries for other platforms.
for d in "$STAGE"/app/node_modules/onnxruntime-node/bin/napi-v*/; do
  rm -rf "$d/darwin" "$d/linux" "$d/win32/arm64"
done
rm -rf "$STAGE"/app/node_modules/@types
# Text recognition uses only the small "best_int" English data.
rm -rf "$STAGE"/app/node_modules/@tesseract.js-data/eng/4.0.0
# PDF reader: only the Node build, fonts, character maps and wasm are needed (no browser viewer).
rm -rf "$STAGE"/app/node_modules/pdfjs-dist/{web,types,build,image_decoders,webpack.mjs}
# Windows ships an older onnxruntime.dll in System32. Put the speech engine's own DLLs next to node.exe,
# which Windows searches first, so the right version is always loaded.
cp "$STAGE"/app/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/*.dll "$STAGE/runtime/"
# Some Windows updates make Windows hand out its own built-in (older) onnxruntime.dll no matter which folder asks.
# So Note Tiger's copy gets a name of its own, and the speech engine is pointed at that name (same length, so the
# file layout doesn't change).
ORTDIR="$STAGE/app/node_modules/onnxruntime-node/bin/napi-v6/win32/x64"
node -e '
  const fs = require("fs"), f = process.argv[1];
  const b = fs.readFileSync(f), from = Buffer.from("onnxruntime.dll"), to = Buffer.from("nt-onnxrt30.dll");
  const at = b.indexOf(from);
  if (at < 0 || b.indexOf(from, at + 1) >= 0) { console.error("onnxruntime.dll import not found exactly once"); process.exit(1); }
  to.copy(b, at); fs.writeFileSync(f, b);
' "$ORTDIR/onnxruntime_binding.node"
cp "$ORTDIR/onnxruntime.dll" "$ORTDIR/nt-onnxrt30.dll"
cp "$ORTDIR/onnxruntime.dll" "$STAGE/runtime/nt-onnxrt30.dll"

echo "==> Launcher"
(cd launcher \
  && x86_64-w64-mingw32-windres launcher.rc -O coff -o "$BUILD/launcher.res" \
  && x86_64-w64-mingw32-gcc -O2 -s -municode -mwindows -DUNICODE -D_UNICODE launcher.c "$BUILD/launcher.res" \
       -o "$STAGE/Note Tiger.exe" -lshell32 -lwinhttp -luser32 -static-libgcc)

echo "==> Window"
(cd window \
  && x86_64-w64-mingw32-windres window.rc -O coff -o rsrc_windows_amd64.syso \
  && GOOS=windows GOARCH=amd64 GOFLAGS=-mod=mod GOPROXY=${GOPROXY:-direct} GOSUMDB=off \
     go build -trimpath -ldflags "-H windowsgui -s -w" -o "$STAGE/Note Tiger Window.exe" .)

echo "==> Installer"
(cd installer && makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT" installer.nsi)
ls -lh "$OUT"
sha256sum "$OUT"
