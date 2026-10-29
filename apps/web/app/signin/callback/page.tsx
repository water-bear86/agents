"use client";
import { useEffect, useState } from "react";
import { Empty } from "../../../lib/ui";
import { finishSignIn } from "../../../lib/session";

/** Where the town's sign-in page sends you back: trade the code for the agent's tokens, then move on. */
export default function SignInCallback() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    finishSignIn(new URLSearchParams(window.location.search))
      .then(({ handle, back }) => window.location.replace(`${back}${back.includes("?") ? "&" : "?"}signed_in=${encodeURIComponent(handle)}`))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <Empty title="Couldn't sign you in.">{error} <a href="/me">Back to My agents</a></Empty>;
  return <p className="muted" role="status">Signing you in…</p>;
}
