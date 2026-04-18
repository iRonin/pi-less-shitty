#!/usr/bin/env bash
# Apply dist patches to the installed pi package.
# Usage: bash scripts/apply-patches.sh
set -euo pipefail

PI_DIR="/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent"
PATCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../patches" && pwd)"

apply_patch() {
    local patch_dir="$1"
    local patch_file="$2"
    local target="$3"

    local abs_target="$PI_DIR/$target"
    if [ ! -f "$abs_target" ]; then
        echo "⚠ SKIP: $(basename "$patch_file") — target not found: $target"
        return
    fi

    if patch --quiet --forward "$abs_target" < "$patch_file" 2>/dev/null; then
        echo "✓ $(basename "$patch_file") → $target"
    else
        echo "✗ $(basename "$patch_file") — patch failed (upstream changed?)"
        return 1
    fi
}

echo "=== Applying dist patches ==="

# user-message-borders: patch user-message.js
apply_patch "user-message-borders" \
    "$PATCH_ROOT/user-message-borders/user-message.patch" \
    "dist/modes/interactive/components/user-message.js"

echo "=== All patches applied. Restart pi. ==="
