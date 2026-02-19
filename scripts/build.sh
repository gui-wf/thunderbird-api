#!/bin/bash
# Build the Thunderbird API extension

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXTENSION_DIR="$PROJECT_DIR/extension"
DIST_DIR="$PROJECT_DIR/dist"

echo "Building Thunderbird API extension..."

# Create dist directory
mkdir -p "$DIST_DIR"

# Package extension
cd "$EXTENSION_DIR"
zip -r "$DIST_DIR/thunderbird-api.xpi" . -x "*.DS_Store" -x "*.git*"

echo "Built: $DIST_DIR/thunderbird-api.xpi"
