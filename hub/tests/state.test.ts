import { describe, it, expect, afterEach } from 'vitest';
import { createStateStore } from '../src/email/state.js';

// Use in-memory SQLite so tests leave no files on disk
const DB = ':memory:';

describe('createStateStore', () => {
  let store: ReturnType<typeof createStateStore>;

  afterEach(() => {
    store.close();
  });

  it('returns 0 for an account that has never been seen', () => {
    store = createStateStore(DB);
    expect(store.getLastUid('gmail')).toBe(0);
  });

  it('stores and retrieves a UID for an account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 42);
    expect(store.getLastUid('gmail')).toBe(42);
  });

  it('keeps UIDs isolated per account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 100);
    store.setLastUid('work', 200);
    expect(store.getLastUid('gmail')).toBe(100);
    expect(store.getLastUid('work')).toBe(200);
  });

  it('updates the UID when called again for the same account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 10);
    store.setLastUid('gmail', 99);
    expect(store.getLastUid('gmail')).toBe(99);
  });
});
