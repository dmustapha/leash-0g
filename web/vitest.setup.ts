// File: web/vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

// jsdom lacks WebCrypto; use Node's implementation.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}
