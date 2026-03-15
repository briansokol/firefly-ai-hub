# RGB Processing Indicator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn RGB lights bright sky blue when the Discord bot is processing an AI request, and off when idle.

**Architecture:** A new `RgbStateManager` class in `hub/src/rgb.ts` owns a reference counter and calls `rgb-set` when the counter crosses the 0↔1 boundary. `bot.ts` calls `startProcessing()`/`endProcessing()` around each Temporal workflow execution. `index.ts` instantiates the manager and resets lights at startup and on SIGTERM.

**Tech Stack:** Node.js ESM, TypeScript, Vitest (tests), `node:child_process.execFile`, OpenRGB CLI (via existing `rgb/rgb-set` shell script)

**Spec:** `docs/superpowers/specs/2026-03-15-rgb-processing-indicator-design.md`

---

## Chunk 1: Preset file and RgbStateManager

### Task 1: Create `processing.sh` preset

**Files:**
- Create: `rgb/presets/processing.sh`

- [ ] **Step 1: Create the file**

```bash
cat > rgb/presets/processing.sh << 'EOF'
#!/usr/bin/env bash
# Processing preset — bright sky blue
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 00AAFF  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 00AAFF  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 2
EOF
chmod +x rgb/presets/processing.sh
```

- [ ] **Step 2: Verify the file is executable and matches other presets**

Run: `ls -la rgb/presets/`
Expected: `processing.sh` listed with `-rwxr-xr-x` permissions alongside `off.sh`, `work.sh`, etc.

- [ ] **Step 3: Smoke-test via rgb-set (optional — only if OpenRGB is running)**

Run: `rgb/rgb-set processing`
Expected: No error output; lights turn `#00AAFF`. Run `rgb/rgb-set off` to restore.

- [ ] **Step 4: Commit**

```bash
git add rgb/presets/processing.sh
git commit -m "feat(rgb): add processing preset — bright sky blue #00AAFF"
```

---

### Task 2: Implement `RgbStateManager` with TDD

**Files:**
- Create: `hub/src/rgb.ts`
- Create: `hub/tests/rgb.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `hub/tests/rgb.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing the module under test.
// execFile is mocked to call its callback immediately (success).
// promisify(execFile) wraps this same mock, so reset() resolves immediately too.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)),
}));

import { execFile } from 'node:child_process';
import { RgbStateManager } from '../src/rgb.js';

const mockExecFile = vi.mocked(execFile);
const RGB_SET = '/fake/rgb-set';

beforeEach(() => {
  mockExecFile.mockClear();
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)
  );
});

