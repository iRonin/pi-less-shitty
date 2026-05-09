// Patch pi dist files for prompt-dump CLI flag + reapply all other patches.
//
// LEGACY: This script predates patch-applier. New patches go in
// `packages/patch-applier/specs/`. Kept for the few patches that haven't been
// migrated yet (clipboard-image, anthropic-tool-parameters, session-shutdown).
//
// Scope-aware: handles @mariozechner ↔ @earendil-works rename via the
// shared pi-resolve helper.
import fs from 'node:fs';
import path from 'node:path';
import { patchClipboardImages } from './patch-clipboard-images.js';
import { findPiCodingAgentDistFromCaller } from '../packages/pi-resolve/src/index.ts';

const piDist = findPiCodingAgentDistFromCaller(import.meta.url);
if (!piDist) {
  console.error('apply-all-patches.ts: could not locate pi-coding-agent dist directory');
  process.exit(1);
}
const DIST = piDist.distDir;
const DIST_DIR = piDist.distDir;
const PI_PKG_DIR = piDist.pkgDir;

// ── 1. args.js: recognize --prompt-dump ──────────────────────────────
const argsFile = `${DIST}/cli/args.js`;
let args = fs.readFileSync(argsFile, 'utf8');

if (!args.includes('--prompt-dump')) {
  args = args.replace(
    'else if (arg === "--offline") {\n            result.offline = true;\n        }\n        else if (arg.startsWith("@"))',
    'else if (arg === "--offline") {\n            result.offline = true;\n        }\n        else if (arg === "--prompt-dump") {\n            result.promptDump = true;\n        }\n        else if (arg.startsWith("@"))'
  );
  fs.writeFileSync(argsFile, args, 'utf8');
  console.log('✓ args.js: --prompt-dump recognized');
} else {
  console.log('  args.js: already patched');
}

// ── 2. main.js: handle --prompt-dump ─────────────────────────────────
const mainFile = `${DIST}/main.js`;
let main = fs.readFileSync(mainFile, 'utf8');

if (!main.includes('--- prompt-dump handler ---')) {
  const listBlock = '    if (parsed.listModels !== undefined) {\n        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;\n        await listModels(modelRegistry, searchPattern);\n        process.exit(0);\n    }\n    // Read piped stdin content';

  const dumpBlock = `    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        process.exit(0);
    }
    // --- prompt-dump handler ---
    if (parsed.promptDump) {
        await session.bindExtensions({});

        const sysPrompt = session.systemPrompt || "";
        const totalTokens = Math.ceil(sysPrompt.length / 4);

        // Section breakdown
        const sectionMarkers = [
            { name: "Available tools", regex: /^Available tools:/m },
            { name: "Guidelines", regex: /^Guidelines:/m },
            { name: "Pi documentation", regex: /^Pi documentation/m },
            { name: "# Project Context", regex: /^# Project Context/m },
            { name: "Skills", regex: /<available_skills>/m },
            { name: "Footer (date/cwd)", regex: /^Current date:/m },
        ];
        const boundaries = [{ name: "Preamble", index: 0 }];
        for (const sp of sectionMarkers) {
            sp.regex.lastIndex = 0;
            const m = sp.regex.exec(sysPrompt);
            if (m) boundaries.push({ name: sp.name, index: m.index });
        }
        boundaries.sort((a, b) => a.index - b.index);

        const stats = [];
        for (let i = 0; i < boundaries.length; i++) {
            const s = boundaries[i].index;
            const e = i + 1 < boundaries.length ? boundaries[i + 1].index : sysPrompt.length;
            const t = Math.ceil(sysPrompt.slice(s, e).length / 4);
            stats.push({ name: boundaries[i].name, tokens: t, pct: ((t / totalTokens) * 100).toFixed(1) });
        }

        console.error("");
        console.error(chalk.bold("System Prompt Token Analysis"));
        console.error("─".repeat(60));
        console.error(chalk.bold("Total (chars/4 est.)".padEnd(35)) + chalk.bold(String(totalTokens).padStart(10)) + " tokens");
        console.error("");
        console.error(chalk.bold("Section Breakdown"));
        console.error("─".repeat(60));
        for (const s of stats) {
            const bar = "█".repeat(Math.round(parseFloat(s.pct) / 2));
            console.error("  " + chalk.green(s.name.padEnd(35)) + String(s.tokens).padStart(8) + " tokens  " + s.pct + "% " + chalk.dim(bar));
        }
        console.error("");

        // Context files
        const agentsFiles = resourceLoader.getAgentsFiles().agentsFiles || [];
        if (agentsFiles.length > 0) {
            console.error(chalk.bold("Context Files"));
            console.error("─".repeat(60));
            for (const f of agentsFiles) {
                const ft = Math.ceil((f.content || "").length / 4);
                console.error("  " + chalk.cyan(f.path) + "  " + ft + " tokens");
            }
            console.error("");
        }

        // Skills
        const skills = resourceLoader.getSkills() || [];
        const skillList = Array.isArray(skills) ? skills : (skills.skills || []);
        if (skillList.length > 0) {
            console.error(chalk.bold("Skills"));
            console.error("─".repeat(60));
            for (const sk of skillList) {
                const skPath = sk.path || sk.file || "";
                const skName = sk.name || require("node:path").basename(skPath, ".md");
                console.error("  " + chalk.yellow(skName));
            }
            console.error("");
        }

        // Full prompt
        console.error(chalk.bold("Full System Prompt"));
        console.error("─".repeat(60));
        console.error(sysPrompt);
        console.error("");
        console.error("─".repeat(60));
        console.error(chalk.bold("Total") + ": ~" + totalTokens.toLocaleString() + " tokens");
        console.error(chalk.bold("Chars") + ": " + sysPrompt.length.toLocaleString());

        process.exit(0);
    }
    // --- end prompt-dump handler ---
    // Read piped stdin content`;

  main = main.replace(listBlock, dumpBlock);
  fs.writeFileSync(mainFile, main, 'utf8');
  console.log('✓ main.js: --prompt-dump handler added');
} else {
  console.log('  main.js: already patched');
}

