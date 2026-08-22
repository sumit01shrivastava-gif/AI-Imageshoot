import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

/**
 * Adds Vercel's official React Router build preset
 * (https://vercel.com/docs/frameworks/react-router#vercel-react-router-preset)
 * — ONLY when actually building on/for Vercel (`process.env.VERCEL` is
 * set by Vercel's own build system, both `vercel build` locally and a
 * real cloud build). Applying it unconditionally changes
 * `react-router build`'s server output path (nests it under a
 * runtime-specific subfolder), which would silently break this repo's
 * OTHER deployment path — `npm run start`
 * (`react-router-serve ./build/server/index.js`) and `docker-start` —
 * that every non-Vercel host (a Docker image, a plain Node host for the
 * worker's sibling web process, local `npm run build && npm start`
 * smoke-testing) still depends on. See docs/production-deployment.md
 * "Vercel deployment".
 *
 * No `ssr: false`/prerender config here — this app is fully
 * server-rendered per-request (every route needs a live, authenticated
 * Shopify session), never statically prerendered.
 */
export default {
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