describe('RgbStateManager', () => {
  describe('startProcessing()', () => {
    it('calls rgb-set processing on first call (0→1)', () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile).toHaveBeenCalledWith(RGB_SET, ['processing'], expect.any(Function));
    });

    it('does not call rgb-set on second call (1→2)', () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      mockExecFile.mockClear();
      mgr.startProcessing();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('endProcessing()', () => {
    it('does not call rgb-set when going from 2→1', () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      mgr.startProcessing();
      mockExecFile.mockClear();
      mgr.endProcessing();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('calls rgb-set off when going from 1→0', () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      mockExecFile.mockClear();
      mgr.endProcessing();
      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile).toHaveBeenCalledWith(RGB_SET, ['off'], expect.any(Function));
    });

    it('does not decrement below 0 and logs an error', () => {
      const mgr = new RgbStateManager(RGB_SET);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.endProcessing(); // already 0
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('endProcessing'));
      spy.mockRestore();
    });
  });

  describe('reset()', () => {
    it('calls rgb-set off and resolves', async () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      mgr.startProcessing();
      mockExecFile.mockClear();
      await mgr.reset();
      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile).toHaveBeenCalledWith(RGB_SET, ['off'], expect.any(Function));
    });

    it('sets activeCount to 0 so a subsequent endProcessing logs error', async () => {
      const mgr = new RgbStateManager(RGB_SET);
      mgr.startProcessing();
      await mgr.reset();
      mockExecFile.mockClear();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.endProcessing(); // count is 0 after reset
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('resolves even if rgb-set fails', async () => {
      const mgr = new RgbStateManager(RGB_SET);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
          cb(new Error('openrgb not found'))
      );
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(mgr.reset()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module not found)**

Run from `hub/`: `npm test -- --reporter=verbose 2>&1 | grep -E "rgb|FAIL|Error"`
Expected: FAIL — `Cannot find module '../src/rgb.js'`

- [ ] **Step 3: Implement `RgbStateManager`**

Create `hub/src/rgb.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class RgbStateManager {
  private activeCount = 0;

  constructor(private readonly rgbSetPath: string) {}

  startProcessing(): void {
    this.activeCount++;
    if (this.activeCount === 1) {
      execFile(this.rgbSetPath, ['processing'], (err) => {
        if (err) console.error('RgbStateManager: execFile error:', err);
      });
    }
  }

  endProcessing(): void {
    if (this.activeCount === 0) {
      console.error('RgbStateManager: endProcessing() called with activeCount already 0');
      return;
    }
    this.activeCount--;
    if (this.activeCount === 0) {
      execFile(this.rgbSetPath, ['off'], (err) => {
        if (err) console.error('RgbStateManager: execFile error:', err);
      });
    }
  }

  async reset(): Promise<void> {
    this.activeCount = 0;
    try {
      await execFileAsync(this.rgbSetPath, ['off']);
    } catch (err) {
      console.error('RgbStateManager: execFile error:', err);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `hub/`: `npm test -- --reporter=verbose 2>&1 | grep -E "rgb|PASS|FAIL"`
Expected: All `RgbStateManager` tests pass, no failures.

- [ ] **Step 5: Verify TypeScript compiles**

Run from `hub/`: `npm run build`
Expected: No errors. `dist/rgb.js` is created.

- [ ] **Step 6: Commit**

```bash
git add hub/src/rgb.ts hub/tests/rgb.test.ts
git commit -m "feat(hub): add RgbStateManager — reference-counted RGB state"
```

---

## Chunk 2: Wire up bot.ts and index.ts

### Task 3: Integrate `RgbStateManager` into bot and startup

**Files:**
- Modify: `hub/src/bot.ts`
- Modify: `hub/src/index.ts`

- [ ] **Step 1: Update `hub/src/bot.ts`**

Add this import after the existing imports:
```typescript
import { RgbStateManager } from '../rgb.js';
```

Change the `createDiscordBot` signature (add third param):
```typescript
export function createDiscordBot(config: Config, temporalClient: TemporalClient, rgbManager: RgbStateManager): Client {
```

Replace the `try/catch` block in the `messageCreate` handler (the block starting at `try {` around `temporalClient.workflow.execute`) with:
```typescript
    rgbManager.startProcessing();
    try {
      const reply = await temporalClient.workflow.execute<ChatWorkflow>(
        'chatWorkflow',
        {
          args: [route.model, SYSTEM_PROMPT, route.content],
          taskQueue: 'firefly-ai-hub',
          workflowId: `chat-${message.id}`,
        },
      );
      for (const chunk of splitMessage(reply)) {
        await message.reply(chunk);
      }
    } catch {
      await message.reply('⚠️ Model unavailable, try again in a moment.');
    } finally {
      rgbManager.endProcessing();
    }
```

- [ ] **Step 2: Update `hub/src/index.ts`**

Add these imports alongside the existing `path` import at the top:
```typescript
import { fileURLToPath } from 'node:url';
import { RgbStateManager } from './rgb.js';
```

Add this block at the start of `main()`, before `createDiscordBot`:
```typescript
  const RGB_SET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rgb/rgb-set');
  const rgbManager = new RgbStateManager(RGB_SET);
  await rgbManager.reset();
```

Pass `rgbManager` to `createDiscordBot`:
```typescript
  const discordClient = createDiscordBot(config, temporalClient, rgbManager);
```

In the `SIGTERM` handler, add `rgbManager.reset()` as the first line:
```typescript
  process.on('SIGTERM', () => {
    rgbManager.reset();
    void worker.shutdown();
    stateStore.close();
    discordClient.destroy();
    void connection.close();
    process.exit(0);
  });
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run from `hub/`: `npm run build`
Expected: No errors. `dist/index.js` and `dist/discord/bot.js` updated.

- [ ] **Step 4: Run the full test suite**

Run from `hub/`: `npm test`
Expected: All tests pass (rgb + existing router/config/state/triage tests).

- [ ] **Step 5: Commit**

```bash
git add hub/src/discord/bot.ts hub/src/index.ts
git commit -m "feat(hub): wire RgbStateManager into bot and startup"
```

---

## Verification

After all tasks are complete:

- [ ] Restart the service: `sudo systemctl restart ai-hub`
- [ ] Check logs for startup reset: `journalctl -u ai-hub -n 20` — should show no RGB errors
- [ ] Send a Discord message to trigger a chat workflow — lights should turn `#00AAFF`
- [ ] Wait for the response — lights should turn off
- [ ] Send two messages in quick succession — lights should stay blue until both replies are sent
