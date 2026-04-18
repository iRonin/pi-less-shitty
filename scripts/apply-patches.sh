#!/usr/bin/env bash
# Re-apply autocompleteBasePaths patches after `npm update @mariozechner/pi-coding-agent`
# Usage: bash scripts/apply-patches.sh
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../patches/autocomplete-base-paths" && pwd)"
BACKUP_DIR="$PATCH_DIR/dist-backup"
PI_DIR="/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent"

echo "=== Applying autocompleteBasePaths patches ==="

# Copy patched files over the npm originals
cp -f "$BACKUP_DIR/settings-manager.js" \
  "$PI_DIR/dist/core/settings-manager.js"
echo "✓ settings-manager.js"

cp -f "$BACKUP_DIR/autocomplete.js" \
  "$PI_DIR/node_modules/@mariozechner/pi-tui/dist/autocomplete.js"
echo "✓ autocomplete.js"

cp -f "$BACKUP_DIR/interactive-mode.js" \
  "$PI_DIR/dist/modes/interactive/interactive-mode.js"
echo "✓ interactive-mode.js"

echo "=== Applying user-message-borders patch (yellow borders + fix iTerm2 OSC133 corruption) ==="

BORDER_PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../patches/user-message-borders" && pwd)"
BORDER_BACKUP_DIR="$BORDER_PATCH_DIR/dist-backup"

cp -f "$BORDER_BACKUP_DIR/user-message.js" \
  "$PI_DIR/dist/modes/interactive/components/user-message.js"
echo "✓ user-message.js"

cp -f "$BORDER_BACKUP_DIR/assistant-message.js" \
  "$PI_DIR/dist/modes/interactive/components/assistant-message.js"
echo "✓ assistant-message.js"

echo "=== All patches applied. Restart pi. ==="
