# pi-patch-applier

AI-driven runtime patcher for pi customizations. Each patch is a `PatchSpec` —
a plain-language `intent` plus a programmatic `verify` function. The actual
text edits are **re-derived against the current pi dist on every upgrade** by
dispatching a pi subagent, then gated by `verify`. Specs and verifiers are the
durable artifacts; text anchors are not. Survives upstream refactors (function
renames, formatter changes, class splits) that would break rigid string/regex
patchers.

## Why

- Brittle problem: rigid regex/string patches against `dist/` files break on every upstream refactor.
- Solution: a spec describes the **behavioral intent** + a programmatic verify; an LLM re-derives the text edits at apply time.
- The verify gate guarantees correctness regardless of how the LLM produced the edits.
- Three layers of defense:
  1. Each `find` string is checked for **uniqueness** in the target file before substitution.
  2. After all edits apply, the spec's `verify` is re-run.
  3. Edits are buffered in memory — a failed verify rolls back, never writing a half-applied state to disk.

## Architecture

```
packages/patch-applier/
  src/
    types.ts          # PatchSpec contract
    applier.ts        # applyOne / applyAll, agent dispatch, validation, verify gate
    cli.ts            # CLI entry: --check, --spec, --dist, --json
    index.ts          # pi extension entry (opt-in; CLI is the canonical entry)
  specs/
    queue-emojis.ts
    smart-dequeue.ts
    model-registry-fix.ts
    agents-listing.ts
    compaction-tokens.ts
  test/
    applier.test.ts          # core unit + e2e
    <id>.test.ts             # one per spec, including future-version durability
```

## Spec contract

From `src/types.ts`:

```ts
export interface PatchSpec {
  id: string;       // stable identifier — filename, log key, marker base
  target: string;   // path inside pi-coding-agent dist
  intent: string;   // durable plain-language: what behavior changes, where, why
  hint?: string;    // optional pseudocode or before/after shape — not authoritative
  marker?: string;  // optional fast idempotency string; verify is authoritative
  verify: (content: string) => VerifyResult;
}

export type VerifyResult = { ok: true } | { ok: false; failures: string[] };
```

- **`intent`** — durable. No variable names, no anchors. Describes behavior.
- **`hint`** — disposable. Helps the agent on first apply; ignored by verify.
- **`marker`** — fast path only. A unique string the patch deterministically inserts.
- **`verify`** — authoritative. Must catch partial patches (new form present **and** old form absent).

## CLI

```bash
# Verify all specs against the current pi dist (dry-run, no agent dispatch)
npx tsx src/cli.ts --check

# Apply: dispatches a pi subagent for any spec whose verify currently fails
npx tsx src/cli.ts

# Single spec
npx tsx src/cli.ts --spec queue-emojis

# Override dist path (for staged-install testing)
npx tsx src/cli.ts --dist /tmp/staging/.../pi-coding-agent/dist

# Machine-readable output for scripts/agents
npx tsx src/cli.ts --json
```

Exit codes: `0` = all ok, `1` = one or more specs failed, `2` = invocation error
(bad args, no specs found, no dist).

Env vars:

- `PI_PATCH_TIMEOUT_MS` — per-spec agent dispatch timeout in ms.
  Default `120000`. `scripts/staged-upgrade.sh` overrides to `300000` on retry.

## How the applier works

Per spec, in `applyOne` (`src/applier.ts`):

1. Read `dist/<spec.target>` from disk.
2. If `marker` is present → return `already` (fast path).
3. Run `verify(content)` → if `ok`, return `already`.
4. Build a prompt from `intent` + `hint` + the verify failures + the current file.
5. Spawn a pi subagent (`spawnPi`, with `PI_PATCH_TIMEOUT_MS` ceiling).
6. Parse JSON `{ edits: [{ find, replace }, ...] }` from agent stdout.
7. **Validate**: every `find` must occur exactly once in the file (uniqueness gate).
8. Apply edits to an in-memory copy.
9. Re-run `verify` against the patched copy.
10. **Commit-or-rollback**: write to disk only if verify passes; otherwise return `failed` and the original file is untouched.

## Adding a new spec

1. Create `specs/<id>.ts` exporting a `PatchSpec`.
2. Write `verify` first — must reject pristine, accept fully-patched, reject partial.
3. Write `intent` in plain language. No identifiers from the current dist.
4. Add `test/<id>.test.ts` with at minimum: pristine reject, patched accept, partial reject, **future-version durability** (simulated upstream refactor).
5. Run `npm test`. Then `npx tsx src/cli.ts --spec <id>` against a real dist.

Full authoring guide: `~/Work/.pi/skills/patch-applier/SKILL.md`.

## Tests

```bash
npm test  # node --experimental-strip-types --test test/*.test.ts
```

Current: **49/49 passing** across 5 spec test files + applier core tests.
Every spec includes a "future-version durability" test that mutates the fixture
to simulate an upstream refactor (renamed identifiers, reformatted bodies,
restructured callsites) and proves `verify` still accepts the correctly
re-derived form.

## Integration

- `scripts/staged-upgrade.sh` — invokes the CLI between `npm install` and the
  smoke test. Per-spec retry loop with `PI_PATCH_TIMEOUT_MS=300000`.
- Custom orchestration agents can drive the full upgrade-and-patch flow autonomously.
- `src/index.ts` is registered as a pi extension via `package.json` → `pi.extensions`,
  but session-start re-application is **not** the canonical path. The CLI is.

## Spec authoring rules (key ones)

1. `intent` is durable plain-language. No variable names, no text anchors. Describe BEHAVIOR.
2. `verify` checks behavior, not text shape. Regex on the transformation, not on specific identifiers.
3. `verify` must catch partial patches: assert new form **present** AND old form **absent**.
4. `marker` is a fast path; `verify` is authoritative.
5. Every spec ships with a future-version durability test.

Full ruleset: `~/Work/.pi/skills/patch-applier/SKILL.md`.

## See also

- Skill: `~/Work/.pi/skills/patch-applier/SKILL.md`
- Scripts: `~/Work/Pi-Agent/pi-less-shitty/scripts/staged-upgrade.sh`, `rollback.sh`
