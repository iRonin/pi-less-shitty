import fs from 'node:fs';
import { execSync } from 'node:child_process';

export function patchSessionShutdown(): void {
  const f = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
  if (!fs.existsSync(f)) return;
  let c = fs.readFileSync(f, 'utf8');

  if (c.includes('const shutdownEvent = event ??')) {
    console.log('  session-shutdown: already patched');
    return;
  }

  c = c.replace(
    'export async function emitSessionShutdownEvent(extensionRunner, event) {\n    if (extensionRunner.hasHandlers("session_shutdown"))',
    'export async function emitSessionShutdownEvent(extensionRunner, event) {\n    const shutdownEvent = event ?? { type: "session_shutdown" };\n    if (extensionRunner.hasHandlers("session_shutdown"))'
  );

  c = c.replace('await extensionRunner.emit(event);', 'await extensionRunner.emit(shutdownEvent);');

  fs.writeFileSync(f, c, 'utf8');
  console.log('session-shutdown: patched');
}
