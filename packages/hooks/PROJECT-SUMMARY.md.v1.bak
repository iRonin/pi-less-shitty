# Pi Hooks - Project Summary

## Overview

**Pi Hooks** is a flexible, directory-based permission system for Pi Agent that controls which bash commands can be executed without approval. It uses `.pi-hooks` configuration files with regex patterns to define `allow`, `ask`, or `deny` rules for commands.

Includes a companion **safety-hooks.ts** extension with additional guards: PDF size limits, PDF venv enforcement, and markdown trailing-space preservation.

## Repository Structure

```
packages/hooks/
├── src/
│   ├── index.ts          # Main hooks extension (~729 lines)
│   ├── safety-hooks.ts   # PDF, spacing, extra safety guards (~968 lines)
│   └── permission-ui.ts  # 4-choice dialog + session allowlist + sounds (~150 lines)
├── .pi-hooks             # Example config
├── .ai-permissions       # Legacy/compat config
├── package.json
└── PROJECT-SUMMARY.md    # This file
```

## Key Features

### 1. 5-Choice Permission Dialog

Replaces binary yes/no with an interactive selector:

| Choice | Effect |
|--------|--------|
| **Allow** | Allow this one execution (no persistence) |
| **Allow for Session** | Add to in-memory allowlist, cleared on `session_start` |
| **Allow Permanently** | Prompt for regex → append `allow <pattern>` to `.pi-hooks` |
| **Deny** | Block with generic message |
| **Deny & Steer** | Block + custom guidance visible to LLM as tool result |

### 2. Double-Prompt Prevention

Both `index.ts` and `safety-hooks.ts` register `tool_call` on `bash`. A `promptingFor` Set prevents concurrent prompts for the same command. Early guards in both handlers skip commands already approved or being prompted by the other handler.

### 2. Session-Scoped Allowlist

In-memory `Set<string>` — patterns approved for the current session.
- Cleared automatically on every `session_start`
- Checked early in the pipeline (step 2), before `.pi-hooks` and ALWAYS_ASK

### 3. Directory-Based Permissions
- `.pi-hooks` files control permissions per directory
- Cascading configuration (searches up directory tree)
- Most specific file (deepest) takes precedence
- `allow` rules bypass the ALWAYS_ASK opaque-command check (fixes ordering bug)

### 4. Three Action Types (`.pi-hooks` file)
- **allow** - Execute without prompting, bypasses remaining safety checks
- **ask** - Opens 4-choice permission dialog
- **deny** - Block completely (cannot be overridden)

### 5. Attention Sounds + iTerm2 Visual Indicators

| Event | Sound | Visual |
|-------|-------|--------|
| **Hooks prompt** (needs action) | `Sosumi.aiff` (sharp alert) | Bell + ⚠️ badge on tab |
| **Agent end** (turn complete) | `Ping.aiff` (soft chime) | Bell only (blue dot on inactive tab) |

### 6. Security Layers

#### Hard Blocks (Cannot Be Overridden)
- `sudo` - Privilege escalation
- `dd`, `mkfs*`, `diskutil` - Disk operations
- `> /dev/sd*`, `> /dev/nvme*` - Device writes
- `DROP TABLE`, `TRUNCATE` - Destructive SQL
- `kill -1` - Kill all processes

#### Path Safety
- Validates file operation targets
- Blocks operations outside project directory
- Allows `/tmp`, `~/Downloads`, and project paths
- Validates redirect targets

### 7. Command Processing
- Splits chained commands (`&&`, `||`, `;`, `|`)
- Respects quotes (single and double)
- Checks each subcommand independently

## Permission Check Flow (Updated)

