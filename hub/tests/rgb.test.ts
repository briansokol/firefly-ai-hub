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
