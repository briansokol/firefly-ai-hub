import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the rgb-client module so no real HTTP requests are made.
const mockSetRgb = vi.fn<(preset: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../src/rgb-client.js', () => ({
  setRgb: (...args: unknown[]) => mockSetRgb(...(args as [string])),
}));

import { RgbStateManager } from '../src/rgb.js';

beforeEach(() => {
  mockSetRgb.mockClear();
  mockSetRgb.mockResolvedValue(undefined);
});

describe('RgbStateManager', () => {
  describe('startProcessing()', () => {
    it('calls setRgb("processing") on first call (0→1)', () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      expect(mockSetRgb).toHaveBeenCalledOnce();
      expect(mockSetRgb).toHaveBeenCalledWith('processing');
    });

    it('does not call setRgb on second call (1→2)', () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      mockSetRgb.mockClear();
      mgr.startProcessing();
      expect(mockSetRgb).not.toHaveBeenCalled();
    });
  });

  describe('endProcessing()', () => {
    it('does not call setRgb when going from 2→1', () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      mgr.startProcessing();
      mockSetRgb.mockClear();
      mgr.endProcessing();
      expect(mockSetRgb).not.toHaveBeenCalled();
    });

    it('calls setRgb("off") when going from 1→0', () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      mockSetRgb.mockClear();
      mgr.endProcessing();
      expect(mockSetRgb).toHaveBeenCalledOnce();
      expect(mockSetRgb).toHaveBeenCalledWith('off');
    });

    it('does not decrement below 0 and logs an error', () => {
      const mgr = new RgbStateManager();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.endProcessing(); // already 0
      expect(mockSetRgb).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('endProcessing'));
      spy.mockRestore();
    });
  });

  describe('reset()', () => {
    it('calls setRgb("off") and resolves', async () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      mgr.startProcessing();
      mockSetRgb.mockClear();
      await mgr.reset();
      expect(mockSetRgb).toHaveBeenCalledOnce();
      expect(mockSetRgb).toHaveBeenCalledWith('off');
    });

    it('sets activeCount to 0 so a subsequent endProcessing logs error', async () => {
      const mgr = new RgbStateManager();
      mgr.startProcessing();
      await mgr.reset();
      mockSetRgb.mockClear();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.endProcessing(); // count is 0 after reset
      expect(mockSetRgb).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('resolves even if setRgb fails', async () => {
      const mgr = new RgbStateManager();
      mockSetRgb.mockRejectedValue(new Error('connection refused'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(mgr.reset()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
