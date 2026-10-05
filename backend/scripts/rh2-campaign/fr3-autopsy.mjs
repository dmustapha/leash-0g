import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
const ownerA = privateKeyToAccount(readFileSync(new URL('./state/owner-a.key', import.meta.url), 'utf8').trim());
const { privyLogin, makeApi } = await import('./common.mjs');
const api = makeApi(await privyLogin(ownerA), 'https://leash-0g-backend-rh2.onrender.com');
const AGENT = 'ae179544-3995-46c2-b61a-46c6ff8e1282';
let cursor = -1;
while (true) {
  const r = await api(`/api/agents/${AGENT}/traces?limit=200&cursor=${cursor}`);
  const rows = r.body.records ?? [];
  if (rows.length === 0) break;
  for (const t of rows) {
    cursor = Math.max(cursor, t.seq);
    if (t.kind === 'action' || (t.kind === 'decision' && !/not a valid decision/.test(JSON.stringify(t.detail)))) {
      console.log((t.ts ?? '').slice(11, 19), 'seq', t.seq, t.kind, JSON.stringify(t.detail).slice(0, 200));
    }
  }
  if (r.body.nextCursor == null) break;
}
