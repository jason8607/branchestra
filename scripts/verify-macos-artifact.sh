#!/usr/bin/env bash
set -euo pipefail
app_path="$1"
expected_arch="$2"
test -d "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --verbose --type exec "$app_path"
actual_archs="$(lipo -archs "$app_path/Contents/MacOS/Branchestra")"
test "$actual_archs" = "$expected_arch"
node scripts/verify-package-contents.mjs "$app_path"
