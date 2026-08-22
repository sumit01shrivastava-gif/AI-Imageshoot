# Production deployment

How this app is actually deployed to a live, real-world environment:
Vercel for the web app, a separate persistent host for the BullMQ
worker, a real Postgres, a real Redis, S3-compatible object storage, and
a real AI vendor. This document is the map from "code that works
locally against docker-compose" to "a live URL a merchant can install
and use."

## Current live status (as of this pass)

- **Vercel project**: `xentra1/ai-imageshoot`, linked to this repo's
  GitHub remote (`sumit01shrivastava-gif/AI-Imageshoot`), auto-deploys
  on push to `main` once GitHub integration is confirmed in the Vercel
  dashboard.
- **Live URL**: **https://ai-imageshoot.vercel.app**
- **Current state**: the build and deploy pipeline is fully working —
  Vercel correctly detects this as a React Router 7 app
  (`@vercel/react-router`'s `vercelPreset()`, applied only when
  `process.env.VERCEL` is set — see `react-router.config.ts`) and
  deploys successfully. **The app does NOT yet function** — every
  request 500s (`FUNCTION_INVOCATION_FAILED`) because none of the
  required backend services (Postgres, Redis, a real Shopify app, an AI
  vendor) are configured yet. This is expected and is exactly the
  point this document picks up from — see "What's required before the
  live URL actually works" below.
- Three non-secret env vars are already set on the Vercel project
  (Production environment): `NODE_ENV=production`,
  `SHOPIFY_SCOPES=read_products`, `SHOPIFY_APP_URL=https://ai-imageshoot.vercel.app`.
  Everything else below still needs to be added.

## Architecture: what runs where

This app is **two separate processes**, and they need two separate
production hosts:

1. **The web app** (`npm run start` → `react-router-serve`, or on
   Vercel, the `vercelPreset()`-wrapped Node.js Function) — handles
   every merchant-facing page, every Shopify webhook, and every
   route action (including the ones that CREATE a job — e.g. clicking
   "Generate"). Fast, short-lived requests only; this is what Vercel is
   good at.
2. **The worker** (`npm run worker:start` → `workers/index.ts`) —
   a long-running BullMQ consumer that actually calls the AI
   provider, processes images, and does everything slow. **This
   cannot run on Vercel.** Vercel Functions are request-scoped and
   time-limited; a BullMQ `Worker` needs a persistent process holding
   an open Redis connection indefinitely. Deploy this to a host that
   runs a real, always-on Node process — Railway, Render, Fly.io, or a
   plain VPS are all good fits; this repo doesn't include a specific
   worker-hosting integration since Turn 4's authenticated access only
   covers Vercel/GitHub (see "What I could not do myself" below) — pick
   whichever you already have an account with. The worker's start
   command is `npm run worker:start`; it needs the identical
   environment variables as the web app (see below) except `PORT`.

Both processes read the SAME `DATABASE_URL`/`REDIS_URL` — they're two
clients of the same Postgres/Redis, not two separate databases.

## What's required before the live URL actually works

In order, because several depend on the ones before them:

### 1. A real Shopify app (Partners/Dev Dashboard)

