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

  // 1. Add `Image` to the pi-tui import.
  //
  // Robust to upstream adding/removing other named imports (v0.74.0 added
  // `getCapabilities` and `hyperlink` which broke the previous exact-list
  // match). Approach: find the import line by `from "<scope>/pi-tui"`,
  // parse brace contents, insert `Image` if absent, reconstruct.
  // Symbols sorted case-insensitively to match upstream's typical style.
  const piTuiImportRe = /import \{([^}]+)\} from "(@[a-z-]+\/pi-tui)";/;
  const importMatch = c.match(piTuiImportRe);
  if (importMatch) {
    const symbols = importMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!symbols.includes('Image')) {
      symbols.push('Image');
      symbols.sort((a, b) => a.localeCompare(b, 'en', { caseFirst: 'lower' }));
      const scope = importMatch[2];
      c = c.replace(
        piTuiImportRe,
        `import { ${symbols.join(', ')}, } from "${scope}";`,
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

  // 3. Wire into user case.
  //
  // v0.74.0+ inserted an `if (this.chatContainer.children.length > 0)` block
  // between the `if (textContent)` and `parseSkillBlock(...)` lines, breaking
  // the original 3-line exact-match anchor. Use a regex that just anchors on
  // `const skillBlock = parseSkillBlock(textContent);` and inject the
  // displayText/images definitions IMMEDIATELY BEFORE that line.
  //
  // Idempotent: skipped when `extractClipboardImages(textContent)` already
  // present in the file.
  if (!c.includes('extractClipboardImages(textContent)')) {
    const skillAnchor = /(\s+)(const skillBlock = parseSkillBlock\(textContent\);)/;
    const m = c.match(skillAnchor);
    if (m) {
      const indent = m[1].replace(/^\n+/, '');
      const inject =
        m[1] +
        `const { text: cleanText, images: clipImages } = this.extractClipboardImages(textContent);` +
        `\n${indent}const displayText = cleanText || textContent;` +
        `\n${indent}const images = clipImages;` +
        `\n${indent}` + m[2];
      c = c.replace(skillAnchor, inject);
      changed = true;
    }
    // No-match is silently skipped; steps 4 and 5 below are gated on this
    // step having run via the `extractClipboardImages(textContent)` includes()
    // check, so they won't fire and produce a half-applied patch.
  }

  // 4. Replace textContent with displayText in UserMessageComponent.
  //    Gated on step 3 having run — if the user case wasn't wired,
  //    `displayText` won't exist in scope and replacing here would crash pi.
  if (
    c.includes('extractClipboardImages(textContent)') &&
    c.includes('new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings())') &&
    !c.includes('new UserMessageComponent(displayText,')
  ) {
    c = c.replace(
      'new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings())',
      'new UserMessageComponent(displayText, this.getMarkdownThemeWithSettings())'
    );
    changed = true;
  }

  // 5. Add image rendering after user case.
  //    Also gated on step 3 having succeeded — the loop references `images`
  //    which only exists if step 3 declared it.
  if (
    c.includes('extractClipboardImages(textContent)') &&
    !c.includes('for (const { img, path } of images)')
  ) {
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
