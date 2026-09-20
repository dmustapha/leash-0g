// File: web/next.config.ts
// Phase-1 minimal FE. Monorepo member: file tracing pinned to the repo root —
// but NOT on Vercel, where the project root already IS web/ and an explicit
// parent root doubles the path (`path0/path0`) and breaks the build.
import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  ...(process.env.VERCEL ? {} : { outputFileTracingRoot: path.join(__dirname, '..') }),
};

export default config;
