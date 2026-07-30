// One fetch layer for every screen. The part that matters: a 401 means the
// wallet sealed itself (idle timeout, server restart, expired session), and
// before this existed each screen just showed raw errors forever while the
// user looked signed in. Now any 401 signs out cleanly and says why.

export const NOTICE_KEY = "zaim_notice";

function headers() {
  const t = localStorage.getItem("zaim_token");
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

async function handle(r) {
  if (r.status === 401 && localStorage.getItem("zaim_token")) {
    localStorage.removeItem("zaim_token");
    try {
      const d = await r.json();
      localStorage.setItem(NOTICE_KEY, d.detail || "Your wallet sealed itself. Enter your seed to open it again.");
    } catch (e) {
      localStorage.setItem(NOTICE_KEY, "Your wallet sealed itself. Enter your seed to open it again.");
    }
    location.reload();
    throw new Error("Signed out");
  }
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail || "Failed");
  return d;
}

export const apiGet = (p) => fetch(`/api${p}`, { headers: headers() }).then(handle);
export const apiPost = (p, b) => fetch(`/api${p}`, { method: "POST", headers: headers(), body: JSON.stringify(b) }).then(handle);

// Read-and-clear the sign-out notice for the auth screen.
export function takeNotice() {
  const n = localStorage.getItem(NOTICE_KEY) || "";
  localStorage.removeItem(NOTICE_KEY);
  return n;
}
