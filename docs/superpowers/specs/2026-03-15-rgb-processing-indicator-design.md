# RGB Processing Indicator — Design Spec

**Date:** 2026-03-15
**Status:** Reviewed

## Overview

When the Discord bot is actively processing an AI request (awaiting a Temporal workflow), the RGB lights turn a bright sky blue (`#00AAFF`). When no requests are in-flight, the lights are off. On server startup, the lights are reset to off.

## Components

### `rgb/presets/processing.sh` (new)
Shell preset setting all four OpenRGB devices to static `#00AAFF`. Must have execute permission (`chmod +x`).

```bash
#!/usr/bin/env bash
# Processing preset — bright sky blue
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 00AAFF  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 00AAFF  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 2
```

### `hub/src/rgb.ts` (new)
Exports a `RgbStateManager` class.

**Constructor:** accepts the absolute path to the `rgb-set` binary. Resolved in `index.ts` as:
```ts
const RGB_SET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rgb/rgb-set');
```
(This mirrors the pattern in `bot.ts`, which resolves from `hub/dist/discord/` as `../../../rgb/rgb-set`.)

**API:**

| Method | Return type | Behavior |
|---|---|---|
| `startProcessing()` | `void` | Increments `activeCount`. If 0→1, calls `rgb-set processing` (fire-and-forget). |
| `endProcessing()` | `void` | Decrements `activeCount`. If 1→0, calls `rgb-set off` (fire-and-forget). Guards against going negative: if already 0, logs `console.error` and returns without decrementing. |
| `reset()` | `Promise<void>` | Sets `activeCount` to 0, calls `rgb-set off`. Returns a Promise that resolves when `execFile` completes. Used at startup (awaited) to ensure lights are off before the bot is reachable. |

`startProcessing()` and `endProcessing()` are fire-and-forget (void) so they never block message handling. `reset()` is awaitable for startup ordering.

RGB `execFile` errors are logged with `console.error` and never thrown.

### `hub/src/bot.ts` (modified)
`createDiscordBot` gains a third parameter: `rgbManager: RgbStateManager` (after `config` and `temporalClient`).

In the `messageCreate` handler, the Temporal workflow call is wrapped:
- `rgbManager.startProcessing()` before `temporalClient.workflow.execute(...)`
- `rgbManager.endProcessing()` in a `finally` block — guarantees execution on success, workflow error, or reply failure

**Manual RGB command interaction:** The existing `parseRgbCommand` early-return path is unchanged. If a user sends any manual RGB command (`rgb off`, `rgb work`, `rgb gaming`, etc.) while a workflow is in-flight, the lights will change immediately. When the workflow finishes, `endProcessing()` will fire `rgb-set off`, returning the lights to idle state. This is accepted behavior — manual commands always take effect immediately.

### `hub/src/index.ts` (modified)
Startup sequence in `main()`:

```ts
const RGB_SET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rgb/rgb-set');
const rgbManager = new RgbStateManager(RGB_SET);
await rgbManager.reset();                                             // lights off before bot is reachable
const discordClient = createDiscordBot(config, temporalClient, rgbManager);
await startDiscordBot(discordClient, config);
```

SIGTERM handler gains `rgbManager.reset()` (fire-and-forget — process exits immediately after):
```ts
process.on('SIGTERM', () => {
  rgbManager.reset();   // fire-and-forget; process exits before completion is guaranteed
  void worker.shutdown();
  stateStore.close();
  discordClient.destroy();
  void connection.close();
  process.exit(0);
});
```

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
| `rgb/presets/processing.sh` | Create (chmod +x required) |
| `hub/src/rgb.ts` | Create |
| `hub/src/bot.ts` | Modify — add `rgbManager` third param, wrap workflow call |
| `hub/src/index.ts` | Modify — instantiate manager, await reset() at startup, fire reset() in SIGTERM |
