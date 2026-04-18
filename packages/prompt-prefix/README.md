# pi-prompt-prefix

A [pi](https://github.com/badlogic/pi-mono) extension that prepends a configurable visual prefix to your prompts in the chat history, and optionally wraps them in yellow horizontal lines.

> **All decorations are display-only — they are never sent to the AI.** They are stripped before every LLM call, so they have zero effect on model behaviour or token usage.

Useful for making your own messages stand out in the scrollback and easy to search (`grep "❯ "`, `Cmd+F "CK❯ "`, etc.).

## Install

```bash
pi install git:github.com/iRonin/pi-prompt-prefix
```

## Usage

The default prefix is `❯ `. Every prompt you send will appear in the chat as:

```
❯ explain how async iterators work
```

The AI receives only `explain how async iterators work`.

### Yellow Borders

Enable horizontal yellow lines around your prompts (like the "Update available" notification):

```
/prompt-prefix borders on
```

This renders your messages as:

```
─────────────────────────────────────────────────────────────
❯ explain how async iterators work
─────────────────────────────────────────────────────────────
```

Disable with `/prompt-prefix borders off`.

### Commands

| Command | Description |
|---|---|
| `/prompt-prefix` | Show current settings |
| `/prompt-prefix <text>` | Set a new prefix, e.g. `/prompt-prefix "ME❯ "` |
| `/prompt-prefix off` | Disable prefix without changing the text |
| `/prompt-prefix on` | Re-enable prefix |
| `/prompt-prefix reset` | Restore defaults (prefix `❯ `, borders off) |
| `/prompt-prefix borders on` | Enable yellow horizontal lines |
| `/prompt-prefix borders off` | Disable yellow horizontal lines |

### Customising

```
/prompt-prefix CK❯_
```

Use `_` as a space placeholder — pi trims trailing spaces from command arguments. The example above sets the prefix to `"CK❯ "` (with trailing space).

Your choice is saved to `~/.pi/agent/prompt-prefix.json` and applies to all sessions.

**Examples:**

| Command | Resulting prefix |
|---|---|
| `/prompt-prefix CK❯_` | `CK❯ ` (with trailing space) |
| `/prompt-prefix ME❯` | `ME❯` (no trailing space) |
| `/prompt-prefix "_>_"` | ` > ` (spaces on both sides) |

## Notes

- Slash commands (anything starting with `/`) are never prefixed.
- Empty prompts are never decorated.
- The border width adapts to your terminal width at render time.
- Changing the prefix mid-session means older messages in that session's history keep the old prefix. The old prefix will still be stripped correctly from those messages before they reach the LLM, as long as the prefix hasn't changed between sessions — if it has, the LLM will see the old prefix on historical messages in that session. In practice this is harmless.
- Config is global (per machine), not per project.

## License

MIT
