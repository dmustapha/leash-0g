
## 2026-09-21 — Surface judgment calls at decision time, not at exit
During the Phase-3 build I made several in-build judgment calls (supervised-TTL restart
option, boundary-touched limit_hit semantics, M-01 remediation choice) and only recorded
them for the exit protocol. Dami's correction: even when the kickoff says "proceed by
default", NON-pre-decided judgment calls should be surfaced to him in one compact line at
the moment they're made (decision + why + how to reverse), so he can veto in real time —
not discover them in the results doc. Pre-decided items (S1–S13, spec lines) stay
no-ask.
