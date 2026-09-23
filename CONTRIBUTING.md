# Contributing

LEASH is a monorepo with three packages: `contracts/` (Foundry/Solidity), `backend/` (Node + TypeScript), and `web/` (Next.js). This is an evolving product, so the workflow favors small, verified, incremental changes.

## Local setup

```bash
git clone https://github.com/dmustapha/leash-0g.git
cd leash-0g
pnpm install
```

Copy the env templates and fill them in:

- `backend/.env.example` → `backend/.env`
- `web/.env.example` → `web/.env.local`

Contract addresses, RPC, and chain config are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## Build and test (gate before every push)

```bash
# contracts
cd contracts && forge build && forge test

# backend
cd backend && pnpm build && pnpm test

# web
cd web && pnpm build && pnpm test
```

A change is not ready to push until the relevant package builds and its tests pass. Add or update tests with any behavior change.

## Workflow

- **Branch and PR.** Work on a feature branch and open a pull request into `main`. Do not commit directly to `main` for non-trivial changes.
- **Never rewrite published history.** `main` is public and may be cloned; no force-pushes or history rewrites on it. Fix mistakes with a new commit.
- **Natural commit messages.** Describe what changed and why, like any developer would.
- **Keep secrets out.** Real keys never enter the repo. `.env` files are gitignored; only `.env.example` templates are tracked. The testnet ops/guardian keys are burnable and must never be replaced with a mainnet or funds-controlling key.

## Docs to keep current

- `README.md` is a living document: update the phase table and Status/Next as work ships.
- `CHANGELOG.md`: add an entry per meaningful release or phase.
- `SECURITY.md` / `LIMITATIONS.md`: update when the trust model or scope changes.
