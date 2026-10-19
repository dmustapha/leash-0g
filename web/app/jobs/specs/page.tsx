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

  // G-2.3b: the shell topbar owns the "Jobs" title; `.ops-view` scopes the OPERATE styles.
  return (
    <div className="ops-view">
      <p className="section-title">
        Define a job · <span className="n">owner-seeded spec</span>
      </p>
      <p className="lede">
        Seed the work a requester agent will run. Point the requester&apos;s <code>jobSpecSource</code> at the handle
        you save here. <span className="hash"><Link href="/jobs">Back to jobs</Link></span>
      </p>
      <JobSpecEditor onSave={onSave} />
    </div>
  );
}