// ── 3. interactive-mode.js: agents-listing ────────────────────────────
const imFile = `${DIST}/modes/interactive/interactive-mode.js`;
let im = fs.readFileSync(imFile, 'utf8');

if (!im.includes('// --- agents-listing patch ---')) {
  const lastImport = 'import { getAvailableThemes, getAvailableThemesWithPaths, getEditorTheme, getMarkdownTheme, getThemeByName, initTheme, onThemeChange, setRegisteredThemes, setTheme, setThemeInstance, stopThemeWatcher, Theme, theme, } from "./theme/theme.js";';
  const agentFunc = `

// --- agents-listing patch ---
function _discoverAgents(cwd) {
  const a = [];
  const s = (d) => { try { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isFile() && e.name.endsWith('.md')) { const n = e.name.replace(/\\.md$/, ''); if (!a.find(x => x.name === n)) a.push({ name: n, dir: d }); } } } catch {} };
  let dir = path.resolve(cwd); const home = os.homedir();
  for (let i = 0; i < 30; i++) { s(path.join(dir, '.pi', 'agents')); const p = path.dirname(dir); if (p === dir || !dir.startsWith(home)) break; dir = p; }
  if (a.length === 0) {
    s(path.join(os.homedir(), 'Work/Pi-Agent/oh-pi/packages/subagents/agents'));
    s(path.join(os.homedir(), '.pi', 'agent', 'agents'));
  }
  return a;
}
// --- end agents-listing patch ---
`;
  im = im.replace(lastImport, lastImport + agentFunc);

  const afterSkills = '                addLoadedSection("Skills", skillCompactList, skillList);\n            }\n            const templates = this.session.promptTemplates;';
  const agentSection = '                addLoadedSection("Skills", skillCompactList, skillList);\n            }\n            // --- agents-listing section ---\n            {\n                const _agents = _discoverAgents(this.sessionManager.getCwd());\n                if (_agents.length > 0) {\n                    const _byDir = new Map();\n                    for (const _ag of _agents) { if (!_byDir.has(_ag.dir)) _byDir.set(_ag.dir, []); _byDir.get(_ag.dir).push(_ag.name); }\n                    const _collapsed = _agents.length + " agent" + (_agents.length > 1 ? "s" : "");\n                    const _expanded = Array.from(_byDir.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([d,ns]) => d + "\\n" + ns.sort().map(n=>"- "+n).join("\\n")).join("\\n");\n                    addLoadedSection("Agents", _collapsed, _expanded);\n                }\n            }\n            // --- end agents-listing section ---\n            const templates = this.session.promptTemplates;';
  im = im.replace(afterSkills, agentSection);

  // queue-emojis
  im = im.replaceAll('`Steering: ${message}`', '`🎯 Steer: ${message}`');
  im = im.replaceAll('`Follow-up: ${message}`', '`📥 Follow-up: ${message}`');

  // smart-dequeue
  const oldHD = `    handleDequeue() {
        const restored = this.restoreQueuedMessagesToEditor();
        if (restored === 0) {
            this.showStatus("No queued messages to restore");
        }
        else {
            this.showStatus(\`Restored \${restored} queued message\${restored > 1 ? "s" : ""} to editor\`);
        }
    }`;
  const newHD = `    handleDequeue() {
        const now = Date.now();
        const elapsed = now - (this.__smartDequeueLastPress || 0);
        this.__smartDequeueLastPress = now;
        const append = elapsed < 500;
        if (append && this.editor.getText().trim()) {
            const restored = this.restoreQueuedMessagesToEditorSmart({ type: this.__smartDequeuePhase === 0 ? "steer" : "followUp", append: true });
            if (restored > 0) {
                this.showStatus(\`Appended \${restored} queued message\${restored > 1 ? "s" : ""}\`);
                return;
            }
        }
        if (this.__smartDequeuePhase === 0) {
            const restored = this.restoreQueuedMessagesToEditorSmart({ type: "steer" });
            if (restored > 0) {
                this.__smartDequeuePhase = 1;
                this.showStatus(\`Restored \${restored} steer message\${restored > 1 ? "s" : ""}\`);
                return;
            }
        }
        if (this.__smartDequeuePhase <= 1) {
            const restored = this.restoreQueuedMessagesToEditorSmart({ type: "followUp" });
            if (restored > 0) {
                this.__smartDequeuePhase = 2;
                this.showStatus(\`Restored \${restored} follow-up message\${restored > 1 ? "s" : ""}\`);
                return;
            }
        }
        this.__smartDequeuePhase = 0;
        const restored = this.restoreQueuedMessagesToEditorSmart({ type: "all" });
        if (restored === 0) {
            this.showStatus("No queued messages to restore");
        }
        else {
            this.showStatus(\`Restored \${restored} queued message\${restored > 1 ? "s" : ""}\`);
        }
    }`;
  im = im.replace(oldHD, newHD);

  const oldRestore = `    restoreQueuedMessagesToEditor(options) {
        const { steering, followUp } = this.clearAllQueues();
        const allQueued = [...steering, ...followUp];
        if (allQueued.length === 0) {
            this.updatePendingMessagesDisplay();
            if (options?.abort) {
                this.agent.abort();
            }
            return 0;
        }
        const queuedText = allQueued.join("\\n\\n");
        const currentText = options?.currentText ?? this.editor.getText();
        const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\\n\\n");
        this.editor.setText(combinedText);
        this.updatePendingMessagesDisplay();
        if (options?.abort) {
            this.agent.abort();
        }
        return allQueued.length;
    }`;
  const newRestore = `    restoreQueuedMessagesToEditor(options) {
        return this.restoreQueuedMessagesToEditorSmart(options);
    }
    restoreQueuedMessagesToEditorSmart(options) {
        const type = options?.type ?? "all";
        const append = options?.append ?? false;
        let steer = [];
        let followUp = [];
        if (type === "steer" || type === "all") {
            const sessionSteer = this.session.getSteeringMessages() ?? [];
            const compSteer = this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
            steer = [...sessionSteer, ...compSteer];
        }
        if (type === "followUp" || type === "all") {
            const sessionFU = this.session.getFollowUpMessages() ?? [];
            const compFU = this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text);
            followUp = [...sessionFU, ...compFU];
        }
        if (type === "steer") {
            this.session._steeringMessages = [];
            this.compactionQueuedMessages = this.compactionQueuedMessages.filter((msg) => msg.mode !== "steer");
        }
        else if (type === "followUp") {
            this.session._followUpMessages = [];
            this.compactionQueuedMessages = this.compactionQueuedMessages.filter((msg) => msg.mode !== "followUp");
        }
        else {
            this.session.clearQueue();
            this.compactionQueuedMessages = [];
        }
        const allQueued = [...steer, ...followUp];
        if (allQueued.length === 0) {
            this.updatePendingMessagesDisplay();
            if (options?.abort) {
                this.agent.abort();
            }
            return 0;
        }
        const queuedText = allQueued.join("\\n\\n");
        const currentText = options?.currentText ?? this.editor.getText();
        let combinedText;
        if (append && currentText.trim()) {
            combinedText = [currentText, queuedText].filter((t) => t.trim()).join("\\n\\n");
        }
        else {
            combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\\n\\n");
        }
        this.editor.setText(combinedText);
        this.updatePendingMessagesDisplay();
        if (options?.abort) {
            this.agent.abort();
        }
        return allQueued.length;
    }`;
  im = im.replace(oldRestore, newRestore);

  fs.writeFileSync(imFile, im, 'utf8');
  console.log('✓ interactive-mode.js: all patches applied');
} else {
  console.log('  interactive-mode.js: already patched');
}

