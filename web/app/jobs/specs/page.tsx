// File: web/app/jobs/specs/page.tsx
// Phase-4 create-flow (spec §7/F5): define the owner-seeded job a requester runs.
'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { OwnerJobSpec } from '@/lib/types';
import { JobSpecEditor } from '@/components/create/JobSpecEditor';

export default function JobSpecsPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const onSave = useCallback(
    async (sourceRef: string, spec: OwnerJobSpec) => {
      await api.putJobSpec(sourceRef, spec);
    },
    [api],
  );

  return (
    <main style={{ display: 'grid', gap: '1rem', maxWidth: 720, margin: '0 auto', padding: '1.5rem' }}>
      <header style={{ display: 'grid', gap: '0.25rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>Define a job</h1>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>
          Seed the work a requester agent will run. Point the requester&apos;s <code className="code">jobSpecSource</code>{' '}
          at the handle you save here. <Link href="/jobs">Back to jobs</Link>
        </p>
      </header>
      <JobSpecEditor onSave={onSave} />
    </main>
  );
}
