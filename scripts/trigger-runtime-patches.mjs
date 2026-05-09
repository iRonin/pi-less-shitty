// Trigger all legacy runtime-patch extensions against the live dist.
// Used post-staged-upgrade.sh to apply patches whose session_start handler
// hasn't fired yet (because the smoke test launches with --no-extensions).
//
// After running this, release-check.ts and patch-applier --check should both
// report all patches applied.

const fakePi = { on: () => {} };

const exts = [
  '../packages/model-sort-fix/src/model-sort-fix.ts',
  '../packages/osc133-neutralize/src/index.ts',
  '../packages/prompt-dump/src/index.ts',
  '../packages/smart-dequeue/src/index.ts',
  '../packages/queue-emojis/src/index.ts',
  '../packages/agents-listing/src/index.ts',
  '../packages/compaction-tokens/src/index.ts',
  '../packages/model-registry-fix/src/model-registry-fix.ts',
];

let ok = 0, fail = 0;
for (const path of exts) {
  try {
    const m = await import(path);
    if (typeof m.default === 'function') {
      m.default(fakePi);
      console.log('+', path);
      ok++;
    } else {
      console.log('-', path, '(no default export)');
    }
  } catch (e) {
    console.error('!', path, e.message);
    fail++;
  }
}

console.log(`\n${ok} extensions triggered, ${fail} failed`);
