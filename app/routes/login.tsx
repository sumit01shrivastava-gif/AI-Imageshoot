/**
 * Standalone login — deliberately at `/login`, not `/auth/login`, which is
 * Shopify's own OAuth entry point (app/routes/auth.login/route.tsx). Two
 * separate auth boundaries, two separate paths — see
 * lib/auth/standalone-session.server.ts's doc comment.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { signIn, InvalidCredentialsError } from "../../services/workspace/signup.server";
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
  const existing = await getWorkspaceContext(request);
  if (existing) throw redirect("/studio");
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  try {
    const user = await signIn(email, password);
    const { setCookie } = await createUserSession(user.id);
    return redirect("/studio", { headers: { "Set-Cookie": setCookie } });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return { error: error.message };
    }
    return { error: "Something went wrong. Please try again." };
  }
};

export default function Login() {
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
        <h1>Welcome back</h1>
        <p className="auth-sub">Log in to keep creating.</p>

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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Logging in…" : "Log in"}
          </button>
        </Form>

        <p className="auth-switch">
          New here? <Link to="/signup">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
