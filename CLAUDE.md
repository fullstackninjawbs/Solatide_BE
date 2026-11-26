# Solatide — Server (backend)

Local working notes for AI assistants. **Not committed** (in `.gitignore`).
Sister repo: `../Client` (storefront + admin hub). Both are released together with one version.

## Project
- Australian research-peptide store, **solatidebiosciences.com.au**; admin hub on a separate host.
- Client contact: **Gracie** (non-technical). Messages to her: plain language, no code terms.
- Live checkout mode: **Order Request** (customer submits a request; admin creates the order and
  sends PayID/bank details). Bank transfer / PayID checkout also exists. TagadaPay is removed.
- Analytics milestones: M1 + M2 live; M3 (visitor panel) built on `feat/analytics-m3`, not
  live; M4 = dashboard + accurate Abandoned checkouts card; M5 dropped; M6 = consistency.
- Feature ideas: `../NEW_FEATURE_ROADMAP.md`. Release history: `CHANGELOG.md`.

## Stack
Node 22 + TypeScript, Express, Mongoose (MongoDB), BullMQ + Redis (queues, pub/sub, cache,
rate limits), PM2 cluster behind Nginx. Email via Brevo SMTP (nodemailer). Starshipit for shipping
labels/tracking. Cloudinary for images/COAs. DB-IP Lite `.mmdb` for visitor location.

Key places:
- `src/controllers/admin/*` admin API (all behind `protect` + staff roles, `src/config/roles.ts`)
- `src/services/orders/*` stock (atomic `$inc`, reservations), paid side effects, refunds
- `src/services/shipping/*` Starshipit, tracking, duplicate-label detection
- `src/services/analytics/*` tracking ingest (`collect.ts`), live view (`live/*`, SSE + Redis pub/sub)
- `src/queues/*` BullMQ queues, workers, cron schedules (`SCHEDULES` in `workers.ts`)
- `src/utils/storefrontRebuildHooks.ts` + `rebuildStorefront.ts` prebuilt-storefront rebuilds

## Hard rules
- **Never connect to production or DEV databases.** Tests and e2e use only the throwaway Docker
  containers: Mongo `127.0.0.1:27018` db `solatide_smoke`, Redis `127.0.0.1:6380`
  (`docker start solatide-test-mongo solatide-test-redis`).
- **Never git commit, push, tag, merge or rebase.** The user does all of that. Create a branch
  only when asked. No AI/co-author attribution anywhere.
- Ports **5000 / 5173** are the user's own dev servers — don't use or kill them. Test servers use
  5096–5099 (API) and 5175 / 5176 (storefront / admin).
- No destructive commands or scripts: no `rm -rf`, drops, truncates, bulk deletes, deleting
  admin/DB records, `git reset --hard`, force pushes.
- Don't change DNS, Nginx, Cloudflare, payment settings, secrets or production files without
  explicit approval. Commands for the live server must be **read-only** and say so; load `.env`
  with `node -r dotenv/config`, never `source .env` in bash.
- Never print, copy or send secrets, tokens, passwords or customer personal data.
- "Don't break the current flow": additions must leave existing behaviour unchanged unless the
  change is the point. Say explicitly what changes for users.

## Working style the user expects
- **Verify before claiming.** Confirm bugs in the code/logs; label anything not checked as
  *unverified*. Investigate from facts (logs are UTC; Melbourne is UTC+11).
- For bugs: explain the root cause with evidence first, then fix, then prove it (a test that
  reproduces it + regression suites).
- Report outcomes honestly: test counts, what was skipped, what can't be fixed.
- Keep explanations in plain English; give client messages ready to paste.
- After finishing a change, add it under **[Unreleased]** in `CHANGELOG.md` **and** in
  `../Client/CHANGELOG.md` (keep both identical). SemVer: patch = fix, minor = feature.

## Commands
```bash
npm test                 # unit tests (node:test, models stubbed; ~150 tests)
npx tsc --noEmit         # typecheck
npm run build            # dist/
npm run dev              # local dev server (user's, port 5000)
```
- Tests stub Mongoose statics (`tests/helpers/setup.ts`); mongoose buffering is off, so an
  un-stubbed query fails fast. Never point tests at a real DB.
- E2E: start a throwaway test API (env pointing at the Docker containers above, `NODE_ENV=production`,
  `STOREFRONT_AUTO_REBUILD=false`, blank SMTP/Starshipit keys, Starshipit simulated) and drive it
  with scripts kept in the scratchpad, not the repo.

## Conventions
- Comments explain **why**, in plain sentences; keep existing comment style.
- Money: `src/domain/money.ts`; payment status changes only via `transitionPaymentStatus`
  (forward-only); stock writes from orders use the `STOCK_ONLY` option (no rebuild storm).
- Background side effects never throw into the request path (log + continue).
- Admin routes need a role check from `ACCESS` in `src/config/roles.ts`.
- Version: `package.json` (`src/config/version.ts`), staff endpoint `GET /api/admin/version`.
