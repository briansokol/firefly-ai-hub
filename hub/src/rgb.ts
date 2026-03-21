import { setRgb } from './rgb-client.js';

export class RgbStateManager {
  private activeCount = 0;

  startProcessing(): void {
    this.activeCount++;
    if (this.activeCount === 1) {
      setRgb('processing').catch((err) => {
        console.error('RgbStateManager: setRgb error:', err);
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
      setRgb('off').catch((err) => {
        console.error('RgbStateManager: setRgb error:', err);
      });
    }
  }

  async reset(): Promise<void> {
    this.activeCount = 0;
    try {
      await setRgb('off');
    } catch (err) {
      console.error('RgbStateManager: setRgb error:', err);
    }
  }
}
