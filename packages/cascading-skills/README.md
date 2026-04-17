# Cascading Skills Extension for pi

Walks parent directories from CWD upward, collecting skills from every `.pi/settings.json` `skills` array and `.pi/skills/` directory it finds.

## Problem

Pi replaces (not merges) array-type settings like `skills`. A project-level skill array completely wipes out global skills:

```text
~/.pi/agent/settings.json    → skills: ["code-reviewer"]
project/.pi/settings.json    → skills: ["legal-researcher"]
Result                       → only ["legal-researcher"]  (code-reviewer lost!)
```

## Solution

This extension re-discovers skills at startup/reload by walking up the directory tree and collecting from every ancestor `.pi/` level. Returned paths are passed to pi's resource loader via the `resources_discover` event.

## Skill Sources (per CWD, in discovery order)

| Priority | Source |
|----------|--------|
| 1 | `~/.pi/agent/skills/` — global skills directory |
| 2 | `~/.pi/agent/settings.json` → `skills` — global skill array |
| 3 | Every parent `.pi/skills/` — ancestor skill directories |
| 4 | Every parent `.pi/settings.json` → `skills` — ancestor skill arrays |

## Installation

**Option A: Manual file**

Copy the extension to your global extensions directory:

```bash
cp extensions/cascading-skills.ts ~/.pi/agent/extensions/cascading-skills.ts
```

**Option B: npm package (recommended)**

```bash
npm install -g @ironin/pi-cascading-skills
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ironin/pi-cascading-skills"]
}
```

**Option C: Local path**

Clone this repo and add the path:

```json
{
  "extensions": ["/path/to/pi-cascading-skills/extensions/cascading-skills.ts"]
}
```

## Usage

Once installed, it works automatically. Start pi from any directory and all ancestor skills are discovered.

```bash
# Start from anywhere — skills from every parent .pi/ are loaded
cd ~/projects/legal/ecsc-123/
pi
```

### Example Project Layout

```
~/
├── .pi/
│   └── agent/
│       ├── settings.json          # skills: ["code-reviewer"]
│       └── skills/
│           └── code-reviewer/     # global developer skills
│
└── Work/
    └── .pi/
        ├── settings.json           # skills: ["legal-researcher"]
        └── skills/
            └── legal-researcher/   # project developer skills
        │
        └── LegalProject/
            └── .pi/
                ├── settings.json   # skills: ["ecsc-drafter"]
                └── skills/         # project legal skills
                    └── ecsc-drafter/
```

Starting `pi` from `~/Work/LegalProject/` gives you ALL skills from all three levels.

## Security

- **HOME boundary**: All resolved paths must stay under `$HOME`. Entries pointing outside are silently rejected.
- **Symlink safe**: Every path is `realpathSync()`'d before use. Symlinked sub-dirs are validated against the HOME boundary.
- **Traversal cap**: Parent walking is limited to 30 levels to prevent runaway scans on network mounts.
- **No environment trust**: `HOME` is resolved once at load time, not re-read from `process.env`.

## License

MIT
