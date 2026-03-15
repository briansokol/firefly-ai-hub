# RGB Processing Indicator — Design Spec

**Date:** 2026-03-15
**Status:** Approved

## Overview

When the Discord bot is actively processing an AI request (awaiting a Temporal workflow), the RGB lights turn a bright sky blue (`#00AAFF`). When no requests are in-flight, the lights are off. On server startup, the lights are reset to off.

## Components

### `rgb/presets/processing.sh` (new)
Shell preset setting all four OpenRGB devices to static `#00AAFF`. Follows the same structure as existing presets (`off.sh`, `work.sh`, etc.).

### `hub/src/rgb.ts` (new)
Exports a `RgbStateManager` class:

| Method | Behavior |
|---|---|
| `startProcessing()` | Increments `activeCount`. If transition was 0→1, calls `rgb-set processing`. |
| `endProcessing()` | Decrements `activeCount`. If transition was 1→0, calls `rgb-set off`. |
| `reset()` | Sets `activeCount` to 0, calls `rgb-set off`. Used at startup. |

RGB calls are fire-and-forget via `execFile`. Errors are logged with `console.error` and never thrown. The `activeCount` counter is safe without locking because Node.js is single-threaded.

### `hub/src/bot.ts` (modified)
In the `messageCreate` handler, the Temporal workflow call is wrapped:
- `manager.startProcessing()` before `temporalClient.workflow.execute(...)`
- `manager.endProcessing()` in a `finally` block — guarantees execution on success, workflow error, or reply failure

The existing manual RGB command path (`parseRgbCommand`) is unchanged.

### `hub/src/index.ts` (modified)
Calls `manager.reset()` during startup, before `client.login()`, so lights are off before the bot is reachable.

## Data Flow

### Single request
```
message → startProcessing() [0→1 → rgb-set processing]
  → workflow.execute(...)
  → reply
  → [finally] endProcessing() [1→0 → rgb-set off]
```

### Concurrent requests
```
msg A → startProcessing() [0→1 → rgb-set processing]
msg B → startProcessing() [1→2, no rgb change]
msg A done → endProcessing() [2→1, no rgb change]
msg B done → endProcessing() [1→0 → rgb-set off]
```

### Error path
```
message → startProcessing() [0→1 → rgb-set processing]
  → workflow.execute() throws
  → [finally] endProcessing() [1→0 → rgb-set off]
```

## Color Choice

| Preset | Color | Hex |
|---|---|---|
| processing (new) | Bright sky blue | `#00AAFF` |
| work (existing) | Cool blue-white | `#4A90D9` |
| off (existing) | Off | `#000000` |

`#00AAFF` is visually distinct from the `work` preset — brighter and more saturated.

## Files Changed

| File | Change |
|---|---|
| `rgb/presets/processing.sh` | Create |
| `hub/src/rgb.ts` | Create |
| `hub/src/bot.ts` | Modify — wrap workflow call with startProcessing/endProcessing |
| `hub/src/index.ts` | Modify — call reset() at startup |
