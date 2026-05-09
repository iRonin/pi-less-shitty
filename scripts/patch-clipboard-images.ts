import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { findPiCodingAgentDistFromCaller } from '../packages/pi-resolve/src/index.ts';

// Scope-aware: handles @mariozechner ↔ @earendil-works rename.
// Image import line in v0.74.0 still uses @<scope>/pi-tui as the import
// specifier. Match either scope, but always rewrite to introduce `Image` in
// the same scope as the existing import.
export function patchClipboardImages(): void {
  const piDist = findPiCodingAgentDistFromCaller(import.meta.url, {
    probe: 'modes/interactive/interactive-mode.js',
  });
  if (!piDist) return;
  const f = path.join(piDist.distDir, 'modes/interactive/interactive-mode.js');
  if (!fs.existsSync(f)) return;
  let c = fs.readFileSync(f, 'utf8');
  let changed = false;

  // 1. Add Image to import — detect scope from existing line so the
  // rewrite preserves it (whether @earendil-works/pi-tui or @earendil-works/pi-tui)
  if (!c.includes('Image, Loader, Markdown')) {
    const importRe = /import \{ CombinedAutocompleteProvider, Container, fuzzyFilter, Loader, Markdown, matchesKey, ProcessTerminal, Spacer, setKeybindings, Text, TruncatedText, TUI, visibleWidth, \} from "(@[a-z-]+\/pi-tui)";/;
    const m = c.match(importRe);
    if (m) {
      const scope = m[1];
      c = c.replace(
        importRe,
        `import { CombinedAutocompleteProvider, Container, fuzzyFilter, Image, Loader, Markdown, matchesKey, ProcessTerminal, Spacer, setKeybindings, Text, TruncatedText, TUI, visibleWidth, } from "${scope}";`,
      );
      changed = true;
    }
  }

  // 2. Add extractClipboardImages method
  if (!c.includes('extractClipboardImages(text) {')) {
    const insertBefore = [
      '    /**',
      '     * Show a status message in the chat.',
      '     *',
      '     * If multiple status messages are emitted back-to-back (without anything else being added to the chat),',
      '     * we update the previous status line instead of appending new ones to avoid log spam.',
      '     */',
      '    showStatus(message) {'
    ].join('\n');

    const method = [
      '    /**',
      '     * Extract clipboard image paths from text and return cleaned text + image components.',
      '     */',
      '    extractClipboardImages(text) {',
      '        const clipboardImageRegex = /(\\/(?:var\\/folders|tmp)[^\\s]*\\/pi-clipboard-[^\\s]+\\.(png|jpg|jpeg|gif|webp))/g;',
      '        const imagePaths = [];',
      '        let match;',
      '        while ((match = clipboardImageRegex.exec(text)) !== null) {',
      '            imagePaths.push({ full: match[1], ext: match[2] });',
      '        }',
      '        if (imagePaths.length === 0) {',
      '            return { text, images: [] };',
      '        }',
      '        const cleanedText = text.replace(clipboardImageRegex, "").trim();',
      '        const images = [];',
      '        for (const { full, ext } of imagePaths) {',
      '            try {',
      '                if (fs.existsSync(full)) {',
      '                    const base64 = fs.readFileSync(full, "base64");',
      '                    const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;',
      '                    images.push({ img: new Image(base64, mimeType, this.getMarkdownThemeWithSettings(), { maxWidthCells: 30 }), path: full });',
      '                }',
      '            }',
      '            catch { /* skip unreadable images */ }',
      '        }',
      '        return { text: cleanedText, images };',
      '    }',
      '    /**',
      '     * Show a status message in the chat.',
      '     *',
      '     * If multiple status messages are emitted back-to-back (without anything else being added to the chat),',
      '     * we update the previous status line instead of appending new ones to avoid log spam.',
      '     */',
      '    showStatus(message) {'
    ].join('\n');

    c = c.replace(insertBefore, method);
    changed = true;
  }

  // 3. Wire into user case
  if (!c.includes('extractClipboardImages(textContent)')) {
    const oldUser = `const textContent = this.getUserMessageText(message);
                if (textContent) {
                    const skillBlock = parseSkillBlock(textContent);`;
    const newUser = `const textContent = this.getUserMessageText(message);
                if (textContent) {
                    const { text: cleanText, images } = this.extractClipboardImages(textContent);
                    const displayText = cleanText || textContent;
                    const skillBlock = parseSkillBlock(displayText);`;
    c = c.replace(oldUser, newUser);
    changed = true;
  }

  // 4. Replace textContent with displayText in UserMessageComponent
  if (c.includes('new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings())') && !c.includes('new UserMessageComponent(displayText,')) {
    c = c.replace(
      'new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings())',
      'new UserMessageComponent(displayText, this.getMarkdownThemeWithSettings())'
    );
    changed = true;
  }

  // 5. Add image rendering after user case
  if (!c.includes('for (const { img, path } of images)')) {
    const insertMarker = `if (options?.populateHistory) {
                        this.editor.addToHistory?.(textContent);
                    }
                }
                break;
            }
            case "assistant":`;
    const insertWithImages = `// Render clipboard image previews
                    for (const { img, path } of images) {
                        this.chatContainer.addChild(new Spacer(1));
                        this.chatContainer.addChild(img);
                        const hyperlink = "\\x1b]8;;file://" + path + "\\x07Open in Preview\\x1b]8;;\\x07";
                        this.chatContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
                    }
                    if (options?.populateHistory) {
                        this.editor.addToHistory?.(textContent);
                    }
                }
                break;
            }
            case "assistant":`;
    c = c.replace(insertMarker, insertWithImages);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(f, c, 'utf8');
  }

  // Verify
  try {
    execSync(`node -c ${f}`, { stdio: 'pipe' });
    console.log(changed ? 'clipboard-image: patched + syntax OK' : '  clipboard-image: already patched');
  } catch (e: any) {
    console.error('clipboard-image: SYNTAX ERROR:', e.stderr?.toString().trim());
  }
}
