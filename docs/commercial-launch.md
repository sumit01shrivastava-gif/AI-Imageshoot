# Commercial launch checklist

The end-to-end merchant journey this app is built for, a real production
smoke test to run once docs/production-deployment.md's infrastructure is
live, and what's left before Shopify App Store submission.

## The intended merchant journey

```
Shopify merchant
  → installs the app (OAuth) → embedded app loads, session established
  → opens a product → Analyze Product (Product Intelligence)
  → Generate product imagery (real AI call, queued → worker → result)
  → opens Creative Studio → sends a natural-language edit
      ("put it in a luxury bathroom") → real image-to-image edit
      → credits reserved → provider called → credits consumed
  → reviews the result → Approve
  → Publish → (today: honestly fails — write_products not requested;
      see docs/publishing.md)
```

Every step through "Approve" is real and working end-to-end once
docs/production-deployment.md's infrastructure is configured. Publish is
the one deliberately-incomplete step — see that document's "Known
limitations".

## Production smoke test

Run this AFTER every environment variable in docs/production-deployment.md
is set on both the web app and the worker, and both are deployed and
running. **This cannot be completed without those real credentials —
if you're reading this before they're configured, stop here and finish
docs/production-deployment.md first.**

1. Visit the live URL from a desktop browser — confirm it redirects
   into Shopify OAuth rather than showing an error.
2. Install (or open, if already installed) on a real or development
   store.
3. Confirm the embedded app loads inside Shopify admin, the nav renders,
   and Products lists the store's real catalog.
4. Open a real product → **Analyze Product** → confirm a
   Product Intelligence profile completes (READY status, identity
   anchors populated) — this is the deterministic-analysis-provider path
   still (no vision-capable `AIProvider` is configured in this pass; see
   docs/product-intelligence.md), so it stays fast and provider-free.
5. **Generate** product imagery → confirm the job reaches QUEUED, then
   PROCESSING, then SUCCEEDED — this is the first REAL OpenAI API call.
   Confirm a real image appears (not a placeholder/gray box).
6. Open **Creative Studio** from that product → confirm the credit
   balance shown matches `/app/billing`'s.
7. Send a natural-language edit instruction (e.g. "put it in a
   luxury bathroom") → confirm:
   - the credit cost is deducted from the visible balance after sending
   - the job queues and a NEW image-to-image result appears (visibly
     different background, same product)
   - `CreditReservation.status` for that job is `CONSUMED` (checkable
     via the database directly, or by confirming the balance dropped by
     exactly the expected amount — see docs/usage.md's cost table)
8. Approve the result.
9. Attempt Publish — confirm it fails with the expected, honest
   "publishing isn't enabled yet" message (see docs/publishing.md), NOT
   a silent fake success and NOT an unhandled crash.
10. Force a failure case: temporarily set an invalid `AI_PROVIDER_API_KEY`
    (or briefly rename the real one), retry a generation, confirm:
    - the merchant sees a plain, understandable error (not a raw
      OpenAI error body, not a stack trace)
    - the credit that was reserved for that attempt is refunded (visible
      balance returns to what it was before that attempt)
    - restore the real key afterward.
11. Visit `/app/billing` → confirm plan/credits/status all read
    correctly, and Upgrade redirects to Shopify's real hosted
    confirmation page (test-mode charge — see docs/billing.md "Test
    mode" — never a real charge outside `NODE_ENV=production` billing
    config).

If every step above passes, the real AI + billing + credit pipeline is
genuinely verified end-to-end against production infrastructure — not
just passing tests against mocked providers.

## What's left before Shopify App Store submission

- **`write_products` scope** — deliberately not requested; required
  before Publish can do anything but honestly fail. See
  docs/publishing.md and docs/production-deployment.md "Known
  limitations" for why this pass left it alone.
- **App Store listing assets** — screenshots, description, pricing
  page copy, support contact, privacy policy URL — none of this is
  code; it's created in the Partners dashboard's listing editor.
- **A final Partners billing configuration pass** — confirm the app's
  billing capability is turned on and the plan pricing in
  `services/billing/plans.ts` matches what you actually intend to
  charge (this pass's numbers — FREE/$19/$49/$149 — are a reasonable
  starting catalog, not a validated pricing decision).
- **Per-plan resolution enforcement** — output-count and batch-size ARE
  now enforced (see docs/billing.md "Known limitations"); resolution
  (`maxGenerationResolutionPx`) is still not.
- **A real vision-capable `AIProvider` for Product Intelligence**, if
  you want genuine semantic identity validation instead of the current
  honest "not yet possible" result — see
  docs/creative-studio.md "Identity preservation".
- **App Store review's own technical requirements** (GDPR webhooks,
  uninstall handling, etc.) are already implemented — see CLAUDE.md's
  "Shopify App Store readiness" history for what's already done.
