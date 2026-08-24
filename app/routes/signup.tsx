/**
 * Standalone sign-up — the entry point into the non-Shopify product
 * experience. See services/workspace/signup.server.ts and
 * lib/auth/standalone-session.server.ts.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { signUp, EmailAlreadyRegisteredError, WeakPasswordError } from "../../services/workspace/signup.server";
import { createUserSession, getWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { Logo } from "../components/logo";
import studioStylesHref from "../styles/studio.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" },
  { rel: "stylesheet", href: studioStylesHref },
  { rel: "icon", type: "image/svg+xml", href: "/favicon-studio.svg" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Already signed in — no reason to see the signup form again.
  const existing = await getWorkspaceContext(request);
  if (existing) throw redirect("/studio");
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }

  try {
    const { user } = await signUp(email, password);
    const { setCookie } = await createUserSession(user.id);
    return redirect("/studio", { headers: { "Set-Cookie": setCookie } });
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError || error instanceof WeakPasswordError) {
      return { error: error.message };
    }
    return { error: "Something went wrong creating your account. Please try again." };
  }
};

export default function SignUp() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="studio-root auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <Logo variant="full" size={19} />
        </div>
        <h1>Create your workspace</h1>
        <p className="auth-sub">Describe what you want — AI Imageshoot creates it. No Shopify store required.</p>

        {actionData?.error && <div className="auth-error">{actionData.error}</div>}

        <Form method="post" className="auth-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              name="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="auth-hint">At least 8 characters.</span>
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating your workspace…" : "Create account"}
          </button>
        </Form>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </div>
    </div>
  );
}
