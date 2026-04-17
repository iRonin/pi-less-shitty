# @ironin/pi-kilocode-model-fix

Fixes custom-provider (kilocode, etc.) default model resolution at startup.

## Problem

`findInitialModel()` in pi-mono runs **before** custom provider registrations
(queued during extension load) are applied to the ModelRegistry. Users with
`defaultProvider` set to a custom provider silently fall back to the first
built-in provider with auth configured.

See: https://github.com/sudosubin/pi-frontier/issues/19

## How it works

On `session_start` (after `bindCore()` has processed all queued provider
registrations), this extension:
1. Reads `defaultProvider` / `defaultModel` from `settings.json`
2. Checks if the active model already matches
3. If not, polls the registry briefly and switches via `ctx.setModel()`

No upstream code changes required.