// ── 4. model-resolver.js: sort fix ────────────────────────────────────
const mrFile = `${DIST}/core/model-resolver.js`;
let mr = fs.readFileSync(mrFile, 'utf8');

if (!mr.includes('a.id.includes(":")')) {
  const buggy = '(a, b) => b.id.localeCompare(a.id)';
  const fixed = '(a, b) => { const ah = a.id.includes(":"); const bh = b.id.includes(":"); if (ah !== bh) return ah ? 1 : -1; return b.id.localeCompare(a.id); }';
  let count = 0;
  while (mr.includes(buggy) && count < 2) { mr = mr.replace(buggy, fixed); count++; }
  fs.writeFileSync(mrFile, mr, 'utf8');
  console.log('✓ model-resolver.js: sort fix applied');
} else {
  console.log('  model-resolver.js: already patched');
}

// ── 5. model-registry.js: apiKey + models.json fix ───────────────────
const mryFile = `${DIST}/core/model-registry.js`;
let mry = fs.readFileSync(mryFile, 'utf8');

if (!mry.includes('this.authStorage.hasAuth(providerName)')) {
  // Move _savedJson outside the if block
  mry = mry.replace(
    'if (config.models && config.models.length > 0) {\n            // Full replacement: remove existing models for this provider\n            this.models = this.models.filter((m) => m.provider !== providerName);',
    'const _savedJson = this.models.filter((m) => m.provider === providerName);\n        if (config.models && config.models.length > 0) {\n            // Full replacement: remove existing models for this provider\n            this.models = this.models.filter((m) => m.provider !== providerName);'
  );
  mry = mry.replace(
    'if (!providerConfig.apiKey) {',
    'if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {'
  );
  // Re-merge saved JSON at end of function
  mry = mry.replace(
    '    }\n}\n//# sourceMappingURL=model-registry.js.map',
    '        }\n        if (_savedJson.length > 0) { for (const _s of _savedJson) { if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s); } }\n    }\n}\n//# sourceMappingURL=model-registry.js.map'
  );
  fs.writeFileSync(mryFile, mry, 'utf8');
  console.log('✓ model-registry.js: fixes applied');
} else {
  console.log('  model-registry.js: already patched');
}

