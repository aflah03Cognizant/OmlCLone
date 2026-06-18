// web/src/components/StartScreen.tsx
//
// Step 1: sign in with a handle (closed group, no passwords).
// Step 2: read the recording-consent notice and accept it. Accepting POSTs a
//         ConsentRecord (via the backend) — required before we'll queue you.
import { useEffect, useState, type FormEvent } from "react";
import { login, getConsentNotice, postConsent } from "../api";

type User = { id: string; handle: string };

export default function StartScreen({
  onReady,
  notice,
}: {
  onReady: (user: User) => void;
  notice: string | null;
}) {
  const [handle, setHandle] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [noticeText, setNoticeText] = useState("");
  const [noticeVersion, setNoticeVersion] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConsentNotice()
      .then((n) => {
        setNoticeText(n.text);
        setNoticeVersion(n.version);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function doLogin(e: FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setUser(await login(handle.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doJoin() {
    if (!user || !accepted) return;
    setBusy(true);
    setError(null);
    try {
      await postConsent(user.id, noticeVersion); // <-- writes the ConsentRecord
      onReady(user);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-gray-950 text-gray-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-gray-900 border border-gray-800 p-6 shadow-xl">
        <h1 className="text-xl font-semibold">Random Video Chat</h1>
        <p className="text-sm text-gray-400 mt-1">Closed learning setup · every call is recorded.</p>

        {(error || notice) && (
          <div className="mt-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm px-3 py-2">
            {error ?? notice}
          </div>
        )}

        {!user ? (
          // --- Step 1: handle ---
          <form onSubmit={doLogin} className="mt-5 space-y-3">
            <label className="block text-sm text-gray-300">Your handle</label>
            <input
              autoFocus
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. alice"
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={busy || !handle.trim()}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 font-medium"
            >
              {busy ? "…" : "Continue"}
            </button>
          </form>
        ) : (
          // --- Step 2: consent ---
          <div className="mt-5 space-y-4">
            <div className="text-sm text-gray-300">
              Signed in as <span className="font-semibold text-white">{user.handle}</span>
            </div>
            <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-3 text-sm text-gray-300 max-h-48 overflow-auto">
              <div className="font-semibold text-gray-100 mb-1">Recording notice ({noticeVersion})</div>
              {noticeText || "Loading…"}
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5"
              />
              <span>I understand and consent to being recorded.</span>
            </label>
            <button
              onClick={doJoin}
              disabled={busy || !accepted || !noticeVersion}
              className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 font-medium"
            >
              {busy ? "Joining…" : "Accept & find someone"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
