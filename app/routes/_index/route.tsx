import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, Link, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>AI Imageshoot</h1>
        <p className={styles.text}>Create better product images by simply describing what you want.</p>

        <p className={styles.standaloneCta}>
          <Link to="/signup" className={styles.primaryLink}>
            Start creating — no Shopify store required
          </Link>
          <span className={styles.standaloneSwitch}>
            Already have an account? <Link to="/login">Log in</Link>
          </span>
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Have a Shopify store? Connect it instead</span>
              <input className={styles.input} type="text" name="shop" placeholder="my-shop-domain.myshopify.com" />
            </label>
            <button className={styles.button} type="submit">
              Connect store
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Describe it.</strong> Upload a product photo or just write what you want — AI Imageshoot understands the intent.
          </li>
          <li>
            <strong>AI creates it.</strong> Real generation, grounded in your reference image, never a placeholder.
          </li>
          <li>
            <strong>Keep iterating.</strong> Every version is saved — refine the result in plain language until it&rsquo;s right.
          </li>
        </ul>
      </div>
    </div>
  );
}
