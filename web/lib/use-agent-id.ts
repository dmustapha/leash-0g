// File: web/lib/use-agent-id.ts
// Phase 1 has ONE agent and no list endpoint — remember the last created agent locally so the
// nav and home page can route back to its cockpit.
'use client';

import { useCallback, useEffect, useState } from 'react';

const KEY = 'leash.agentId';

export function useAgentId(): { agentId: string | null; setAgentId: (id: string) => void } {
  const [agentId, setState] = useState<string | null>(null);

  useEffect(() => {
    try {
      setState(window.localStorage.getItem(KEY));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const setAgentId = useCallback((id: string) => {
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* storage unavailable */
    }
    setState(id);
  }, []);

  return { agentId, setAgentId };
}
