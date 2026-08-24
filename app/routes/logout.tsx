import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { destroyUserSession } from "../../lib/auth/standalone-session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { setCookie } = await destroyUserSession(request);
  return redirect("/login", { headers: { "Set-Cookie": setCookie } });
};

// A bare GET /logout also logs out — convenient for a plain <a> link,
// and idempotent either way.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { setCookie } = await destroyUserSession(request);
  return redirect("/login", { headers: { "Set-Cookie": setCookie } });
};
