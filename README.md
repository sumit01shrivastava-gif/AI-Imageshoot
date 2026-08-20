# AI ImageShoot

An AI Product Photography Studio for Shopify merchants — a Shopify
embedded app. See [CLAUDE.md](./CLAUDE.md) for the full architecture,
conventions, and current implementation status, and [docs/](./docs) for
per-domain detail (architecture, database, AI pipeline, Shopify
integration, generation pipeline, roadmap).

**Current phase:** Phase 0 — foundation only. No product feature is
implemented yet.

## Stack

Shopify App · React Router 7 · TypeScript · Polaris · App Bridge ·
Shopify Admin GraphQL API · PostgreSQL (Prisma) · Redis (BullMQ) ·
Vitest · Playwright

## Local development

```sh
cp .env.example .env        # fill in local values
docker compose up -d        # local Postgres (5433) + Redis (6380)
npm install
npm run setup                # prisma generate + migrate deploy
npm run dev                   # shopify app dev (requires `npm run config:link` first)
```

In a second terminal, once there are workers registered to run:

```sh
npm run worker
```

## Quality checks

```sh
npm run typecheck
npm run lint
npm test              # vitest — unit + integration
npm run test:e2e       # playwright
npm run build
```
