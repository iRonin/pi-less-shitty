import { Box, Container, Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
/**
 * iTerm2 prompt mark — Cmd+Shift+Up/Down navigates between prompts.
 * Zero-width OSC 133;A sequence.
 */
const OSC133_A = "\x1b]133;A\x07";
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
        const lines = super.render(width);
        if (lines.length === 0) {
            return lines;
        }
        const border = theme.fg("warning", "─".repeat(Math.max(1, width)));
        lines.unshift(border);
        lines[0] = OSC133_A + lines[0];
        lines.push(border);
        return lines;
    }
}
//# sourceMappingURL=user-message.js.map
