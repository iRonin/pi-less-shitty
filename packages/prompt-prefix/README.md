# pi-prompt-prefix

A [pi](https://github.com/badlogic/pi-mono) extension that prepends a configurable visual prefix to your prompts in the chat history.

> **The prefix is display-only — it is never sent to the AI.** It is stripped before every LLM call, so it has zero effect on model behaviour or token usage.

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

### Commands

| Command | Description |
|---|---|
| `/prompt-prefix` | Show current prefix and status |
| `/prompt-prefix <text>` | Set a new prefix, e.g. `/prompt-prefix "ME❯ "` |
| `/prompt-prefix off` | Disable without changing the prefix text |
| `/prompt-prefix on` | Re-enable |
| `/prompt-prefix reset` | Restore default (`❯ `) |

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
- Changing the prefix mid-session means older messages in that session's history keep the old prefix. The old prefix will still be stripped correctly from those messages before they reach the LLM, as long as the prefix hasn't changed between sessions — if it has, the LLM will see the old prefix on historical messages in that session. In practice this is harmless.
- Config is global (per machine), not per project.

## License

MIT
