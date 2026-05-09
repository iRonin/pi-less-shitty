import fs from 'node:fs';

export function patchOsc133(): void {
  const files = [
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js',
    '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js',
  ];

  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let c = fs.readFileSync(f, 'utf8');

    if (!c.includes('const OSC133_ZONE_START = "";')) {
      c = c.replace(/const OSC133_ZONE_START = ".*?";/, 'const OSC133_ZONE_START = "";');
      c = c.replace(/const OSC133_ZONE_END = ".*?";/, 'const OSC133_ZONE_END = "";');
      c = c.replace(/const OSC133_ZONE_FINAL = ".*?";/, 'const OSC133_ZONE_FINAL = "";');
      fs.writeFileSync(f, c, 'utf8');
      console.log(`osc133: neutralized ${f.split('/').pop()}`);
    } else {
      console.log(`  osc133: already neutralized ${f.split('/').pop()}`);
    }
  }
}
