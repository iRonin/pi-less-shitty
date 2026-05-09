/**
 * Tests for the model-registry-fix spec.
 *
 * The spec covers TWO independent behavior fixes inside a single dist file:
 *   1. validateConfig — apiKey check must defer to authStorage.hasAuth()
 *   2. applyProviderConfig — must preserve models.json custom models
 *
 * The fixtures below mimic the *shape* of pi's compiled model-registry.js,
 * not its full content. Each test asserts on behavior the spec must
 * guarantee:
 *
 *   - pristine (neither fix applied)        → verify() must reject
 *   - fully patched (both applied)          → verify() must accept
 *   - half-patched (only fix 1 OR fix 2)    → verify() must reject AND name
 *                                              the missing fix in failures
 *   - future pi where the error wording was reworded and the indent shrank
 *     but both fixes were correctly re-derived → verify() must still accept
 *
 * An applier integration test then uses applyOne() with a mocked deriveEdits
 * to prove that a perfect-agent transformation of the pristine fixture
 * produces a file that verifies clean.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, describe, before, after } from "node:test";

import { applyOne } from "../src/applier.ts";
import { spec as modelRegistryFixSpec } from "../specs/model-registry-fix.ts";

// ---------------------------------------------------------------------------
// Synthetic dist fixtures
// ---------------------------------------------------------------------------

// Pre-patch shape: matches pi's compiled validateConfig + applyProviderConfig
// closely enough to exercise the spec's regex patterns.
const PRISTINE = `
export class ModelRegistry {
    validateConfig(config) {
        const builtInProviders = new Set(getProviders());
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            const isBuiltIn = builtInProviders.has(providerName);
            const models = providerConfig.models ?? [];
            if (models.length === 0) {
                continue;
            }
            else if (!isBuiltIn) {
                if (!providerConfig.baseUrl) {
                    throw new Error(\`Provider \${providerName}: "baseUrl" is required when defining custom models.\`);
                }
                if (!providerConfig.apiKey) {
                    throw new Error(\`Provider \${providerName}: "apiKey" is required when defining custom models.\`);
                }
            }
        }
    }
    applyProviderConfig(providerName, config) {
        this.storeProviderRequestConfig(providerName, config);
        if (config.models && config.models.length > 0) {
            this.models = this.models.filter((m) => m.provider !== providerName);
            for (const modelDef of config.models) {
                this.models.push({
                    id: modelDef.id,
                    name: modelDef.name,
                    provider: providerName,
                });
            }
            if (config.oauth?.modifyModels) {
                const cred = this.authStorage.get(providerName);
                if (cred?.type === "oauth") {
                    this.models = config.oauth.modifyModels(this.models, cred);
                }
            }
        }
        else if (config.baseUrl || config.headers) {
            this.models = this.models.map((m) => m);
        }
    }
}
`;

// Both fixes applied (matches the live legacy patcher's output shape).
const FULLY_PATCHED = `
export class ModelRegistry {
    validateConfig(config) {
        const builtInProviders = new Set(getProviders());
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            const isBuiltIn = builtInProviders.has(providerName);
            const models = providerConfig.models ?? [];
            if (models.length === 0) {
                continue;
            }
            else if (!isBuiltIn) {
                if (!providerConfig.baseUrl) {
                    throw new Error(\`Provider \${providerName}: "baseUrl" is required when defining custom models.\`);
                }
                if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {
                    throw new Error(\`Provider \${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).\`);
                }
            }
        }
    }
    applyProviderConfig(providerName, config) {
        this.storeProviderRequestConfig(providerName, config);
        if (config.models && config.models.length > 0) {
            const _savedJson = this.models.filter((m) => m.provider === providerName);
            this.models = this.models.filter((m) => m.provider !== providerName);
            for (const modelDef of config.models) {
                this.models.push({
                    id: modelDef.id,
                    name: modelDef.name,
                    provider: providerName,
                });
            }
            if (config.oauth?.modifyModels) {
                const cred = this.authStorage.get(providerName);
                if (cred?.type === "oauth") {
                    this.models = config.oauth.modifyModels(this.models, cred);
                }
            }
            for (const _s of _savedJson) {
                if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);
            }
        }
        else if (config.baseUrl || config.headers) {
            this.models = this.models.map((m) => m);
        }
    }
}
`;

// Only Fix 1 applied (validateConfig fixed, applyProviderConfig still wipes).
const ONLY_FIX1 = `
export class ModelRegistry {
    validateConfig(config) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {
                throw new Error(\`Provider \${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).\`);
            }
        }
    }
    applyProviderConfig(providerName, config) {
        if (config.models && config.models.length > 0) {
            this.models = this.models.filter((m) => m.provider !== providerName);
            for (const modelDef of config.models) {
                this.models.push({ id: modelDef.id, provider: providerName });
            }
        }
    }
}
`;

// Only Fix 2 applied (applyProviderConfig preserves, validateConfig still
// requires apiKey unconditionally).
const ONLY_FIX2 = `
export class ModelRegistry {
    validateConfig(config) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            if (!providerConfig.apiKey) {
                throw new Error(\`Provider \${providerName}: "apiKey" is required when defining custom models.\`);
            }
        }
    }
    applyProviderConfig(providerName, config) {
        if (config.models && config.models.length > 0) {
            const _savedJson = this.models.filter((m) => m.provider === providerName);
            this.models = this.models.filter((m) => m.provider !== providerName);
            for (const modelDef of config.models) {
                this.models.push({ id: modelDef.id, provider: providerName });
            }
            for (const _s of _savedJson) {
                if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);
            }
        }
    }
}
`;

// Future-pi durability claim:
//   - error message reworded ("must be set" instead of "is required")
//   - indentation shrunk from 4-space-times-N to 2-space-times-N
//   - variable names renamed (providerConfig → pCfg, _savedJson → snapshot, _s → entry)
//   - extra unrelated guard clause inserted
// The patches were correctly re-derived against this shape; verify must accept.
const FUTURE_PATCHED = `
export class ModelRegistry {
  validateConfig(config) {
    if (!config?.providers) return;
    for (const [providerName, pCfg] of Object.entries(config.providers)) {
      const models = pCfg.models ?? [];
      if (models.length === 0) continue;
      if (!pCfg.baseUrl) {
        throw new Error(\`Provider \${providerName}: baseUrl must be set\`);
      }
      if (!pCfg.apiKey && !this.authStorage.hasAuth(providerName)) {
        throw new Error(\`Provider \${providerName}: apiKey must be set, or run /login\`);
      }
    }
  }
  applyProviderConfig(providerName, config) {
    if (config.models && config.models.length > 0) {
      const snapshot = this.models.filter((m) => m.provider === providerName);
      this.models = this.models.filter((m) => m.provider !== providerName);
      for (const md of config.models) {
        this.models.push({ id: md.id, provider: providerName });
      }
      for (const entry of snapshot) {
        if (!this.models.some((m) => m.id === entry.id)) this.models.push(entry);
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("model-registry-fix spec.verify", () => {
	test("rejects pristine (neither fix applied)", () => {
		const r = modelRegistryFixSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Both fixes must be flagged as missing
			assert.ok(
				r.failures.some((f) => /Fix 1/.test(f)),
				`expected a Fix 1 failure, got: ${r.failures.join(" | ")}`,
			);
			assert.ok(
				r.failures.some((f) => /Fix 2/.test(f)),
				`expected a Fix 2 failure, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("accepts fully-patched fixture", () => {
		const r = modelRegistryFixSpec.verify(FULLY_PATCHED);
		assert.equal(
			r.ok,
			true,
			!r.ok ? `unexpected failures: ${r.failures.join(" | ")}` : "",
		);
	});

	test("rejects partial: only Fix 1 applied (Fix 2 missing)", () => {
		const r = modelRegistryFixSpec.verify(ONLY_FIX1);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Must specifically name Fix 2 as the missing one, NOT Fix 1
			assert.ok(
				r.failures.some((f) => /Fix 2/.test(f)),
				`expected a Fix 2 failure, got: ${r.failures.join(" | ")}`,
			);
			assert.ok(
				!r.failures.some((f) => /Fix 1/.test(f)),
				`Fix 1 is applied, must not be flagged: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("rejects partial: only Fix 2 applied (Fix 1 missing)", () => {
		const r = modelRegistryFixSpec.verify(ONLY_FIX2);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Must specifically name Fix 1 as the missing one, NOT Fix 2
			assert.ok(
				r.failures.some((f) => /Fix 1/.test(f)),
				`expected a Fix 1 failure, got: ${r.failures.join(" | ")}`,
			);
			assert.ok(
				!r.failures.some((f) => /Fix 2/.test(f)),
				`Fix 2 is applied, must not be flagged: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("accepts future-pi shape (error wording + indent + var names changed)", () => {
		const r = modelRegistryFixSpec.verify(FUTURE_PATCHED);
		assert.equal(
			r.ok,
			true,
			!r.ok
				? `verify is text-pinned (not behavior-pinned): ${r.failures.join(" | ")}`
				: "",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Applier integration with mocked deriveEdits
// ---------------------------------------------------------------------------

describe("applyOne(model-registry-fix)", () => {
	let tmpDistDir: string;
	const targetRel = modelRegistryFixSpec.target;

	before(() => {
		tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-applier-mrf-"));
		fs.mkdirSync(path.join(tmpDistDir, path.dirname(targetRel)), { recursive: true });
	});

	after(() => {
		fs.rmSync(tmpDistDir, { recursive: true, force: true });
	});

	function writeTarget(content: string) {
		fs.writeFileSync(path.join(tmpDistDir, targetRel), content, "utf8");
	}

	function readTarget(): string {
		return fs.readFileSync(path.join(tmpDistDir, targetRel), "utf8");
	}

	test("returns 'already' against fully-patched fixture (marker present)", async () => {
		writeTarget(FULLY_PATCHED);
		const result = await applyOne(modelRegistryFixSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => {
				throw new Error("should not be called when already patched");
			},
		});
		assert.equal(result.status, "already");
	});

	test("perfect-agent edits transform pristine → fully-patched", async () => {
		writeTarget(PRISTINE);
		const result = await applyOne(modelRegistryFixSpec, {
			distDir: tmpDistDir,
			deriveEdits: async (_spec, content) => {
				// Sanity: agent saw the pristine shape
				assert.ok(content.includes("if (!providerConfig.apiKey) {"));
				assert.ok(content.includes("this.models.filter((m) => m.provider !== providerName);"));
				return [
					// Fix 1: extend the apiKey guard with hasAuth()
					{
						find:
							'if (!providerConfig.apiKey) {\n' +
							'                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);',
						replace:
							'if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {\n' +
							'                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).`);',
					},
					// Fix 2a: snapshot before wipe filter
					{
						find:
							'            this.models = this.models.filter((m) => m.provider !== providerName);',
						replace:
							'            const _savedJson = this.models.filter((m) => m.provider === providerName);\n' +
							'            this.models = this.models.filter((m) => m.provider !== providerName);',
					},
					// Fix 2b: insert merge-back loop after the modifyModels block,
					// before the close of the `if (config.models …)` branch.
					{
						find:
							'            if (config.oauth?.modifyModels) {\n' +
							'                const cred = this.authStorage.get(providerName);\n' +
							'                if (cred?.type === "oauth") {\n' +
							'                    this.models = config.oauth.modifyModels(this.models, cred);\n' +
							'                }\n' +
							'            }\n' +
							'        }',
						replace:
							'            if (config.oauth?.modifyModels) {\n' +
							'                const cred = this.authStorage.get(providerName);\n' +
							'                if (cred?.type === "oauth") {\n' +
							'                    this.models = config.oauth.modifyModels(this.models, cred);\n' +
							'                }\n' +
							'            }\n' +
							'            for (const _s of _savedJson) {\n' +
							'                if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);\n' +
							'            }\n' +
							'        }',
					},
				];
			},
		});
		assert.equal(result.status, "applied", result.message);
		// File on disk verifies clean
		const v = modelRegistryFixSpec.verify(readTarget());
		assert.equal(
			v.ok,
			true,
			!v.ok ? `post-apply verify failed: ${v.failures.join(" | ")}` : "",
		);
	});

	test("rejects when agent only fixes one of the two (verify still failing)", async () => {
		writeTarget(PRISTINE);
		const result = await applyOne(modelRegistryFixSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [
				// Only Fix 1 — Fix 2 left undone, verify must trip
				{
					find:
						'if (!providerConfig.apiKey) {\n' +
						'                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);',
					replace:
						'if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {\n' +
						'                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).`);',
				},
			],
		});
		assert.equal(result.status, "failed");
		assert.match(result.message ?? "", /verify still failing/);
		// File on disk reverted (applyOne doesn't write a partial patch)
		assert.equal(readTarget(), PRISTINE);
	});
});
