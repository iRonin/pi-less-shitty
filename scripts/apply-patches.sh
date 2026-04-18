#!/usr/bin/env bash
# Apply dist patches after `npm update @mariozechner/pi-coding-agent`
# Usage: bash scripts/apply-patches.sh
set -euo pipefail

PI_DIR="/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent"

echo "=== Applying dist patches ==="

# autocomplete-base-paths
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../patches/autocomplete-base-paths" 2>/dev/null && pwd)" || true
BACKUP_DIR="$PATCH_DIR/dist-backup"
if [ -d "$BACKUP_DIR" ]; then
    cp -f "$BACKUP_DIR/settings-manager.js" \
      "$PI_DIR/dist/core/settings-manager.js"
    echo "✓ settings-manager.js"

    cp -f "$BACKUP_DIR/autocomplete.js" \
      "$PI_DIR/node_modules/@mariozechner/pi-tui/dist/autocomplete.js"
    echo "✓ autocomplete.js"

    cp -f "$BACKUP_DIR/interactive-mode.js" \
      "$PI_DIR/dist/modes/interactive/interactive-mode.js"
    echo "✓ interactive-mode.js"
fi

# user-message-borders
BORDER_PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../patches/user-message-borders" 2>/dev/null && pwd)" || true
BORDER_BACKUP_DIR="$BORDER_PATCH_DIR/dist-backup"
if [ -d "$BORDER_BACKUP_DIR" ]; then
    cp -f "$BORDER_BACKUP_DIR/user-message.js" \
      "$PI_DIR/dist/modes/interactive/components/user-message.js"
    echo "✓ user-message.js"

    cp -f "$BORDER_BACKUP_DIR/assistant-message.js" \
      "$PI_DIR/dist/modes/interactive/components/assistant-message.js"
    echo "✓ assistant-message.js"
fi

echo "=== All patches applied. Restart pi. ==="
