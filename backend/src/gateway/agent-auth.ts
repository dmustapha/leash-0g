import type { Pool } from 'pg';
import { parseGatewayToken, verifyTokenSecret } from '../crypto/token.js';
import { getAgentByTokenId } from '../store/agents.js';
import type { AgentRow } from '../types.js';

export type AgentAuthResult = { ok: true; agent: AgentRow } | { ok: false; status: 401 | 403 };

/**
 * Gateway auth (M-01): identity derives ONLY from the bearer token — the
 * x-leash-agent header is never consulted. tokenId gives O(1) lookup; the
 * secret is checked against the argon2id hash at rest. A revoked agent's
 * token authenticates but is refused (403) — revoke fan-out layer 3.
 */
export async function authenticateAgent(pool: Pool, authorizationHeader: string | undefined): Promise<AgentAuthResult> {
  const raw = /^Bearer (.+)$/.exec(authorizationHeader ?? '')?.[1];
  if (!raw) return { ok: false, status: 401 };
  const parsed = parseGatewayToken(raw);
  if (!parsed) return { ok: false, status: 401 };
  const agent = await getAgentByTokenId(pool, parsed.tokenId);
  if (!agent) return { ok: false, status: 401 };
  if (!(await verifyTokenSecret(agent.tokenHash, parsed.secret))) return { ok: false, status: 401 };
  if (agent.status !== 'active') return { ok: false, status: 403 };
  return { ok: true, agent };
}