```
Command Received
    ↓
1. HARD BLOCKS → BLOCK IMMEDIATELY (unoverridable)
    ↓ Pass
2. SESSION ALLOWLIST → ALLOW & CONTINUE (approved this session)
    ↓ Not in allowlist
2b. ALREADY PROMPTING → CONTINUE (another handler is handling it)
    ↓ Not being prompted
3. .pi-hooks RULES
   ├─ allow → SKIP all remaining checks (including ALWAYS_ASK)
   ├─ deny → BLOCK
   └─ ask → 5-CHOICE PERMISSION DIALOG
    ↓ No config or no match
4. ALWAYS_ASK (opaque cmds: bash -c, eval, pipe-to-shell)
   → 5-CHOICE PERMISSION DIALOG
    ↓ Pass/Approved
5. FILE OPS → Check path safety → 5-CHOICE PERMISSION DIALOG if outside project
    ↓ Pass
6. REDIRECTS → Check path safety → 5-CHOICE PERMISSION DIALOG if outside project
    ↓ Pass
7. DANGEROUS CMDS (kill -9, killall, chmod 777, etc.)
   → 5-CHOICE PERMISSION DIALOG
    ↓ Pass
EXECUTE ✅
```

## Companion: safety-hooks.ts

Loaded alongside the main hooks. Adds:

### PDF Guard
- Blocks reading PDFs > 2MB or > 10 pages
- Suggests targeted reads, MCP search, or background agents
- Detects existing `.md` versions

### PDFenv Guard
- Forces PDF processing scripts to use `/tmp/pdfenv/bin/python3`
- Prevents dependency errors from system Python

### Trailing Spaces Guard
- Warns when edits remove markdown double-space line breaks
- Injects warning into tool result for LLM visibility

### Additional Opaque Checks
- `xargs` with destructive commands
- `find -delete` / `find -exec rm` with path safety

## Configuration Examples

### Basic
```
# .pi-hooks in project root
allow ^\s*git\s
allow ^\s*(npm|yarn|pnpm)\s+(install|run|test|build)\s
ask ^\s*(rm|mv|cp)\s
deny ^\s*sudo\s
```

### Allow expect/bash -c (needed for interactive test scripts)
```
allow ^\s*expect\s
allow ^\s*bash\s+-c\s
```

### Strict Mode
```
ask .*
allow ^\s*(ls|pwd|whoami|date|git\s+status)\s
```

## API Reference

### Exported from `permission-ui.ts`
```typescript
// Session allowlist
export function clearSessionAllowlist(): void
export function isSessionAllowed(command: string): boolean
export function addToSessionAllowlist(pattern: string): void

// Sounds
export function attentionSound(): void   // Sosumi + bell + badge
export function agentDoneSound(): void   // Ping + bell

// Permission dialog
export async function askPermission(
  command: string,
  reason: string,
  ui: UIAdapter
): Promise<PermissionResult | null>

// Prevents double prompts between index.ts and safety-hooks.ts
export function isAlreadyPrompting(command: string): boolean
export function markPrompting(command: string): void
export function unmarkPrompting(command: string): void

export function buildBlockReason(
  command: string,
  result: PermissionResult,
): string
```

### Exported from `index.ts` (Testing)
```typescript
export function splitChainedCommands(command: string): string[]
export function checkPermission(command: string, rules): Action | null
export function isPathSafe(filePath: string, projectRoot: string): boolean
export function findProjectRoot(start: string): string
export function resolveHomePath(p: string): string
export function safeRealpath(p: string): string
```

## Migration Notes

### From old binary confirm() system
- All prompts now use the 4-choice dialog
- Session allowlist replaces repeated confirmations for identical commands
- `.pi-hooks` `allow` rules now correctly bypass ALWAYS_ASK (was a bug)

### Sound customization
- Change sounds by editing the `.aiff` path in `permission-ui.ts`
- Available macOS sounds: `/System/Library/Sounds/{Basso,Blow,Bottle,Frog,Funk,Glass,Hero,Morse,Ping,Pop,Purr,Sosumi,Submarine,Tink}.aiff`
- iTerm2 bell behavior: Preferences → Profiles → Terminal → Bell

## License

MIT License

## Author

CK @ iRonin.IT

---

**Status:** Production use 🚀
