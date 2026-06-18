// web/src/api.ts — thin wrappers over the backend's REST endpoints.
const BACKEND = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3000";

async function asError(r: Response, fallback: string): Promise<never> {
  const body = await r.json().catch(() => ({}));
  throw new Error(body.error ?? fallback);
}

/** Sign in by handle (upsert). Returns the user's id. */
export async function login(handle: string): Promise<{ id: string; handle: string }> {
  const r = await fetch(`${BACKEND}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!r.ok) await asError(r, "login failed");
  return r.json();
}

/** The recording notice text + version the server gates on. */
export async function getConsentNotice(): Promise<{ version: string; text: string }> {
  const r = await fetch(`${BACKEND}/api/consent-notice`);
  if (!r.ok) await asError(r, "could not load consent notice");
  return r.json();
}

/** Record acceptance of the notice. Must succeed before joining the queue. */
export async function postConsent(userId: string, noticeVersion: string): Promise<void> {
  const r = await fetch(`${BACKEND}/api/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, noticeVersion }),
  });
  if (!r.ok) await asError(r, "could not record consent");
}
