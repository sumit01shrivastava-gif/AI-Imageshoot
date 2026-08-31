/**
 * Local visual QA only. This is deliberately outside the authenticated
 * `/studio/*` route tree so it can render without a database or a user
 * session during development. The loader hard-404s in production; it never
 * reads, writes or impersonates merchant data and uses no provider or queue.
 */
import type { LinksFunction } from "react-router";
import { StudioGenerationLoading } from "../components/studio-generation-loading";
import { isStudioFixtureEnabled } from "../components/studio-fixture-mode";
import studioStylesHref from "../styles/studio.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: studioStylesHref }];

export const loader = () => {
  if (!isStudioFixtureEnabled()) throw new Response("Not found", { status: 404 });
  return null;
};

const fixtureImage = "/ai-imageshoot-editorial-hero.png";

export default function StudioFixture() {
  return (
    <div className="studio-root studio-shell studio-fixture" data-testid="studio-fixture">
      <main className="studio-main">
        <div className="studio-conv">
          <section className="studio-chat">
            <header className="studio-chat-header"><span className="studio-credit-pill">Fixture preview · no generation will run</span></header>
            <div className="studio-transcript">
              <div className="studio-turn" data-role="USER">
                <div className="studio-msg" data-role="USER">
                  <div className="studio-message-attachments"><span className="studio-message-attachment"><img src={fixtureImage} alt="Fixture product reference" /></span></div>
                  <div className="studio-message-content">Create an exceptional campaign image. Keep the product exact and give it a distinct visual world.</div>
                </div>
              </div>
              <div className="studio-turn" data-role="ASSISTANT">
                <div className="studio-msg" data-role="ASSISTANT">I’ll preserve the product and build the campaign around its character.</div>
                <div className="studio-turn-generation" data-loading="true"><StudioGenerationLoading stage="GENERATING" /></div>
              </div>
              <div className="studio-turn" data-role="ASSISTANT">
                <div className="studio-turn-generation"><img className="studio-turn-result" src={fixtureImage} alt="Fixture generated campaign" /></div>
                <p className="studio-result-quality-check"><span className="studio-dot-pulse" />Checking final details…</p>
                <div className="studio-turn-result-actions"><button type="button" className="studio-btn" data-variant="primary">Download</button><button type="button" className="studio-btn">Edit / Continue</button></div>
              </div>
              <div className="studio-turn" data-role="ASSISTANT">
                <div className="studio-turn-error" role="status">This generation could not be completed. Your request is still here—try again when you’re ready.</div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
