#!/bin/bash
# Build, code-sign (Developer ID + hardened runtime), notarize, and staple
# MacRockPod.app so other people can download and open it without Gatekeeper
# warnings.
#
# Prerequisites (one-time, on YOUR machine):
#   1. An Apple Developer account (membership active).
#   2. A "Developer ID Application" certificate installed in your login keychain.
#      Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application.
#   3. An app-specific password for notarization:
#      https://account.apple.com > Sign-In and Security > App-Specific Passwords.
#
# Then set these environment variables and run `npm run dist`:
#   SIGNING_IDENTITY  e.g. "Developer ID Application: Jane Doe (AB12CD34EF)"
#   APPLE_ID          your Apple ID email
#   APPLE_TEAM_ID     your 10-char team id, e.g. AB12CD34EF
#   APPLE_APP_PASSWORD the app-specific password (xxxx-xxxx-xxxx-xxxx)
#
# Example:
#   SIGNING_IDENTITY="Developer ID Application: Jane Doe (AB12CD34EF)" \
#   APPLE_ID="jane@example.com" APPLE_TEAM_ID="AB12CD34EF" \
#   APPLE_APP_PASSWORD="abcd-efgh-ijkl-mnop" npm run dist

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$DIR/dist/MacRockPod-darwin-arm64/MacRockPod.app"
ENT="$DIR/build/entitlements.mac.plist"
ZIP="$DIR/dist/MacRockPod.zip"

req() { [ -n "${!1:-}" ] || { echo "ERROR: \$$1 is not set. See the header of build/notarize.sh."; exit 1; }; }
req SIGNING_IDENTITY
req APPLE_ID
req APPLE_TEAM_ID
req APPLE_APP_PASSWORD

echo "==> Packaging (unsigned)…"
npm run package

echo "==> Code-signing nested binaries and the app (hardened runtime)…"
# Sign the bundled CLI tools first, then frameworks, then the app (inside-out).
for bin in "$APP/Contents/Resources/app/bin/"*; do
  codesign --force --options runtime --timestamp \
    --entitlements "$ENT" --sign "$SIGNING_IDENTITY" "$bin"
done
# Sign everything else inside-out, then the bundle as a whole.
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -perm -111 \) -print0 2>/dev/null \
  | while IFS= read -r -d '' f; do
      codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$f" || true
    done
codesign --force --deep --options runtime --timestamp \
  --entitlements "$ENT" --sign "$SIGNING_IDENTITY" "$APP"

echo "==> Verifying signature…"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Zipping for notarization…"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "==> Submitting to Apple notary service (this can take a few minutes)…"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "==> Stapling the notarization ticket…"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "==> Rebuilding distributable zip with the stapled app…"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo ""
echo "✅ Done. Share this file: $ZIP"
echo "   Recipients just unzip it and double-click MacRockPod.app."