// ── Verify all syntax ────────────────────────────────────────────────
import { execSync } from 'node:child_process';
const files = [
  'cli/args.js',
  'main.js',
  'modes/interactive/interactive-mode.js',
  'core/model-resolver.js',
  'core/model-registry.js',
];

let allOk = true;
for (const rel of files) {
  const fullPath = `${DIST}/${rel}`;
  try {
    execSync(`node -c ${fullPath}`, { stdio: 'pipe' });
    console.log(`  ✓ ${rel}`);
  } catch (e: any) {
    console.error(`  ✗ ${rel}: ${e.stderr?.toString().trim() || e.message}`);
    allOk = false;
  }
}

if (allOk) {
  console.log('\n✅ All patches applied and syntax verified');
} else {
  console.error('\n❌ Some patches failed syntax check');
  process.exit(1);
}

// Clipboard image rendering
patchClipboardImages();

// -- 7. anthropic.js: tool.parameters null guard ---------------------------
// pi-ai sits as a sibling of pi-coding-agent under the same scope dir, so we
// derive its location from PI_PKG_DIR (scope-agnostic).
const anthropicFile = path.join(path.dirname(PI_PKG_DIR), 'pi-ai', 'dist', 'providers', 'anthropic.js');
if (fs.existsSync(anthropicFile)) {
  let af = fs.readFileSync(anthropicFile, 'utf8');
  if (!af.includes('tool.parameters ?? {}')) {
    af = af.replace('const schema = tool.parameters;', 'const schema = tool.parameters ?? {};');
    fs.writeFileSync(anthropicFile, af, 'utf8');
    console.log('\\u2713 anthropic.js: tool.parameters ?? {}');
  } else {
    console.log('  anthropic.js: already patched');
  }
}
// -- 8. runner.js: session_shutdown event default ---------------------------
import { patchSessionShutdown } from './patch-session-shutdown.js';
patchSessionShutdown();
import { patchOsc133 } from './patch-osc133.js';
patchOsc133();
