# Pi Git Permissions Extension

A specialized Pi Agent extension for managing git command permissions on a per-directory basis.

## Overview

This extension provides fine-grained control over which git commands the Pi Agent can execute in different directories. It uses `.git-permissions` files to define rules that allow, deny, or require approval for git operations.

## Installation

### Option 1: Global Installation (Recommended)

Copy or symlink the extension to your global Pi extensions directory:

```bash
# Copy the extension
cp -r /path/to/pi-less-shitty/packages/git-permissions ~/.pi/agent/extensions/git-permissions/

# Or create a symlink
ln -s /path/to/pi-less-shitty/packages/git-permissions ~/.pi/agent/extensions/git-permissions
```

### Option 2: Project-Local Installation

Add the extension path to your project's `settings.json`:

```json
{
  "extensions": ["/path/to/pi-less-shitty/packages/git-permissions"]
}
```

### Option 3: Use via CLI Flag

Test the extension without installing:

```bash
pi -e /path/to/pi-less-shitty/packages/git-permissions/index.ts
```

## Usage

### Creating Permission Files

Create a `.git-permissions` file in any directory where you want to control git access:

```bash
# In your project root
cd /path/to/project
cat > .git-permissions << 'EOF'
# Allow read-only git commands
allow ^\s*git\s+(status|log|diff|show|branch|tag)

# Ask for approval before write operations
ask ^\s*git\s+(add|commit|push|pull|merge|rebase)

# Deny dangerous operations
deny ^\s*git\s+push\s+--force
deny ^\s*git\s+reset\s+--hard
EOF
```

### File Format

Each line follows this format:
```
action pattern
```

**Actions:**
- `allow` - Execute without prompting
- `ask` - Require user confirmation via UI
- `deny` - Block completely (cannot be overridden)

**Patterns:**
- JavaScript regular expressions
- Matched against the full git command
- First matching rule wins

### Example Configurations

#### Allow All Git Commands
```
allow ^\s*git\s
```

#### Read-Only Access
```
allow ^\s*git\s+(status|log|diff|show|branch|tag|remote|ls-remote)
ask ^\s*git\s+(add|commit|push|pull|merge|rebase|checkout|stash)
deny ^\s*git\s+(reset|clean|filter-branch)
```

#### Block Force Push Only
```
allow ^\s*git\s
deny ^\s*git\s+push\s+--force
deny ^\s*git\s+push\s+-f
```

#### Require Approval for All Operations
```
ask ^\s*git\s
```

### Cascading Permissions

The extension searches upward from the current directory to find `.git-permissions` files:

1. **Most specific wins**: The deepest file (closest to cwd) takes precedence
2. **First match wins**: Within a file, the first matching rule is applied
3. **No file = no restrictions**: If no `.git-permissions` file exists, all git commands are allowed

### Command Chaining

The extension properly handles chained commands:

```bash
# Each subcommand is checked independently
git add . && git commit -m "fix" && git push
```

If any subcommand is denied or requires approval, the entire chain is blocked or prompts for approval.

## Integration with Safety Hooks

This extension is designed to work alongside the main `safety-hooks.ts` extension:

- **safety-hooks.ts**: General safety (sudo, disk ops, PDFs, file operations)
- **git-permissions**: Specialized git command control

You can use both together, or disable git checking in safety-hooks by removing the relevant section.

## Testing

### Test the Extension

```bash
# Navigate to a directory with .git-permissions
cd /path/to/project

# Start Pi with the extension
pi -e /path/to/pi-less-shitty/packages/git-permissions/index.ts

# Try git commands
# - Allowed commands execute freely
# - Denied commands are blocked
# - "Ask" commands prompt for confirmation
```

### Verify Permissions

```bash
# Check if extension is loaded
# Look for notification: "Git permissions active: N rule(s) loaded"

# Test allowed command
git status  # Should work without prompt

# Test denied command (if configured)
git push --force  # Should be blocked

# Test ask command (if configured)
git commit -m "test"  # Should prompt for approval
```

## Troubleshooting

### Extension Not Loading

1. Check file path is correct
2. Verify TypeScript syntax: `npx tsc --noEmit index.ts`
3. Check Pi logs for errors

### Permissions Not Applied

1. Verify `.git-permissions` file exists in directory tree
2. Check regex patterns are valid
3. Ensure action keywords are lowercase: `allow`, `ask`, `deny`
4. Test with simple pattern first: `allow ^\s*git\s`

### Commands Still Blocked

The main `safety-hooks.ts` extension may be blocking commands. Check:
- `.ai-permissions` files (used by safety-hooks)
- Hard-blocked commands (sudo, disk ops, etc.)
- Consider disabling git checks in safety-hooks if using this extension

## Development

### File Structure

```
pi-git-permissions/
├── index.ts           # Main extension code
├── package.json       # Package metadata
├── README.md          # This file
└── .git-permissions   # Example permissions file (optional)
```

### Key Functions

- `findGitPermissions(cwd)`: Locate and parse `.git-permissions` files
- `checkPermission(command, rules)`: Match command against rules
- `splitChainedCommands(command)`: Parse command chains
- Event handlers: `tool_call` and `session_start`

### Extending

To add new features:
1. Modify `findGitPermissions()` to support additional config formats
2. Add new permission actions beyond allow/ask/deny
3. Integrate with external permission systems
4. Add logging/auditing capabilities

## Comparison with .ai-permissions

| Feature | .git-permissions | .ai-permissions |
|---------|------------------|-----------------|
| Scope | Git commands only | All commands |
| Location | This extension | safety-hooks.ts |
| Default behavior | Allow if no file | Deny git if file exists |
| Complexity | Simple, focused | Comprehensive |
| Best for | Git-specific control | General command safety |

## License

MIT - Use freely in your projects.
