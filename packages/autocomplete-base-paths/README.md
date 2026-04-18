# @ironin/pi-autocomplete-base-paths

Multi-directory file autocomplete for pi's TUI. Type `@` to fuzzy-search files across configured root directories.

## Problem

When working in deep subdirectories, pi's `@` file autocomplete only searches the current working directory. Files at the project root are invisible.

## Solution

At extension load time, this package:

1. **Walks parent directories** from CWD to root, collecting `autocompleteBasePaths` from every `.pi/settings.json`
2. **Patches the installed pi dist files** (`autocomplete.js`, `interactive-mode.js`, `settings-manager.js`) to support multi-base fuzzy search
3. **Runs `fd` against all base paths** with `--ignore-case`, merging and deduplicating results

## Usage

In any project's `.pi/settings.json`:

```json
{
  "autocompleteBasePaths": ["/absolute/path/to/project/root"]
}
```

When CWD is `/project/root/deep/sub/dir`, typing `@cpr` will find files in both `cwd` and the configured base path.

### Example: Legal project

```
/Legal Opinion Action/
├── .pi/settings.json          ← has autocompleteBasePaths
├── ECSC CPR 2023.md
├── CK-Claim/
│   └── ...
└── RA Modification Claim RA-MOD/
    └── Payment Injunction Appeal/
        └── (you work here, deep CWD)
```

With this `.pi/settings.json`:
```json
{
  "autocompleteBasePaths": ["/path/to/Legal Opinion Action"]
}
```

Typing `@cpr` from the deep subdirectory finds `ECSC CPR 2023.md` at the root.

### Project isolation

Settings are **per-project**, not global. When working on a dev project, legal files won't appear in autocomplete.

## Features

- **Parent walking** — discovers `autocompleteBasePaths` from any `.pi/settings.json` between CWD and root
- **Case insensitive** — `@cpr` matches `ECSC CPR 2023.md`
- **Spaces handled** — paths with spaces auto-quoted as `@"path with spaces/file.md"`
- **Deduplication** — files found in overlapping trees appear once
- **Self-patching** — patches dist files at load time, survives `npm update` (re-applies on next start)
- **Zero config** — no setup needed if your project has `.pi/settings.json` with `autocompleteBasePaths`

## Architecture

```
Extension load → patches dist files on disk
  ↓
pi startup → interactive-mode.js walks parent .pi/settings.json
  ↓
@ fuzzy search → fd runs against cwd + all collected base paths
```

## Tests

```bash
cd ~/Work/Pi-Agent/pi-less-shitty
node --test --import tsx packages/autocomplete-base-paths/test/autocomplete-base-paths.test.ts
```

11 tests covering: parent walking, deduplication, ~ expansion, spaces, malformed JSON, case-insensitive fd search.
