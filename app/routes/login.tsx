/**
 * Standalone login — deliberately at `/login`, not `/auth/login`, which is
 * Shopify's own OAuth entry point (app/routes/auth.login/route.tsx). Two
 * separate auth boundaries, two separate paths — see
 * lib/auth/standalone-session.server.ts's doc comment.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { signIn, InvalidCredentialsError } from "../../services/workspace/signup.server";
import { createUserSession, getWorkspaceContext } from "../../lib/auth/standalone-session.server";

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
    <div className="auth-page">
      <div className="auth-card">
        <p className="auth-brand">AI Imageshoot</p>
        <h1>Welcome back</h1>
        <p className="auth-sub">Log in to your workspace.</p>

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
      <style>{`
        .auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f7f8f6; font-family: "IBM Plex Sans", -apple-system, sans-serif; padding: 24px; }
        .auth-card { width: 100%; max-width: 380px; background: #fff; border: 1px solid #dde2de; border-radius: 12px; padding: 36px 32px; }
        .auth-brand { font-family: ui-monospace, monospace; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #c1531f; margin: 0 0 14px; }
        .auth-card h1 { font-size: 22px; margin: 0 0 8px; }
        .auth-sub { color: #5b655f; font-size: 14px; margin: 0 0 24px; }
        .auth-error { background: #f6e0df; color: #8a3030; border-radius: 6px; padding: 10px 14px; font-size: 13.5px; margin-bottom: 18px; }
        .auth-form { display: flex; flex-direction: column; gap: 16px; }
        .auth-form label { display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; font-weight: 600; }
        .auth-form input { font-size: 15px; padding: 10px 12px; border: 1px solid #d5dbd7; border-radius: 8px; font-family: inherit; }
        .auth-form input:focus { outline: 2px solid #c1531f; outline-offset: 1px; }
        .auth-form button { margin-top: 6px; background: #c1531f; color: #fff; border: none; border-radius: 8px; padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; }
        .auth-form button:disabled { opacity: .6; cursor: default; }
        .auth-switch { text-align: center; font-size: 13.5px; color: #5b655f; margin: 22px 0 0; }
        .auth-switch a { color: #c1531f; font-weight: 600; text-decoration: none; }
      `}</style>
    </div>
  );
}
