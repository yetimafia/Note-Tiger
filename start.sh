#!/usr/bin/env bash
# Mac/Linux: start the bot (restarts automatically when you save settings in the panel).
cd "$(dirname "$0")"
while true; do
  node index.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  export NT_RESTARTED=1
  echo "Restarting with new settings..."
done
