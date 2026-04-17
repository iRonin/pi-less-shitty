# Pi Hooks - Project Summary

## Overview

**Pi Hooks** is a flexible, directory-based permission system for Pi Agent that controls which bash commands can be executed without approval. It uses `.pi-hooks` configuration files with regex patterns to define `allow`, `ask`, or `deny` rules for commands.

## Repository Structure

```
pi-hooks/
├── index.ts                  # Main extension (653 lines)
├── test/
│   └── hooks.test.ts         # Test suite (434 lines, 50+ tests)
├── package.json              # Package metadata & scripts
├── tsconfig.json             # TypeScript configuration
├── vitest.config.ts          # Test configuration
├── README.md                 # Comprehensive documentation
├── CONTRIBUTING.md           # Contribution guidelines
├── LICENSE                   # MIT License
├── .gitignore                # Git ignore rules
└── .github/
    └── workflows/
        └── test.yml          # CI/CD pipeline
```

## Key Features

### 1. Directory-Based Permissions
- `.pi-hooks` files control permissions per directory
- Cascading configuration (searches up directory tree)
- Most specific file (deepest) takes precedence

### 2. Three Action Types
- **allow** - Execute without prompting
- **ask** - Require user confirmation via UI
- **deny** - Block completely (cannot be overridden)

### 3. Security Layers

#### Hard Blocks (Cannot Be Overridden)
- `sudo` - Privilege escalation
- `dd`, `mkfs*`, `diskutil` - Disk operations
- `> /dev/sd*`, `> /dev/nvme*` - Device writes
- `DROP TABLE`, `TRUNCATE` - Destructive SQL
- `kill -1` - Kill all processes

#### Opaque Commands (Always Require Approval)
- `bash -c`, `sh -c` - Opaque shell execution
- `eval` - Opaque eval
- `| bash`, `| sh` - Pipe to shell

#### Path Safety
- Validates file operation targets
- Blocks operations outside project directory
- Allows `/tmp`, `~/Downloads`, and project paths

### 4. Command Processing
- Splits chained commands (`&&`, `||`, `;`, `|`)
- Respects quotes (single and double)
- Checks each subcommand independently
- Validates redirect targets

## Testing

### Test Coverage
- ✅ 50+ test cases
- ✅ Command splitting logic
- ✅ Permission rule matching
- ✅ Path safety validation
- ✅ Home directory resolution
- ✅ Project root detection
- ✅ Hard block patterns
- ✅ Opaque command detection
- ✅ Integration scenarios (git, npm workflows)
- ✅ Edge cases (empty input, quotes, nested commands)

### Running Tests
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run typecheck     # Type checking
```

## Installation & Usage

### Global Installation
```bash
ln -s /path/to/pi-hooks ~/.pi/agent/extensions/hooks
```

### Create Configuration
```bash
cd /path/to/project
cat > .pi-hooks << 'EOF'
# Allow all git commands
allow ^\s*git\s

# Ask for file operations
ask ^\s*(rm|mv|cp|chmod)\s

# Deny dangerous
deny ^\s*sudo\s
EOF
```

### Start Pi Agent
```bash
pi
# Should see: "Pi hooks active: N rule(s) from .pi-hooks"
```

## Configuration Examples

### Web Development
```
allow ^\s*(npm|yarn|pnpm)\s+(install|run|test|build)\s
allow ^\s*git\s
ask ^\s*(rm|mv|cp)\s+(?!src/)
deny ^\s*sudo\s
```

### Data Science
```
allow ^\s*python3?\s
allow ^\s*jupyter\s+(notebook|lab)\s
ask ^\s*pip3?\s+uninstall\s
allow ^\s*git\s
deny ^\s*sudo\s
```

### Strict Mode
```
ask .*
allow ^\s*(ls|pwd|whoami|date|git\s+status)\s
```

## Security Model

### Permission Check Flow
```
Command Received
    ↓
1. HARD BLOCKS → BLOCK IMMEDIATELY
    ↓ Pass
2. OPAQUE CMDS → ALWAYS PROMPT
    ↓ Pass/Approved
3. .pi-hooks RULES
   ├─ deny → BLOCK
   ├─ ask → PROMPT
   └─ allow → SKIP remaining
    ↓ No config or no match
4. FILE OPS → Check path safety
    ↓ Pass
5. REDIRECTS → Check path safety
    ↓ Pass
6. DANGEROUS CMDS → Prompt
    ↓ Pass
EXECUTE ✅
```

### Threat Model
Protects against:
1. Accidental destructive operations
2. Privilege escalation
3. Opaque command injection
4. Path traversal
5. Redirect attacks

### Limitations
- Not OS-level security
- Regex can be obfuscated
- Relies on Pi Agent interception
- No argument validation beyond patterns

## Development

### Prerequisites
- Node.js 18+
- npm or yarn

### Setup
```bash
npm install
npm test
npm run typecheck
```

### Code Quality
- TypeScript strict mode
- ESLint + Prettier ready
- Comprehensive test coverage
- JSDoc documentation
- Conventional commits

## CI/CD

### GitHub Actions
- Tests on Node 18, 20, 22
- Type checking
- Automated on push/PR
- Coverage reporting

## Migration

### From safety-hooks.ts
1. Install pi-hooks extension
2. Rename `.ai-permissions` to `.pi-hooks` (syntax identical)
3. Optionally disable safety-hooks git checking
4. Test with your workflows

See `HOOKS-MIGRATION-GUIDE.md` for details.

## API Reference

### Extension Events
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  // Check permissions
});

pi.on("session_start", async (event, ctx) => {
  ctx.ui.notify("Hooks loaded", "info");
});
```

### Exported Functions (Testing)
```typescript
export function splitChainedCommands(command: string): string[]
export function checkPermission(command: string, rules): Action | null
export function isPathSafe(filePath: string, projectRoot: string): boolean
export function findProjectRoot(start: string): string
export function resolveHomePath(p: string): string
export function safeRealpath(p: string): string
```

## Files Summary

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 653 | Main extension code |
| `test/hooks.test.ts` | 434 | Test suite |
| `README.md` | ~350 | Documentation |
| `CONTRIBUTING.md` | ~200 | Contribution guide |
| `package.json` | - | Package metadata |
| `tsconfig.json` | - | TypeScript config |
| `.github/workflows/test.yml` | - | CI pipeline |

**Total:** ~1,637 lines of code + documentation

## License

MIT License - See LICENSE file

## Repository

**GitHub:** github.com/iRonin/pi-hooks

**Author:** iRonin

**Version:** 1.0.0

## Next Steps

1. ✅ Code complete
2. ✅ Tests written
3. ✅ Documentation complete
4. ✅ CI/CD configured
5. ⏳ Publish to GitHub
6. ⏳ Add to Pi Agent extension registry
7. ⏳ Community feedback

## Acknowledgments

- Inspired by Claude Code's hooks system
- Built on Pi Agent's extension API
- Pattern matching inspired by gitignore

---

**Status:** Ready for production use 🚀
