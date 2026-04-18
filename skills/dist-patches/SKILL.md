---
title: Dist Patches
description: Re-apply custom patches to pi dist files after npm update
---

# Dist Patches

Custom patches to pi's installed dist files (`/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/`). These are **not extensions** — they modify upstream pi source directly.

After every `npm update @mariozechner/pi-coding-agent`, re-apply them.

## Apply All Patches

For each patch below:
1. Read the current upstream file at `dist/<path>`
2. Apply the diff shown in the `## Patch` section
3. Verify the feature works by restarting pi

---

## Patch: user-message-borders

**Target:** `dist/modes/interactive/components/user-message.js`

**What it does:**
- Yellow horizontal borders around each user prompt
- `OSC 133;A` iTerm2 shell integration mark (Cmd+Shift+Up/Down navigation)
- Centered `● PROMPT` text in top border

### Upstream file (reference)

```js
import { Box, Container, Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
    contentBox;
    constructor(text, markdownTheme = getMarkdownTheme()) {
        super();
        this.contentBox = new Box(1, 1, (content) => theme.bg("userMessageBg", content));
        this.contentBox.addChild(new Markdown(text, 0, 0, markdownTheme, {
            color: (content) => theme.fg("userMessageText", content),
        }));
        this.addChild(this.contentBox);
    }
    render(width) {
        return super.render(width);
    }
}
//# sourceMappingURL=user-message.js.map
```

### Patch (unified diff)

```diff
 import { Box, Container, Markdown } from "@mariozechner/pi-tui";
 import { getMarkdownTheme, theme } from "../theme/theme.js";
-const OSC133_ZONE_START = "\x1b]133;A\x07";
-const OSC133_ZONE_END = "\x1b]133;B\x07";
-const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
+/**
+ * iTerm2 prompt mark — Cmd+Shift+Up/Down navigates between prompts.
+ * Zero-width OSC 133;A sequence.
+ */
+const OSC133_A = "\x1b]133;A\x07";
 /**
  * Component that renders a user message
  */
@@ -17,7 +19,21 @@ export class UserMessageComponent extends Container {
         this.addChild(this.contentBox);
     }
     render(width) {
-        return super.render(width);
+        const lines = super.render(width);
+        if (lines.length === 0) {
+            return lines;
+        }
+        const border = theme.fg("warning", "─".repeat(Math.max(1, width)));
+        lines.unshift(border);
+        // iTerm2 mark on top border
+        lines[0] = OSC133_A + lines[0];
+        // Centered ● PROMPT marker in top border
+        const marker = " ● PROMPT ";
+        if (width > marker.length) {
+            const markerStart = Math.floor((width - marker.length) / 2);
+            lines[0] = lines[0].slice(0, markerStart) + theme.fg("warning", marker) + lines[0].slice(markerStart + marker.length);
+        }
+        lines.push(border);
+        return lines;
     }
 }
 //# sourceMappingURL=user-message.js.map
```

### If patch doesn't apply cleanly

Upstream `UserMessageComponent` changed. Re-implement the three features in the new structure:
1. Read the new upstream file
2. Replace the dead `OSC133_ZONE_*` constants with `OSC133_A`
3. Override `render()` to add: yellow borders, `OSC133_A` on first line, `● PROMPT` centered in top border
4. Update the diff in this SKILL.md to match the new upstream

---

## Patch: clipboard-image-rendering

**Target:** `dist/modes/interactive/interactive-mode.js`

**What it does:**
When a user pastes an image, pi saves it to a temp file path (e.g. `/var/folders/.../pi-clipboard-xxx.png`) and inserts that path into the editor text. This patch scans user message text for these paths, strips them from the displayed text, and renders them inline as images using pi's `Image` component.

### Changes

**1. Add `Image` to pi-tui import** (line ~9):

```diff
-import { CombinedAutocompleteProvider, Container, fuzzyFilter, Loader, Markdown, matchesKey, ProcessTerminal, Spacer, setKeybindings, Text, TruncatedText, TUI, visibleWidth, } from "@mariozechner/pi-tui";
+import { CombinedAutocompleteProvider, Container, fuzzyFilter, Image, Loader, Markdown, matchesKey, ProcessTerminal, Spacer, setKeybindings, Text, TruncatedText, TUI, visibleWidth, } from "@mariozechner/pi-tui";
```

**2. Add `extractClipboardImages` method** after `getUserMessageText()`:

```js
    /**
     * Extract clipboard image paths from user message text.
     * Returns { text: cleanedText, images: Image[] }
     */
    extractClipboardImages(text) {
        const clipboardImageRegex = /(\/(?:var\/folders|tmp)[^\s]*\/pi-clipboard-[^\s]+\.(png|jpg|jpeg|gif|webp))/g;
        const imagePaths = [];
        let match;
        while ((match = clipboardImageRegex.exec(text)) !== null) {
            imagePaths.push({ full: match[1], ext: match[2] });
        }
        if (imagePaths.length === 0) {
            return { text, images: [] };
        }
        const cleanedText = text.replace(clipboardImageRegex, "").trim();
        const images = [];
        for (const { full, ext } of imagePaths) {
            try {
                if (fs.existsSync(full)) {
                    const base64 = fs.readFileSync(full, "base64");
                    const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
                    images.push(new Image(base64, mimeType, this.getMarkdownThemeWithSettings()));
                }
            }
            catch { /* skip unreadable images */ }
        }
        return { text: cleanedText, images };
    }
```

**3. Modify the `"user"` case in `addMessageToChat`** to extract and render images:

```diff
             case "user": {
                 const textContent = this.getUserMessageText(message);
                 if (textContent) {
-                    const skillBlock = parseSkillBlock(textContent);
+                    const { text: cleanText, images } = this.extractClipboardImages(textContent);
+                    const skillBlock = parseSkillBlock(cleanText);
                     if (skillBlock) {
                         ...
                     }
                     else {
-                        const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
+                        const userComponent = new UserMessageComponent(cleanText, this.getMarkdownThemeWithSettings());
                         this.chatContainer.addChild(userComponent);
                     }
+                    // Render clipboard images after the user message
+                    for (const img of images) {
+                        this.chatContainer.addChild(new Spacer(1));
+                        this.chatContainer.addChild(img);
+                    }
                     if (options?.populateHistory) {
                         this.editor.addToHistory?.(textContent);
                     }
```

### If patch doesn't apply cleanly

Upstream `interactive-mode.js` changed. Re-implement:
1. Add `Image` to the `@mariozechner/pi-tui` import
2. Add `extractClipboardImages` method (same logic, adjust method names if needed)
3. Wire it into the `"user"` case of `addMessageToChat`
4. Update the code blocks in this SKILL.md
