# prompt-token-expander

Generic pi extension that expands tokens like `{{PI_DIST}}` in the assembled system prompt at session start. Solves the scope-rename auto-refresh problem by making prompt files reference pi install paths via durable tokens instead of hardcoded paths.

## Purpose

When you maintain PRIVATE prompt files (`<cwd>/.pi/SYSTEM.md`, `<cwd>/.pi/APPEND_SYSTEM.md`, `CLAUDE.md`, etc.) that reference pi-coding-agent install paths, those references go stale every time pi's package name changes (e.g., the v0.74.0 scope rename from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`) or when you upgrade versions.

This extension makes those references durable by letting you embed tokens in your prompt files. At session start, before the prompt goes to the LLM, the extension expands the tokens using the scope-aware `pi-resolve` helper.

## Tokens Supported

| Token | Expands To | Example |
|-------|-----------|---------|
| `{{PI_DIST}}` | Absolute path to pi-coding-agent's `dist` directory | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist` |
| `{{PI_PKG_DIR}}` | pi-coding-agent's package directory (parent of dist) | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` |
| `{{PI_PKG_NAME}}` | Full package name with scope | `@earendil-works/pi-coding-agent` |
| `{{PI_SCOPE}}` | Package scope | `@earendil-works` |
| `{{PI_VERSION}}` | Version from package.json | `0.74.0` |
| `{{PI_DOCS}}` | Package docs directory | `<pkg-dir>/docs` |
| `{{PI_EXAMPLES}}` | Package examples directory | `<pkg-dir>/examples` |
| `{{PI_README}}` | Package README.md path | `<pkg-dir>/README.md` |

**Unknown tokens** (e.g., `{{FOOBAR}}`) are left untouched — not an error.

## Example Usage

In your `~/.pi/agent/APPEND_SYSTEM.md` or `<project>/.pi/APPEND_SYSTEM.md`:

```markdown
# Project Context

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {{PI_README}}
- Additional docs: {{PI_DOCS}}
- Examples: {{PI_EXAMPLES}} (extensions, custom tools, SDK)
- When asked about: extensions ({{PI_DOCS}}/extensions.md, {{PI_EXAMPLES}}/extensions/), themes ({{PI_DOCS}}/themes.md), skills ({{PI_DOCS}}/skills.md)
```

At session start, before the prompt goes to the LLM, the extension expands the tokens:

```markdown
# Project Context

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)
- When asked about: extensions (/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md, /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/), themes (/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/themes.md), skills (/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md)
```

## Why This Matters

**Scope-rename durability**: When pi's package name changed from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` in v0.74.0, any prompt files with hardcoded paths like `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs` stopped working. With tokens, you write `{{PI_DOCS}}` once, and it automatically tracks the current install path.

**Version upgrades**: When you upgrade pi, the paths in your prompts stay correct. No manual search-and-replace needed.

**Multi-environment support**: Same prompt files work across different install layouts (homebrew, nvm, npm-global, monorepo) because `pi-resolve` auto-detects the live install.

## How to Add a Token

Edit `buildTokenMap()` in `packages/prompt-token-expander/src/index.ts`:

```typescript
export function buildTokenMap(): Record<string, string> {
	const res = findPiCodingAgentDistFromCaller(import.meta.url);
	if (!res) return {};

	// ... existing token setup ...

	return {
		// ... existing tokens ...
		MY_NEW_TOKEN: path.join(res.pkgDir, "my-custom-path"),
	};
}
```

Run tests to verify:

```bash
cd /Users/ironin/Work/Pi-Agent/pi-less-shitty/packages/prompt-token-expander
node --experimental-strip-types --test test/*.test.ts
```

## Hook Used

This extension hooks `before_agent_start`, which fires after the user submits a prompt but before the agent loop starts. At this point:

- The system prompt has been assembled from all sources (SYSTEM.md, APPEND_SYSTEM.md, skills, flags, etc.)
- Extension system prompt modifications are chained (earlier handlers can modify, this extension sees the result)
- The prompt has NOT yet been sent to the LLM

This is the correct hook because:
1. We need to see the fully assembled system prompt (not just individual files)
2. We need to modify it BEFORE it goes to the LLM (otherwise tokens won't expand in time)
3. We don't want to persist changes back to disk (which would erase the user's tokens)

Alternative approaches rejected:
- `session_start` + file rewrite: Would permanently replace tokens in the user's files ❌
- `context` event: Too late — prompt already assembled and about to be sent ❌
- `before_provider_request`: Would need to parse provider-specific payloads ❌

## Installation

This extension is part of the `pi-less-shitty` monorepo. It's auto-loaded via `settings.json` → `packages`:

```json
{
  "packages": [
    "/Users/ironin/Work/Pi-Agent/pi-less-shitty/packages/prompt-token-expander"
  ]
}
```

## Testing

```bash
cd /Users/ironin/Work/Pi-Agent/pi-less-shitty/packages/prompt-token-expander
node --experimental-strip-types --test test/*.test.ts
```

All tests pass:
- ✓ expandTokens replaces known tokens
- ✓ expandTokens leaves unknown tokens untouched
- ✓ expandTokens leaves text without tokens unchanged
- ✓ expandTokens handles empty string
- ✓ expandTokens handles multiple occurrences of same token
- ✓ buildTokenMap returns expected keys when pi-resolve succeeds
- ✓ default export hooks before_agent_start
- ✓ extension expands tokens in system prompt

## License

MIT
