export type ApprovalDecision = { decision: 'approve' | 'deny'; reason?: string };

interface Waiter {
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * In-memory rendezvous between a held gateway request (or a paused runtime)
 * and the owner's decision. The DURABLE state lives in the approvals table;
 * the broker only wakes the waiting request. A decision that arrives with no
 * waiter (e.g. after restart) is still durable in Postgres — the held request
 * has timed out by then and the agent retries.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();

  wait(approvalId: string, timeoutMs: number): Promise<ApprovalDecision | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        resolve('timeout');
      }, timeoutMs);
      this.waiters.set(approvalId, {
        resolve: (d) => {
          clearTimeout(timer);
          this.waiters.delete(approvalId);
          resolve(d);
        },
        timer,
      });
    });
  }

  notify(approvalId: string, decision: ApprovalDecision): boolean {
    const waiter = this.waiters.get(approvalId);
    if (!waiter) return false;
    waiter.resolve(decision);
    return true;
  }

  cancelAll(): void {
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({ decision: 'deny', reason: 'shutdown' });
    }
    this.waiters.clear();
  }
}
