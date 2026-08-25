/**
 * The standalone product's landing page — also Shopify's own OAuth entry
 * point (a `shop` query param redirects straight to `/app` below,
 * unchanged from before this pass). AI Imageshoot is a standalone
 * product first: the primary calls to action are "Start creating"/"Log
 * in"; the Shopify "connect your store" path is a real, fully
 * functional secondary path, not the page's dominant message. See
 * app/styles/landing.css's module doc comment for the token system this
 * page is built on (shared with /login, /signup, /studio — never
 * app/styles/global.css's Shopify-embedded tokens).
 *
 * The gallery/before-after panels below are deliberately abstract
 * geometric placeholders, not fabricated "AI-generated" photos or fake
 * customer content — CLAUDE.md/this phase's own instructions rule out
 * presenting placeholder content as if it were real generated output.
 */
import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { redirect, Form, Link, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { Logo } from "../../components/logo";
import studioStylesHref from "../../styles/studio.css?url";
import landingStylesHref from "../../styles/landing.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" },
  { rel: "stylesheet", href: studioStylesHref },
  { rel: "stylesheet", href: landingStylesHref },
  { rel: "icon", type: "image/svg+xml", href: "/favicon-studio.svg" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showShopifyForm: Boolean(login) };
};

const GALLERY_ITEMS = [
  { tone: "1", label: "Studio product shot" },
  { tone: "2", label: "Lifestyle campaign" },
  { tone: "3", label: "Website hero banner" },
  { tone: "4", label: "Social campaign, 4:5" },
];

const FEATURES = [
  {
    title: "Describe it",
    body: "Type what you want, or start from a product photo — a premium studio shot, a lifestyle scene, a campaign banner.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 8h12M2 4h8M2 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Imageshoot creates it",
    body: "Real generation grounded in your reference image and direction — never a placeholder, never a stock photo swap.",
    icon: <Logo variant="mark" size={18} />,
  },
  {
    title: "Keep refining",
    body: "“Make the lighting warmer.” “Now make it 4:5.” Every version is saved, so you can always go back.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8a5 5 0 0 1 8.5-3.5M13 8a5 5 0 0 1-8.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M11.5 2.5v2h-2M4.5 13.5v-2h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function Landing() {
  const { showShopifyForm } = useLoaderData<typeof loader>();

  return (
    <div className="landing">
      <nav className="landing-nav">
        <Logo variant="full" size={20} />
        <div className="landing-nav-links">
          <a href="#shopify">Have a Shopify store?</a>
          <Link to="/login">Log in</Link>
          <Link to="/signup" className="landing-nav-cta">
            Start creating
          </Link>
        </div>
      </nav>

      <header className="landing-hero">
        <p className="landing-eyebrow">AI Imageshoot</p>
        <h1>Create the image you have in mind.</h1>
        <p className="landing-hero-sub">
          Describe a product shoot, upload a reference, or simply tell AI what you want. Imageshoot turns the direction into
          production-ready creative.
        </p>
        <div className="landing-hero-actions">
          <Link to="/signup" className="landing-btn" data-variant="primary">
            Start creating
          </Link>
          <Link to="/login" className="landing-btn" data-variant="secondary">
            Log in
          </Link>
        </div>
        <p className="landing-hero-note">
          Have a Shopify store? <a href="#shopify">Connect your store</a>
        </p>
      </header>

      <section className="landing-section" aria-label="Example creative directions">
        <div className="landing-gallery">
          {GALLERY_ITEMS.map((item) => (
            <div key={item.label} className="landing-gallery-card" data-tone={item.tone}>
              <svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d="M4 13V5C4 4.44772 4.44772 4 5 4H13" stroke="#f4f4f3" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M28 19V27C28 27.5523 27.5523 28 27 28H19" stroke="#f4f4f3" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="13" y="13" width="6" height="6" rx="1.25" fill="#f4f4f3" />
              </svg>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" data-tint="true">
        <div className="landing-section-inner">
          <div className="landing-section-head" data-center="true">
            <p className="landing-section-eyebrow">How it works</p>
            <h2>Describe it. Imageshoot creates it.</h2>
            <p>No prompt-engineering, no design software. Just tell it what you want.</p>
          </div>
          <div className="landing-feature-grid">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="landing-feature">
                <div className="landing-feature-icon">{feature.icon}</div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head" data-center="true">
          <p className="landing-section-eyebrow">Reference image</p>
          <h2>Start from a photo you already have.</h2>
          <p>Upload a product photo and describe the direction — Imageshoot keeps your product intact while transforming the scene.</p>
        </div>
        <div className="landing-transform">
          <div className="landing-transform-panel" data-kind="before">
            <span className="landing-transform-label">Your reference</span>
            <span className="landing-transform-caption">A plain product photo</span>
          </div>
          <div className="landing-transform-arrow" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="landing-transform-panel" data-kind="after">
            <span className="landing-transform-label">Generated</span>
            <span className="landing-transform-caption">A premium studio campaign, same product</span>
          </div>
        </div>
      </section>

      <section className="landing-section" data-tint="true">
        <div className="landing-section-inner">
          <div className="landing-section-head" data-center="true">
            <p className="landing-section-eyebrow">Conversational</p>
            <h2>Refine it by saying what you want changed.</h2>
            <p>Every version stays available, so refining never means starting over.</p>
          </div>
          <div className="landing-chat-mock">
            <div className="landing-chat-bubble" data-role="user">
              Create a premium campaign for this running shoe — dark luxury studio, dramatic lighting.
            </div>
            <div className="landing-chat-bubble" data-role="ai">
              Got it — I&rsquo;ll keep the shoe as the hero and build a dark luxury studio environment.
            </div>
            <div className="landing-chat-bubble" data-role="user">
              Make the lighting warmer, and now make it 4:5 for Instagram.
            </div>
            <div className="landing-chat-bubble" data-role="ai">Creating the updated version…</div>
          </div>
        </div>
      </section>

      <section className="landing-section" id="shopify">
        <div className="landing-shopify">
          <div>
            <p className="landing-section-eyebrow">For Shopify merchants</p>
            <h2 style={{ fontFamily: "var(--studio-font-display)", fontSize: "clamp(22px, 3vw, 30px)", fontWeight: 500, margin: "0 0 12px" }}>
              Already selling on Shopify?
            </h2>
            <p style={{ color: "var(--studio-ink-subdued)", fontSize: 15, lineHeight: 1.65, margin: 0 }}>
              Connect your store to ground generation in your real product catalog — titles, images, and descriptions Imageshoot
              already understands.
            </p>
            {showShopifyForm && (
              <Form className="landing-shopify-form" method="post" action="/auth/login">
                <label htmlFor="shop-domain" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
                  Shop domain
                </label>
                <input id="shop-domain" type="text" name="shop" placeholder="my-shop-domain.myshopify.com" />
                <button type="submit">Connect store</button>
              </Form>
            )}
          </div>
          <div className="landing-shopify-visual" aria-hidden="true">
            <Logo variant="mark" size={40} />
          </div>
        </div>
      </section>

      <section className="landing-final">
        <h2>Create the image you have in mind.</h2>
        <p>No design software. No prompt engineering. Just describe it.</p>
        <div className="landing-hero-actions">
          <Link to="/signup" className="landing-btn" data-variant="primary">
            Start creating
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <span>AI Imageshoot</span>
        <span>
          <Link to="/login">Log in</Link>
        </span>
      </footer>
    </div>
  );
}