If you don't already have one: create an app in the
[Shopify Partners dashboard](https://partners.shopify.com/), or run
`npx shopify app config link` from this repo (needs an interactive
browser login this session doesn't have — run it yourself). You need:

- `SHOPIFY_API_KEY` — the app's Client ID
- `SHOPIFY_API_SECRET` — the app's Client secret
- Both are on the app's "Client credentials" page in the Partners
  dashboard, or in `shopify.app.toml` once `config link` has run.

Then, in the Partners dashboard (or by running `shopify app deploy` /
`shopify app config push` once the CLI is authenticated), point the
app's URLs at the live Vercel URL:

- **App URL**: `https://ai-imageshoot.vercel.app`
- **Allowed redirection URL(s)**: `https://ai-imageshoot.vercel.app/auth/callback`
- Webhook subscriptions are already declared in `shopify.app.toml`
  (`app/uninstalled`, `app/scopes_update`, `products/*`,
  `app_subscriptions/update`, the 3 GDPR compliance topics) — pushing
  the app config via the CLI or dashboard registers them against the
  live URL automatically; nothing else to configure by hand.
- Scope stays `read_products` (see `shopify.app.toml`'s
  `[access_scopes]`) — this pass deliberately did not add
  `write_products`; see docs/publishing.md "Required scope" for why,
  and this doc's "Known limitations" below.
- Billing: if you intend to use real (non-test) subscriptions, confirm
  the app's billing configuration in the Partners dashboard — see
  docs/billing.md "Test mode" for what changes between `NODE_ENV=production`
  and everything else.

### 2. Production Postgres

Any real, reachable PostgreSQL 15+ works — this app doesn't use any
Postgres-vendor-specific feature. Two straightforward options:

- **[Neon](https://neon.tech)** — serverless Postgres, generous free
  tier, integrates natively with Vercel (also installable as a Vercel
  Marketplace integration directly from your Vercel project's
  "Storage" tab, which auto-populates `DATABASE_URL` for you).
- **[Supabase](https://supabase.com)** — also a generous free tier,
  gives you a Postgres connection string directly.

Either way, you need one connection string:

```
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?schema=public&sslmode=require
```

Then run migrations against it (from your own machine, with
`DATABASE_URL` pointed at the real database):

```bash
DATABASE_URL="<your real connection string>" npx prisma migrate deploy
```

`npx prisma migrate deploy` is the correct command for production (never
`migrate dev` — see CLAUDE.md "Database rules"). It applies every
migration in `prisma/migrations/` in order; safe to re-run.

### 3. Production Redis

BullMQ needs real Redis (not Upstash's REST-only free tier — BullMQ
needs a genuine persistent TCP connection, which rules out
edge/serverless-only Redis products). Options:

- **[Upstash Redis](https://upstash.com)** in **TCP mode** (not their
  REST API) — also installable as a Vercel Marketplace integration.
  Confirm you're copying the `rediss://` (TLS) connection string, not
  the REST URL/token pair.
- **[Railway](https://railway.app)** or **[Render](https://render.com)**
  both offer a one-click managed Redis instance, convenient if you're
  already hosting the worker there.

```
REDIS_URL=rediss://default:<password>@<host>:<port>
```

### 4. Object storage (S3-compatible)

Already fully implemented — `lib/storage/s3-storage-provider.server.ts`
is real, working code, not a stub. Any S3-compatible vendor works:

- **[Cloudflare R2](https://developers.cloudflare.com/r2/)** —
  recommended: no egress fees, generous free tier, S3-compatible API.
  Create a bucket + an API token (R2 → Manage API Tokens), then:
  ```
  OBJECT_STORAGE_PROVIDER=s3
  OBJECT_STORAGE_BUCKET=<your-bucket-name>
  OBJECT_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
  OBJECT_STORAGE_ACCESS_KEY=<R2 access key id>
  OBJECT_STORAGE_SECRET_KEY=<R2 secret access key>
  OBJECT_STORAGE_REGION=auto
  ```
- **AWS S3** — omit `OBJECT_STORAGE_ENDPOINT` (resolved from region
  instead), set `OBJECT_STORAGE_REGION` to a real AWS region (e.g.
  `us-east-1`).

Until this is set, the app silently falls back to
`LocalFilesystemStorageProvider` — which writes to the LOCAL disk of
whichever process handles the request. **On Vercel this is fatal**:
Vercel Functions have ephemeral, per-invocation filesystems, so an
image "uploaded" by one request may already be gone by the time a
later request tries to read it. Real object storage is not optional
for this deployment target — set `OBJECT_STORAGE_PROVIDER=s3` before
generating anything for real.

### 5. The AI provider (OpenAI)

See docs/ai-pipeline.md "Provider selection" for the full reasoning.
Get an API key from https://platform.openai.com/api-keys (requires an
OpenAI account with billing set up — gpt-image-1 is a paid model, no
free tier):

```
AI_PROVIDER=openai
AI_PROVIDER_API_KEY=<your OpenAI API key, starts with sk-...>
```

No `AI_PROVIDER_BASE_URL` needed. Optional: `AI_IMAGE_GENERATION_MODEL`/
`AI_IMAGE_EDIT_MODEL` to override the default `gpt-image-1` for both.

### 6. A production `MEDIA_SIGNING_SECRET` (recommended, not strictly required)

Only matters if you're using `LocalFilesystemStorageProvider` (i.e.
`OBJECT_STORAGE_PROVIDER` unset) — irrelevant once S3-compatible storage
is configured, since that signs its own URLs. Set a random 32+ byte
value if you do end up needing it; otherwise skip.

## Adding these to Vercel

**Never** paste a real secret into a chat with an AI assistant, a commit,
or `.env.example`. Add each value directly, either via the dashboard
(Project → Settings → Environment Variables) or the CLI, run from your
own machine or this repo:

```bash
vercel env add DATABASE_URL production
vercel env add REDIS_URL production
vercel env add SHOPIFY_API_KEY production
vercel env add SHOPIFY_API_SECRET production
vercel env add AI_PROVIDER production        # value: openai
vercel env add AI_PROVIDER_API_KEY production
vercel env add OBJECT_STORAGE_PROVIDER production   # value: s3
vercel env add OBJECT_STORAGE_BUCKET production
vercel env add OBJECT_STORAGE_ENDPOINT production
vercel env add OBJECT_STORAGE_ACCESS_KEY production
vercel env add OBJECT_STORAGE_SECRET_KEY production
```

Each command prompts for the value interactively (or accepts it piped
via stdin) and stores it encrypted — safe. After adding them all,
redeploy:

```bash
vercel deploy --prod
```

(or just push to `main` — the project is connected to GitHub and will
auto-deploy).

## Deploying the worker

Pick a host (Railway/Render/Fly.io/a VPS). The common pattern:

1. Connect the same GitHub repo.
2. Build command: `npm install && npm run setup` (the `setup` script
   runs `prisma generate && prisma migrate deploy` — safe to run on
   every deploy, idempotent).
3. Start command: `npm run worker:start`.
4. Set the SAME environment variables as the Vercel project (the
   worker imports the same `services/shopify`/`services/publishing`
   modules the web app does, so it needs the full set —
   `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL`/
   `SHOPIFY_SCOPES`/`DATABASE_URL`/`REDIS_URL`/`AI_PROVIDER*`/
   `OBJECT_STORAGE_*` — everything above except `PORT`).

The worker has no HTTP surface of its own — it's a background consumer,
so most hosts' "web service" health-check expectations don't apply;
use whichever "background worker"/"job" service type your host offers,
if it distinguishes one.

## Verifying the deployment

Once every env var above is set on BOTH the web app and the worker,
and the worker is deployed and running:

1. Visit `https://ai-imageshoot.vercel.app` — should redirect into
   Shopify OAuth rather than 500ing.
2. Install the app on a real (or development) Shopify store.
3. Follow the real end-to-end smoke test in docs/commercial-launch.md
   "Production smoke test".

## Known limitations

- **`write_products` (Shopify product-media publishing) is still not
  requested.** This pass's instructions conditionally authorized adding
  it, but CLAUDE.md documents this as a deliberate, repeatedly
  -reaffirmed decision precisely BECAUSE it forces every already
  -installed merchant to re-consent — a real, semi-irreversible,
  merchant-facing change. Flipping it now, with no live merchant install
  available to verify the publish flow actually works end-to-end
  afterward, would be adding an unverified change to the single most
  sensitive scope boundary in this app. Left unchanged; see
  docs/publishing.md "Required scope" for the exact mutation this
  unlocks once you're ready to make that call deliberately.
- **No infrastructure was provisioned on your behalf beyond the Vercel
  project itself** (Postgres/Redis/S3/OpenAI/a worker host) — every
  marketplace integration Vercel offers for these (Neon, Upstash, Vercel
  Blob) requires interactive human confirmation
  (`vercel integration add`/`accept-terms` explicitly refuse to run
  non-interactively) and/or has billing implications on your account, so
  none were added without you present. See "What's required" above for
  exact sign-up links and env var names.
- **The worker host is unspecified** — this repo has no
  Railway/Render/Fly config file checked in, since no such account was
  available to configure against. Any host that runs a persistent
  Node process works; add a platform-specific config file (e.g.
  `railway.json`, a `render.yaml`) once you've picked one, if your host
  wants one (many detect `npm run worker:start` from `package.json`
  with zero extra config).
