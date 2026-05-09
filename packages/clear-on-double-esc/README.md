# pi-clear-on-double-esc

A [pi](https://github.com/badlogic/pi-mono) extension that clears the editor input on double Escape.

## What it does

Press **Esc twice** within 500 ms while the editor has content to clear it.

- First Esc passes through normally — autocomplete dismissal and other built-in Esc behaviour still works.
- Only the second Esc (within the window) is consumed.
- When the editor is already empty, both presses pass through to pi's built-in `doubleEscapeAction` (`tree`, `fork`, or `none`).

Works with both legacy terminals and the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).

## Install

```bash
pi install https://github.com/iRonin/pi-clear-on-double-esc
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "https://github.com/iRonin/pi-clear-on-double-esc"
  ]
}
```

## How it interacts with `doubleEscapeAction`

| Editor state | Single Esc | Double Esc |
|---|---|---|
| Has content | passes through (autocomplete, etc.) | **clears editor** |
| Empty | passes through | triggers `doubleEscapeAction` (tree/fork/none) |
