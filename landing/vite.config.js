import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Static multi-page export: / (FINAL landing), /proposals/ (round-2 picker), /v1..v4/ (reference).
// Round-1 (a/b/c) lives in _archive-round1/ and is NOT built.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        proposals: resolve(import.meta.dirname, 'proposals/index.html'),
        v1: resolve(import.meta.dirname, 'v1/index.html'),
        v2: resolve(import.meta.dirname, 'v2/index.html'),
        v3: resolve(import.meta.dirname, 'v3/index.html'),
        v4: resolve(import.meta.dirname, 'v4/index.html'),
      },
    },
  },
})
