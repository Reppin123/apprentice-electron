#!/bin/bash
# Dev-only: the stock Electron.app in node_modules has no
# NSSpeechRecognitionUsageDescription, and macOS TCC checks the RESPONSIBLE
# process (Electron), not the spawned helper — so native STT would abort in
# dev. Packaged builds are covered by electron-builder extendInfo; this
# patches the dev binary the same way. Idempotent; runs from postinstall.
set -euo pipefail
[ "$(uname)" = "Darwin" ] || exit 0
APP="$(dirname "$0")/../node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0

add() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" > /dev/null 2>&1 && return 0
  /usr/libexec/PlistBuddy -c "Add :$1 string '$2'" "$PLIST"
  echo "patched dev Electron Info.plist: $1"
  PATCHED=1
}

PATCHED=0
add NSSpeechRecognitionUsageDescription "Apprentice transcribes your push-to-talk speech on this Mac."
add NSMicrophoneUsageDescription "Apprentice listens only while you hold the push-to-talk keys."

if [ "$PATCHED" = "1" ]; then
  # plist changed → re-seal the ad-hoc signature or macOS kills the app
  codesign -f -s - --deep "$APP" 2> /dev/null
  echo "re-signed dev Electron (ad-hoc)"
fi
