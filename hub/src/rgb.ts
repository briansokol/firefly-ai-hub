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
