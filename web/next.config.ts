// File: web/next.config.ts
// Phase-1 minimal FE. Monorepo member: file tracing pinned to the repo root.
import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '..'),
};

export default config;
