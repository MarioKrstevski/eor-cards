#!/bin/bash
# Bump the APP_VERSION in frontend/src/version.ts and commit
VERSION_FILE="frontend/src/version.ts"
CURRENT=$(grep -o 'APP_VERSION = [0-9]*' "$VERSION_FILE" | grep -o '[0-9]*')
NEXT=$((CURRENT + 1))
sed -i '' "s/APP_VERSION = $CURRENT/APP_VERSION = $NEXT/" "$VERSION_FILE"
echo "Version bumped: $CURRENT → $NEXT"
