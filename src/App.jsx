import ZAIMGeoVault from "./GeoVault.jsx";
import ZaimSwap from "./Swap.jsx";
import { useState, useEffect, useRef, useCallback } from "react";
import AdminDashboard from "./AdminDashboard";
import FeaturesScreen from "./Features.jsx";
import { T, F, MAXPAIN_CSS } from "./styles/maxpain.js";
import { apiGet, apiPost, takeNotice } from "./api.js";
import AiTab from "./AiTab.jsx";
import { deriveAiMnemonic, deriveStoreKey } from "./ai/derive.js";
import { QRCodeSVG } from "qrcode.react";

// four geometric primitives for the bottom nav (icon always white)
const Prim = {
  square: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" fill={c} /></svg>,
  triangle: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M5 8h14l-7 10z" fill={c} /></svg>,
  circle: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill={c} /></svg>,
  diamond: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M12 4l8 8-8 8-8-8z" fill={c} /></svg>,
  slash: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M15 4L9 20" stroke={c} strokeWidth="3" strokeLinecap="round" /></svg>,
};

const API = {
  token: () => localStorage.getItem("zaim_token"),
  post: apiPost,
  get: apiGet,
  createWallet: () => API.post("/wallet/create", {}),
  openWallet: (seed, birthday) => API.post("/wallet/open", { seed_phrase: seed, birthday: birthday || 0 }),
  logout: () => API.post("/wallet/logout", {}),
  getBalance: () => API.get("/wallet/balance"),
  getAddress: () => API.get("/wallet/address"),
  sendPayment: (to, amt, memo) => API.post("/wallet/send", { to_address: to, amount: amt, memo }),
  sendMessage: (to, msg) => API.post("/message/send", { to_address: to, message: msg }),
  getMessages: () => API.get("/messages"),
  getTransactions: () => API.get("/wallet/transactions"),
  health: () => API.get("/health"),
  getPrice: () => API.get("/price"),
  getSeed: () => API.get("/wallet/seed"),
  nodeInfo: () => API.get("/node/info"),
  createRequest: (amount, memo) => API.post("/request/create", { amount, memo }),
  listRequests: () => API.get("/request/list"),
  syncPush: (contacts) => API.post("/sync/push", { contacts }),
  syncPull: () => API.get("/sync/pull"),
  fees: () => API.get("/fees"),
  listServers: () => API.get("/servers"),
  getServer: () => API.get("/settings/server"),
  setServer: (server) => API.post("/settings/server", { server }),
};

// ZIP-321 parser for the Send screen: paste a zcash: link from any wallet and
// the fields fill themselves. Memo arrives base64url encoded per the spec.
function parseZcashUri(s) {
  if (!s || !s.toLowerCase().startsWith("zcash:")) return null;
  const rest = s.slice(6);
  const [addr, query] = rest.split("?");
  if (!addr) return null;
  const out = { to: addr, amount: "", memo: "" };
  if (query) {
    for (const kv of query.split("&")) {
      const [k, v] = kv.split("=");
      if (k === "amount" && v) out.amount = v;
      if (k === "memo" && v) {
        try {
          const b64 = v.replace(/-/g, "+").replace(/_/g, "/");
          out.memo = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
        } catch (e) { }
      }
    }
  }
  return out;
}

// Dev log shown on the sign in screen. ZAIM entries only. Newest first.
// The status bar shows the first sentence of the newest entry.
const ZAIM_LOG = [
  { d: "Sep 16 2026", v: "0.10.0", t: "An AI tab, in preview. Ask a question and it is sealed on your device, sent from a separate AI account with its own seed, and answered inside a shielded memo only your browser can open. The relay and the AI provider read the question and never learn who asked. Our own server carries bytes it cannot read. Replies are padded to a fixed size and sent in batches with decoy traffic, so nothing on chain links a question to its answer." },
  { d: "Sep 15 2026", v: "0.9.4", t: "Security pass, and a Tor address. ZAIM now answers at a .onion, so you can reach it without your request crossing the open internet. Added a content security policy, a limit on sign in attempts, core dumps switched off, and a plain statement on the Features screen of exactly what our server can and cannot see. Also fixed a fault that had quietly served the site as a download instead of a page since August 21." },
  { d: "Aug 21 2026", v: "0.9.3", t: "New home. ZAIM moved to zaimwallet.com on a machine we run, with certificates that renew themselves. Sessions and wallets carried over untouched." },
  { d: "Jul 30 2026", v: "0.9.2", t: "Payment requests and chain synced contacts. Create a request any Zcash wallet can pay, with a fresh address every time so invoices cannot be linked. And your contact book can now follow your seed: encrypted memos written to yourself on the chain itself. New device, same seed, your people are there. No server copy, ever." },
  { d: "Jul 30 2026", v: "0.9.1", t: "Privacy and honesty pass. Fonts now load from our own server, so opening ZAIM tells nobody else you did. Messages thread by contact with a reply address inside the memo. Payment fees show before you send. Vault escrow now verifies funding on chain before a vault arms." },
  { d: "Jul 20 2026", v: "0.9.0", t: "New wallet engine, built and tested ahead of the July 28 Ironwood network upgrade. Wallet infrastructure moved to a maintained server." },
  { d: "Jul 19 2026", v: "0.8.0", t: "Seed only sign in. No usernames, no passwords, no accounts. Signing out seals your wallet with encryption derived from your own seed." },
  { d: "Jul 18 2026", v: "0.7.0", t: "Cross chain swaps. Buy and sell ZEC with BTC, ETH, SOL or USDC through NEAR Intents. Unfunded swaps can be cancelled any time." },
  { d: "Jul 16 2026", v: "0.5.0", t: "Security hardening. Wallet isolation, safer file handling, and reliable payments and messages." },
];

// What we are working toward. Shown under the dev log. Newest plans first.
const ZAIM_UPCOMING = [
  { k: "AI", title: "The AI relay goes live", t: "The AI tab runs against a test network today. Next it moves to its own machine, kept apart from everything else, so the service that reads your question is never the one that knows your balance." },
  { k: "KEYS", title: "Keys that never leave your device", t: "Today our server holds your wallet while you are signed in, and we say so plainly. The plan is to move signing into your browser, so we carry bytes and nothing more." },
  { k: "NODE", title: "Run our own node", t: "Right now your wallet talks to a shared Zcash server. We plan to run our own, so your addresses and activity pass through fewer hands." },
];

// Contacts live on THIS device only. No account, no server copy.
const Contacts = {
  list: () => { try { return JSON.parse(localStorage.getItem("zaim_contacts") || "[]"); } catch (e) { return []; } },
  add: (name, address) => { const c = Contacts.list(); c.push({ name, address }); localStorage.setItem("zaim_contacts", JSON.stringify(c)); return c; },
};

// ── shared bits ──────────────────────────────────────────────────────────────
const BackArrow = ({ onClick }) => (
  <button onClick={onClick} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex" }} aria-label="Back">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke={T.black} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
);
const Toast = ({ msg, type = "info" }) => msg ? (
  <div style={{ position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", zIndex: 999, padding: "10px 18px", fontFamily: F.mono, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", maxWidth: 380, textAlign: "center", border: `2px solid ${T.black}`, borderTop: "none", background: type === "error" ? T.red : type === "success" ? T.teal : T.blue, color: type === "success" ? T.black : T.white }}>{msg}</div>
) : null;

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("open");
  const [seedIn, setSeedIn] = useState(""); const [birthday, setBirthday] = useState("");
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [seed, setSeed] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const [price, setPrice] = useState(null);
  const [notice] = useState(takeNotice); // why the last session ended, if the server said
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const p = await API.getPrice(); if (alive) setPrice(p); } catch (e) { } };
    load();
    const iv = setInterval(load, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const submit = async () => {
    setError("");
    if (mode === "open" && seedIn.trim().split(/\s+/).length < 12) return setError("Paste your full seed phrase");
    setLoading(true);
    if (mode === "open") setRestoring(true);
    try {
      const res = mode === "create"
        ? await API.createWallet()
        : await API.openWallet(seedIn.trim(), parseInt(birthday) || 0);
      localStorage.setItem("zaim_token", res.token);
      // AI account: a second seed derived CLIENT-side from the one just typed.
      // Fire-and-forget; the tab works once it lands, and failure only means
      // the AI tab shows "open the AI account" later.
      try {
        const mainSeed = mode === "create" ? (res.seed?.seed || res.seed) : seedIn.trim();
        const aiSeed = deriveAiMnemonic(mainSeed);
        // The store key never leaves the browser; it encrypts conversations and
        // the pending ephemeral keys that answers depend on.
        try { sessionStorage.setItem("zaim_ai_sk", Array.from(deriveStoreKey(aiSeed)).join(",")); } catch (e) { }
        const bd = parseInt(localStorage.getItem("zaim_ai_birthday") || "0") || 0;
        apiPost("/ai/open", { seed_phrase: aiSeed, birthday: bd })
          .then((r) => { if (r.height) localStorage.setItem("zaim_ai_birthday", String(r.height)); })
          .catch(() => {});
      } catch (e) { /* non-fatal */ }
      if (res.seed) setSeed(typeof res.seed === "string" ? res.seed : (res.seed.seed || JSON.stringify(res.seed)));
      else onAuth();
    } catch (e) { setError(e.message); }
    setLoading(false); setRestoring(false);
  };
  if (showFeatures) return <FeaturesScreen onBack={() => setShowFeatures(false)} />;
  if (showLog) return (
    <div className="mp-scroll">
      <div className="mp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BackArrow onClick={() => setShowLog(false)} />
          <div className="mp-title">Dev Log</div>
        </div>
        <div className="mp-meta" style={{ color: T.blue }}>ZAIM</div>
      </div>
      {ZAIM_LOG.map((e, i) => (
        <div key={i} style={{ background: T.white, borderBottom: `2px solid ${T.black}`, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase" }}>{e.d}</span>
            <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 12, letterSpacing: .5, padding: "3px 8px", background: T.blue, color: T.white, textTransform: "uppercase" }}>ZAIM {e.v}</span>
          </div>
          <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.5 }}>{e.t}</div>
        </div>
      ))}

      <div className="mp-section">WHAT IT RUNS ON</div>
      {[
        ["NETWORK", "Zcash mainnet", "z.cash", "https://z.cash"],
        ["ENGINE", "zingolib wallet core", "github.com/zingolabs/zingolib", "https://github.com/zingolabs/zingolib"],
        ["SERVER", "zec.rocks lightwalletd", "zec.rocks", "https://zec.rocks"],
        ["SWAPS", "NEAR Intents", "near-intents.org", "https://near-intents.org"],
      ].map(([k, name, label, url]) => (
        <a key={k} href={url} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "12px 16px", borderBottom: `2px solid ${T.black}`, background: T.white, textDecoration: "none", color: T.black }}>
          <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, color: T.blue, flexShrink: 0, paddingTop: 2, width: 62 }}>{k}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{name}</span>
            <span style={{ display: "block", fontFamily: F.mono, fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label} ↗</span>
          </span>
        </a>
      ))}

      <div className="mp-section">YOUR KEYS</div>
      <div className="mp-band mp-band-w">
        <div className="mp-quip">Your seed is a standard Zcash seed. It opens the same wallet in Zashi, Ywallet, or any Zcash wallet. You can leave any time.</div>
      </div>

      <div className="mp-section">OPEN SOURCE</div>
      <a href="https://github.com/temet-crypto/zaim" target="_blank" rel="noreferrer" style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "12px 16px", borderBottom: `2px solid ${T.black}`, background: T.white, textDecoration: "none", color: T.black }}>
        <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, color: T.blue, flexShrink: 0, paddingTop: 2, width: 62 }}>CODE</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>Read every line. MIT licensed.</span>
          <span style={{ display: "block", fontFamily: F.mono, fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>github.com/temet-crypto/zaim ↗</span>
        </span>
      </a>

      <div className="mp-section">UPCOMING</div>
      {ZAIM_UPCOMING.map((u) => (
        <div key={u.k} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "12px 16px", borderBottom: `2px solid ${T.black}`, background: T.white }}>
          <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, color: T.blue, flexShrink: 0, paddingTop: 2, width: 62 }}>SOON</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{u.title}</span>
            <span style={{ display: "block", fontFamily: F.body, fontSize: 13, lineHeight: 1.5, marginTop: 3 }}>{u.t}</span>
          </span>
        </div>
      ))}
    </div>
  );
  if (seed) return (
    <div className="mp-scroll">
      <div className="mp-section">BACKUP YOUR SEED</div>
      <div className="mp-band">
        <div className="mp-big" style={{ fontSize: 40, marginBottom: 14 }}>SAVE<br />THIS NOW</div>
        <div className="mp-quip" style={{ marginBottom: 18 }}>Write it down. It is the only way back in.</div>
      </div>
      <div className="mp-band mp-band-w">
        <div className="mp-lbl-sm" style={{ marginBottom: 10, color: T.blue }}>SEED PHRASE</div>
        <div className="mp-mono" style={{ fontSize: 14, lineHeight: 1.9, wordBreak: "break-word" }}>{seed}</div>
      </div>
      <div className="mp-band" style={{ background: T.signout }}>
        <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1, color: T.white, textTransform: "uppercase" }}>⚠ anyone with this seed controls this wallet</div>
      </div>
      <div style={{ padding: 16 }}><button className="mp-btn" onClick={onAuth}>I SAVED MY SEED PHRASE</button></div>
    </div>
  );
  return (
    <div className="mp-scroll">
      <div className="mp-band-blue" style={{ position: "relative", padding: "36px 16px", borderBottom: `2px solid ${T.black}`, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%) rotate(18deg)", width: 3, height: 104, background: price?.usd_24h_change == null ? T.white : (price.usd_24h_change >= 0 ? T.teal : T.red) }} />
        <div className="mp-big" style={{ color: T.white, fontSize: 50, letterSpacing: -2 }}>ZAIM</div>
        {price?.usd != null && (
          <div style={{ textAlign: "right", paddingBottom: 6 }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, color: price.usd_24h_change == null ? T.white : (price.usd_24h_change >= 0 ? T.teal : T.red), textTransform: "uppercase" }}>ZEC</div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 50, color: T.white, letterSpacing: -2, lineHeight: .95 }}>${price.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        )}
      </div>
      {notice && (
        <div style={{ padding: "12px 16px", borderBottom: `2px solid ${T.black}`, background: T.blueTint }}>
          <span style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: .5, textTransform: "uppercase" }}>{notice}</span>
        </div>
      )}
      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        {["open", "create"].map((m, i) => (
          <div key={m} onClick={() => { setMode(m); setError(""); }} style={{ flex: 1, padding: "14px 0", textAlign: "center", cursor: "pointer", fontFamily: F.display, fontWeight: 800, fontSize: 18, textTransform: "uppercase", letterSpacing: .5, borderRight: i === 0 ? `2px solid ${T.black}` : "none", background: mode === m ? T.blue : T.off, color: mode === m ? T.white : T.black }}>
            {m === "open" ? "My Seed" : "New Wallet"}
          </div>
        ))}
      </div>
      {mode === "open" ? (
        <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>SEED PHRASE</div>
            <textarea className="mp-input" rows={4} value={seedIn} onChange={e => setSeedIn(e.target.value)} placeholder="Paste your 24 words" style={{ resize: "none", fontFamily: F.mono, fontSize: 13, lineHeight: 1.6 }} />
          </div>
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>BIRTHDAY HEIGHT · OPTIONAL</div>
            <input className="mp-input" type="number" value={birthday} onChange={e => setBirthday(e.target.value)} placeholder="Speeds up a first restore" />
          </div>
          {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
          <button className="mp-btn" onClick={submit} disabled={loading}>{loading ? (restoring ? "OPENING… A FIRST RESTORE CAN TAKE MINUTES" : "…") : "OPEN WALLET"}</button>
        </div>
      ) : (
        <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="mp-quip">A fresh wallet with a fresh seed. You will be shown the 24 words once. Save them like money, because they are.</div>
          {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
          <button className="mp-btn" onClick={submit} disabled={loading}>{loading ? "CREATING…" : "CREATE NEW WALLET"}</button>
        </div>
      )}
      <div style={{ padding: "24px 16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
        <button className="mp-btn" onClick={() => setShowLog(true)} style={{ background: "none", color: T.black, border: `2px solid ${T.black}` }}>DEV LOG</button>
        <button className="mp-btn" onClick={() => setShowFeatures(true)} style={{ background: "none", color: T.blue, border: `2px solid ${T.blue}` }}>FEATURES</button>
      </div>
    </div>
  );
}

function ScreenHead({ title, meta, right }) {
  return (
    <div className="mp-head">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="mp-title">{title}</div>
        {meta && <div className="mp-meta" style={{ color: T.blue }}>{meta}</div>}
      </div>
      {right}
    </div>
  );
}

function HomeScreen({ onNav }) {
  const [balance, setBalance] = useState(null); const [address, setAddress] = useState(""); const [tAddr, setTAddr] = useState("");
  const [txs, setTxs] = useState([]); const [loading, setLoading] = useState(true); const [toast, setToast] = useState("");
  const [price, setPrice] = useState(null); const [now, setNow] = useState(Date.now());
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [b, a, t] = await Promise.allSettled([API.getBalance(), API.getAddress(), API.getTransactions()]);
      if (b.status === "fulfilled") setBalance(b.value);
      if (a.status === "fulfilled") { setAddress(a.value.z_address || a.value.ua_address || ""); setTAddr(a.value.t_address || ""); }
      if (t.status === "fulfilled") { const l = t.value.transactions; setTxs(Array.isArray(l) ? l.slice(0, 12) : []); }
    } catch (e) { } setLoading(false);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    let alive = true;
    const loadPrice = async () => { try { const p = await API.getPrice(); if (alive) setPrice(p); } catch (e) { } };
    loadPrice();
    const poll = setInterval(loadPrice, 60000);   // refresh price every minute
    const tick = setInterval(() => setNow(Date.now()), 1000); // drive "updated Xs ago"
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);
  const fmtAgo = (updatedAt) => {
    if (!updatedAt) return "···";
    const s = Math.max(0, Math.floor(now / 1000 - updatedAt));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };
  const getBal = () => {
    if (!balance) return { z: "0.0000", t: "0.0000", o: "0.0000", total: "0.0000" };
    const b = balance.balance || balance;
    const toZec = v => ((typeof v === "number" ? v : parseInt(v) || 0) / 1e8).toFixed(4);
    const z = b.sapling_balance || b.spendable_sapling_balance || b.zbalance || b.verified_zbalance || 0;
    const t = b.transparent_balance || b.tbalance || b.t_balance || 0;
    const o = b.orchard_balance || b.spendable_orchard_balance || b.uabalance || 0;
    const total = ((typeof z === "number" ? z : parseInt(z) || 0) + (typeof t === "number" ? t : parseInt(t) || 0) + (typeof o === "number" ? o : parseInt(o) || 0)) / 1e8;
    return { z: toZec(z), t: toZec(t), o: toZec(o), total: total.toFixed(4) };
  };
  const bal = getBal();
  const usd = price?.usd;
  const usdVal = usd != null ? parseFloat(bal.total) * usd : null;
  const chg = price?.usd_24h_change;
  const fmtUsd = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="mp-scroll">
      <Toast msg={toast} type="success" />
      <ScreenHead title="Wallet" meta="ZAIM" right={
        <button onClick={refresh} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }} aria-label="Refresh">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6" stroke={loading ? T.blue : T.black} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke={loading ? T.blue : T.black} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      } />
      <div className="mp-band" style={{ paddingTop: 20, paddingBottom: 18 }}>
        <div className="mp-lbl" style={{ marginBottom: 10 }}>BALANCE · ALL POOLS</div>
        <div className="mp-big">{loading ? "···" : bal.total}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <span className="mp-lbl">ZEC TOTAL</span>
          {usdVal != null && <span style={{ fontFamily: F.mono, fontSize: 12, color: T.black }}>≈ {fmtUsd(usdVal)} USD</span>}
        </div>
      </div>
      <div className="mp-grid">
        <div className="mp-cell"><div className="mp-cell-key">SHIELDED</div><div className="mp-cell-val" style={{ color: T.teal }}>{bal.z}</div></div>
        <div className="mp-cell"><div className="mp-cell-key">TRANSPARENT</div><div className="mp-cell-val" style={{ color: T.blue }}>{bal.t}</div></div>
      </div>
      <div className="mp-section" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>ZEC / USD · MARKET</span>
        <span style={{ opacity: .8 }}>{price ? `UPD ${fmtAgo(price.updated_at)}` : "…"}</span>
      </div>
      <div className="mp-band mp-band-w" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div className="mp-big" style={{ fontSize: 40 }}>{usd != null ? fmtUsd(usd) : "···"}</div>
          <div className="mp-lbl-sm" style={{ marginTop: 6 }}>ZCASH · COINGECKO</div>
        </div>
        {chg != null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 26, color: chg >= 0 ? T.teal : T.red, letterSpacing: -.5 }}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</div>
            <div className="mp-lbl-sm" style={{ marginTop: 4 }}>24H</div>
          </div>
        )}
      </div>
      <div className="mp-band mp-band-w">
        <div className="mp-lbl-sm" style={{ marginBottom: 6, color: T.blue }}>SHIELDED ADDRESS</div>
        <div className="mp-mono">{address || "Loading address…"}</div>
        {tAddr && <>
          <div className="mp-lbl-sm" style={{ margin: "12px 0 6px", color: T.blue }}>TRANSPARENT ADDRESS</div>
          <div className="mp-mono">{tAddr}</div>
        </>}
      </div>
      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        <button className="mp-btn" style={{ fontSize: 13, padding: "15px 4px", borderRight: `2px solid ${T.black}`, borderLeft: "none", borderTop: "none", borderBottom: "none" }} onClick={() => onNav("send")}>SEND</button>
        <button className="mp-btn" style={{ fontSize: 13, padding: "15px 4px", borderRight: `2px solid ${T.black}`, borderLeft: "none", borderTop: "none", borderBottom: "none", background: T.teal, color: T.black }} onClick={() => onNav("request")}>REQUEST</button>
        <button className="mp-btn" style={{ fontSize: 13, padding: "15px 4px", borderRight: `2px solid ${T.black}`, borderLeft: "none", borderTop: "none", borderBottom: "none", background: T.blue }} onClick={() => onNav("swap")}>SWAP</button>
        <button className="mp-btn ghost" style={{ fontSize: 13, padding: "15px 4px", border: "none" }} onClick={() => { if (address) { navigator.clipboard?.writeText(address); setToast("Address copied"); setTimeout(() => setToast(""), 1800); } }}>COPY</button>
      </div>
      <div className="mp-section">RECENT TRANSACTIONS</div>
      {txs.length === 0 ? (
        <div className="mp-band" style={{ textAlign: "center" }}><span className="mp-quip">{loading ? "Syncing…" : "No transactions yet."}</span></div>
      ) : txs.map((tx, i) => {
        const rawVal = tx.value || tx.amount || 0;
        const zec = Math.abs(typeof rawVal === "number" ? rawVal / 1e8 : parseFloat(rawVal || 0) / 1e8);
        const kind = String(tx.kind || "").toLowerCase().replace(/[-_ ]/g, "");
        const self = kind.includes("self");
        const isIn = !self && !kind.startsWith("sen");
        tx.memo = (tx.memo || (Array.isArray(tx.memos) && tx.memos.length ? tx.memos[0] : "") || "").split("\nReply-to:")[0];
        if (tx.memo.startsWith("zaim-sync:")) tx.memo = "contact sync";
        if (tx.memo.startsWith("zaim-vault:")) tx.memo = "vault funding";
        return (
          <div key={i} className="mp-row">
            <div style={{ width: 64, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: self ? T.black : isIn ? T.teal : T.red, color: self ? T.white : isIn ? T.black : T.white, fontFamily: F.display, fontWeight: 800, fontSize: 12, letterSpacing: .5, flexShrink: 0 }}>{self ? "SELF" : isIn ? "IN" : "OUT"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{isIn ? "Received" : self ? "Self" : "Sent"}</div>
              {(tx.memo || tx.address || tx.toaddress) && <div style={{ fontFamily: F.mono, fontSize: 11, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(tx.memo || tx.address || tx.toaddress || "").substring(0, 34)}</div>}
            </div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 19, color: isIn ? T.teal : T.red, whiteSpace: "nowrap" }}>{isIn ? "+" : "−"}{zec.toFixed(4)}</div>
          </div>
        );
      })}
      <div style={{ height: 12 }} />
    </div>
  );
}

function SendScreen({ onBack }) {
  const [to, setTo] = useState(""); const [amount, setAmount] = useState(""); const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false); const [result, setResult] = useState(null); const [error, setError] = useState("");
  const [feeBps, setFeeBps] = useState(0);
  // The server discloses its fee; the screen repeats it BEFORE the send button.
  useEffect(() => { API.health().then(h => setFeeBps(h.fee_bps || 0)).catch(() => { }); }, []);
  const send = async () => {
    if (!to) return setError("Enter address");
    if (!amount || parseFloat(amount) <= 0) return setError("Enter amount");
    setLoading(true); setError("");
    try { const r = await API.sendPayment(to, parseFloat(amount), memo); setResult(r); } catch (e) { setError(e.message); }
    setLoading(false);
  };
  if (result) return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={onBack} /><div className="mp-title">Sent</div></div></div>
      <div className="mp-band-blue" style={{ padding: "40px 16px", borderBottom: `2px solid ${T.black}` }}>
        <div className="mp-lbl" style={{ color: T.white, marginBottom: 10 }}>PAYMENT BROADCAST</div>
        <div className="mp-big" style={{ color: T.white }}>{amount}</div>
        <div className="mp-lbl" style={{ color: T.white, marginTop: 12 }}>ZEC SENT{result.fee_zec > 0 ? ` · APP FEE ${Number(result.fee_zec).toFixed(6)} ZEC` : ""}</div>
      </div>
      <div className="mp-band"><div className="mp-quip">Shielded and on its way.</div></div>
      <div style={{ padding: 16 }}><button className="mp-btn" onClick={onBack}>DONE</button></div>
    </div>
  );
  return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={onBack} /><div className="mp-title">Send ZEC</div></div></div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>TO ADDRESS · OR PASTE A ZCASH: LINK</div>
          <input className="mp-input" value={to} onChange={e => {
            const uri = parseZcashUri(e.target.value);
            if (uri) { setTo(uri.to); if (uri.amount) setAmount(uri.amount); if (uri.memo) setMemo(uri.memo); }
            else setTo(e.target.value);
          }} placeholder="Address or zcash: payment link" />
        </div>
        <div>
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>AMOUNT · ZEC</div>
          <input className="mp-input" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0000" />
          {feeBps > 0 && <div className="mp-lbl-sm" style={{ marginTop: 6, color: T.blue }}>A {(feeBps / 100).toFixed(2)}% APP FEE IS ADDED ON TOP. THE RECIPIENT GETS THE FULL AMOUNT</div>}
        </div>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>MEMO · OPTIONAL</div><input className="mp-input" value={memo} onChange={e => setMemo(e.target.value)} maxLength={400} placeholder="Encrypted memo on the chain" /></div>
        {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
        <button className="mp-btn" onClick={send} disabled={loading}>{loading ? "SENDING…" : "SEND"}</button>
      </div>
    </div>
  );
}

function RequestScreen({ onBack }) {
  const [amount, setAmount] = useState(""); const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [current, setCurrent] = useState(null);   // the request just created
  const [past, setPast] = useState([]); const [copied, setCopied] = useState(false);
  const loadPast = useCallback(() => { API.listRequests().then(r => setPast(r.requests || [])).catch(() => { }); }, []);
  useEffect(() => {
    loadPast();
    const t = setInterval(() => { if (!document.hidden) loadPast(); }, 30000);
    return () => clearInterval(t);
  }, [loadPast]);
  const create = async () => {
    if (!amount || parseFloat(amount) <= 0) return setError("Enter an amount");
    setLoading(true); setError("");
    try { const r = await API.createRequest(parseFloat(amount), memo.trim()); setCurrent(r.request); setAmount(""); setMemo(""); loadPast(); }
    catch (e) { setError(e.message); }
    setLoading(false);
  };
  const copyUri = () => { navigator.clipboard?.writeText(current.uri); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  if (current) return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={() => setCurrent(null)} /><div className="mp-title">Request</div></div></div>
      <div className="mp-band-blue" style={{ padding: "24px 16px", borderBottom: `2px solid ${T.black}` }}>
        <div className="mp-lbl" style={{ color: T.white, marginBottom: 8 }}>REQUESTING</div>
        <div className="mp-big" style={{ color: T.white, fontSize: 44 }}>{Number(current.zec).toFixed(4)} ZEC</div>
        {current.memo && <div style={{ fontFamily: F.mono, fontSize: 11, color: T.white, marginTop: 8 }}>{current.memo}</div>}
      </div>
      <div className="mp-band mp-band-w" style={{ textAlign: "center" }}>
        <div style={{ display: "inline-block", padding: 10, border: `2px solid ${T.black}`, background: T.white }}>
          <QRCodeSVG value={current.uri} size={180} />
        </div>
        <div className="mp-mono" style={{ marginTop: 12, wordBreak: "break-all", fontSize: 11 }}>{current.uri}</div>
        <button className="mp-link" style={{ marginTop: 8 }} onClick={copyUri}>{copied ? "COPIED" : "TAP TO COPY LINK"}</button>
      </div>
      <div className="mp-band">
        <div className="mp-quip">Payable from any Zcash wallet. Zashi, Ywallet, another ZAIM, all the same. A fresh address every time, so your requests cannot be tied together.</div>
      </div>
      <div style={{ padding: 16 }}><button className="mp-btn" onClick={() => setCurrent(null)}>DONE</button></div>
    </div>
  );
  return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={onBack} /><div className="mp-title">Request ZEC</div></div></div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>AMOUNT · ZEC</div><input className="mp-input" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0000" /></div>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>NOTE · OPTIONAL · THE PAYER SEES IT</div><input className="mp-input" value={memo} onChange={e => setMemo(e.target.value)} maxLength={200} placeholder="What is this for" /></div>
        {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
        <button className="mp-btn" onClick={create} disabled={loading}>{loading ? "CREATING…" : "CREATE REQUEST"}</button>
      </div>
      {past.length > 0 && <>
        <div className="mp-section">YOUR REQUESTS</div>
        {past.map(r => (
          <div key={r.id} className="mp-row" style={{ cursor: "pointer" }} onClick={() => setCurrent(r)}>
            <div style={{ width: 64, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: r.paid ? T.teal : T.blue, color: r.paid ? T.black : T.white, fontFamily: F.display, fontWeight: 800, fontSize: 12 }}>{r.paid ? "PAID" : "OPEN"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{Number(r.zec).toFixed(4)} ZEC</div>
              {r.memo && <div style={{ fontFamily: F.mono, fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo}</div>}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 10 }}>{new Date(r.created * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
          </div>
        ))}
      </>}
      <div style={{ height: 12 }} />
    </div>
  );
}

function MessengerScreen({ onNav }) {
  const [contacts, setContacts] = useState([]); const [showAdd, setShowAdd] = useState(false);
  const [nn, setNn] = useState(""); const [na, setNa] = useState(""); const [err, setErr] = useState("");
  const [chainTs, setChainTs] = useState(null);   // newest sync set on chain, if any
  const [syncing, setSyncing] = useState(false); const [syncMsg, setSyncMsg] = useState("");
  useEffect(() => { setContacts(Contacts.list()); }, []);
  // Pull is free (reading your own memos). Merge chain contacts into local;
  // local entries win on address collisions.
  useEffect(() => {
    API.syncPull().then(r => {
      if (!r.found) return;
      setChainTs(r.ts);
      const local = Contacts.list();
      const have = new Set(local.map(c => c.address));
      const incoming = (r.contacts || []).filter(c => c && c.address && c.name && !have.has(c.address));
      if (incoming.length) {
        const merged = [...local, ...incoming];
        localStorage.setItem("zaim_contacts", JSON.stringify(merged));
        setContacts(merged);
        setSyncMsg(`${incoming.length} contact${incoming.length > 1 ? "s" : ""} pulled from the chain`);
        setTimeout(() => setSyncMsg(""), 4000);
      }
    }).catch(() => { });
  }, []);
  // Push writes the book to the chain as one transaction of encrypted memos.
  // It spends dust, so it only ever happens on an explicit, confirmed tap.
  const push = async () => {
    const book = Contacts.list();
    if (!book.length) { setSyncMsg("Nothing to sync yet"); setTimeout(() => setSyncMsg(""), 2500); return; }
    if (!window.confirm(`Write ${book.length} contact${book.length > 1 ? "s" : ""} to the chain as encrypted memos? Costs about 0.001 ZEC. Only your seed can read them.`)) return;
    setSyncing(true);
    try { const r = await API.syncPush(book); setChainTs(r.ts); setSyncMsg(`Synced · ${r.chunks} memo${r.chunks > 1 ? "s" : ""} · ${r.cost_zec} ZEC`); }
    catch (e) { setSyncMsg(e.message); }
    setSyncing(false); setTimeout(() => setSyncMsg(""), 5000);
  };
  const add = () => { if (!nn || !na) return setErr("Enter name and address"); setContacts(Contacts.add(nn, na)); setShowAdd(false); setNn(""); setNa(""); setErr(""); };
  return (
    <div className="mp-scroll">
      <ScreenHead title="Messages" meta="ZAIM" right={
        <button onClick={() => setShowAdd(!showAdd)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }} aria-label="Add contact">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke={T.blue} strokeWidth="2.5" strokeLinecap="round" /></svg>
        </button>
      } />
      {showAdd && (
        <div className="mp-band mp-band-w" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="mp-lbl-sm" style={{ color: T.blue }}>NEW CONTACT</div>
          <input className="mp-input" value={nn} onChange={e => setNn(e.target.value)} placeholder="Contact name" />
          <input className="mp-input" value={na} onChange={e => setNa(e.target.value)} placeholder="Shielded address" />
          {err && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase" }}>{err}</div>}
          <button className="mp-btn" onClick={add}>ADD CONTACT</button>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: `2px solid ${T.black}`, background: T.white }}>
        <span className="mp-lbl-sm">{syncMsg || (chainTs ? `CHAIN SYNC · ${new Date(chainTs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "CHAIN SYNC · NOTHING ON CHAIN YET")}</span>
        <button className="mp-link" onClick={push} disabled={syncing}>{syncing ? "WRITING…" : "PUSH TO CHAIN"}</button>
      </div>
      {contacts.length === 0 ? (
        <div className="mp-band" style={{ textAlign: "center" }}><div className="mp-quip" style={{ marginBottom: 8 }}>No contacts yet.</div><div className="mp-lbl-sm">TAP + TO START A CONVERSATION</div></div>
      ) : contacts.map((c, i) => (
        <div key={i} onClick={() => onNav("chat", c)} className="mp-row" style={{ cursor: "pointer" }}>
          <div style={{ width: 44, height: 44, background: T.blue, color: T.white, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.display, fontWeight: 800, fontSize: 20, flexShrink: 0 }}>{c.name.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 15 }}>{c.name}</div>
            <div style={{ fontFamily: F.mono, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address.substring(0, 22)}…</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke={T.black} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      ))}
    </div>
  );
}

function ChatScreen({ contact, onBack }) {
  const [input, setInput] = useState(""); const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState([]); const [toast, setToast] = useState(""); const endRef = useRef(null);
  const [fees, setFees] = useState(null);
  useEffect(() => { API.fees().then(setFees).catch(() => { }); }, []);
  // This thread: what I sent to THIS address, what came back tagged with THIS
  // reply address, and incoming memos with no tag at all. The last group is
  // unattributable (a shielded memo carries no sender unless the sender says),
  // so those show in every thread, marked, instead of being guessed at.
  const eq = (a, b) => !!a && !!b && String(a).trim() === String(b).trim();
  const mine = useCallback((m) => m.sent ? eq(m.to, contact.address) : (m.from ? eq(m.from, contact.address) : true), [contact.address]);
  const load = useCallback(() => {
    API.getMessages().then(r => {
      setMessages((r.messages || []).filter(m => m.memo).filter(mine));
    }).catch(() => { });
  }, [mine]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 25000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const sendMsg = async () => {
    if (!input.trim()) return; setSending(true);
    try {
      const r = await API.sendMessage(contact.address, input.trim());
      setMessages(p => [...p, { memo: input.trim(), to: contact.address, amount: 0.0001, txid: "pending", sent: true }]);
      setInput("");
      setToast(r?.fee_zats ? `Sent · ZAIM fee ${(r.fee_zats / 1e8).toFixed(5)} ZEC` : "Sent");
      setTimeout(() => setToast(""), 2500);
      if (r?.fee_zats) API.fees().then(setFees).catch(() => { });
    }
    catch (e) { setToast("Failed: " + e.message); setTimeout(() => setToast(""), 3500); }
    setSending(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toast msg={toast} type={toast.startsWith("F") ? "error" : "success"} />
      <div className="mp-head" style={{ position: "static" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <BackArrow onClick={onBack} />
          <div style={{ width: 36, height: 36, background: T.blue, color: T.white, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.display, fontWeight: 800, fontSize: 16, flexShrink: 0 }}>{contact.name.charAt(0).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, lineHeight: 1, textTransform: "uppercase" }}>{contact.name}</div>
            <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact.address.substring(0, 20)}…</div>
          </div>
        </div>
      </div>
      <div className="mp-scroll" style={{ padding: "16px", background: T.off }}>
        {messages.length === 0 && <div style={{ textAlign: "center", padding: "32px 0" }}><span className="mp-quip">
          {fees?.messenger_fee_enabled
            ? `Send a message as a shielded memo. Network fee plus a ${(fees.msg_fee_zats / 1e8).toFixed(5)} ZEC ZAIM fee, about $${fees.msg_fee_usd.toFixed(2)}.`
            : "Send a message as a shielded memo. 0.0001 ZEC each."}
        </span></div>}
        {messages.map((m, i) => {
          const me = m.sent;
          return (
            <div key={i} style={{ marginBottom: 12, display: "flex", justifyContent: me ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "82%", padding: "10px 12px", border: `2px solid ${T.black}`, background: me ? T.blue : T.white, color: me ? T.white : T.black }}>
                <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.45 }}>{m.memo}</div>
                <div style={{ fontFamily: F.mono, fontSize: 9, marginTop: 5, letterSpacing: .5, textTransform: "uppercase", opacity: .8 }}>{m.txid === "pending" ? "PENDING" : m.height ? `BLOCK ${m.height}` : ""}{m.amount ? ` · ${m.amount} ZEC` : ""}{!me && !m.from ? " · SENDER UNKNOWN" : ""}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div style={{ borderTop: `2px solid ${T.black}`, background: T.off }}>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !sending && sendMsg()} maxLength={340} placeholder="Type a message…" style={{ flex: 1, fontFamily: F.mono, fontSize: 14, padding: 14, background: T.white, border: "none", borderRight: `2px solid ${T.black}`, color: T.black, outline: "none" }} />
          <button onClick={() => !sending && sendMsg()} style={{ width: 60, border: "none", background: sending ? T.faint : T.blue, cursor: sending ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#fff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: T.black, padding: "8px 14px", textAlign: "center", borderTop: `2px solid ${T.black}` }}>0.0001 ZEC per message · shielded memo</div>
      </div>
    </div>
  );
}

function SettingsScreen({ onLogout, onAdmin }) {
  const [health, setHealth] = useState(null);
  const [seed, setSeed] = useState(null); const [showSeed, setShowSeed] = useState(false);
  const [seedLoading, setSeedLoading] = useState(false); const [toast, setToast] = useState("");
  const [fees, setFees] = useState(null);
  const [servers, setServers] = useState(null); const [mine, setMine] = useState("");
  const [switching, setSwitching] = useState("");
  useEffect(() => { API.health().then(setHealth).catch(() => { }); }, []);
  useEffect(() => { API.fees().then(setFees).catch(() => { }); }, []);
  useEffect(() => {
    API.listServers().then(setServers).catch(() => { });
    API.getServer().then(r => setMine(r.server)).catch(() => { });
  }, []);
  const pickServer = async (url) => {
    if (url === mine || switching) return;
    setSwitching(url);
    try {
      const r = await API.setServer(url);
      setMine(r.server);
      API.health().then(setHealth).catch(() => { });
    } catch (e) {
      setToast(e.message || "Could not change indexer"); setTimeout(() => setToast(""), 2500);
    }
    setSwitching("");
  };
  const revealSeed = async () => {
    if (seed) { setShowSeed(!showSeed); return; }
    setSeedLoading(true);
    try { const r = await API.getSeed(); setSeed(r); setShowSeed(true); }
    catch (e) { setToast("Could not retrieve seed"); setTimeout(() => setToast(""), 2500); }
    setSeedLoading(false);
  };
  const getSeedText = () => { if (!seed) return ""; if (typeof seed === "string") return seed; if (seed.seed) return seed.seed; if (seed.raw) return seed.raw; return JSON.stringify(seed); };
  const conn = health?.status === "ok";
  const KV = ({ k, v, color }) => (<div className="mp-kv"><span className="mp-kv-key">{k}</span><span className="mp-kv-val" style={{ color: color || T.black }}>{v}</span></div>);
  const KVm = ({ k, v, color }) => (<div className="mp-kv"><span className="mp-kv-key">{k}</span><span className="mp-kv-val mono" style={{ color: color || T.black }}>{v}</span></div>);
  return (
    <div className="mp-scroll">
      <Toast msg={toast} type="error" />
      <ScreenHead title="Settings" meta="ZAIM" />
      <div className="mp-section">NETWORK</div>
      <KV k="Status" v={conn ? "ONLINE" : "OFFLINE"} color={conn ? T.teal : T.red} />
      <KVm k="Protocol" v="Shielded · Sapling + Orchard" color={T.blue} />
      <KVm k="Network" v="Zcash Mainnet" />

      <div className="mp-section">INDEXER</div>
      <div style={{ padding: "10px 16px 4px", fontFamily: F.body, fontSize: 12, lineHeight: 1.5 }}>
        This is the server ZAIM asks for chain data on your behalf. Your browser never
        contacts it, so it learns this server's address and not yours. What it does see
        is every lookup and every broadcast ZAIM makes, so it is worth choosing.
      </div>
      {(servers?.servers || []).map(s => {
        const on = s.url === mine;
        return (
          <button key={s.url} onClick={() => pickServer(s.url)} disabled={!!switching}
            style={{
              display: "block", width: "100%", textAlign: "left", cursor: switching ? "wait" : "pointer",
              background: on ? T.blue : T.white, color: on ? T.white : T.black,
              border: "none", borderBottom: `2px solid ${T.black}`, padding: "11px 16px",
            }}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 14, letterSpacing: -.2 }}>
              {s.label}{on ? "  IN USE" : ""}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 3, opacity: .75 }}>
              {s.url.replace("https://", "")}
            </div>
          </button>
        );
      })}
      {servers?.same_operator && (
        <div style={{ padding: "10px 16px", fontFamily: F.body, fontSize: 12, lineHeight: 1.5, background: T.off, borderBottom: `2px solid ${T.black}` }}>
          Worth saying plainly: every option above is run by the same operator, so
          switching changes your latency and not who can watch you. Running your own
          indexer is the only version of this that is real.
        </div>
      )}
      <div className="mp-section">SECURITY</div>
      <KV k="Encryption" v="E2E SHIELDED" color={T.teal} />
      <KVm k="Key Storage" v="Server side · custodial" />
      <KV k="Memo Privacy" v="ON-CHAIN" color={T.teal} />
      <KVm k="Address Type" v="z address · shielded" />
      {fees?.messenger_fee_enabled && (
        <>
          <div className="mp-section">ZAIM FEES</div>
          <KVm k="Per message" v={`${(fees.msg_fee_zats / 1e8).toFixed(5)} ZEC · $${fees.msg_fee_usd.toFixed(2)}`} />
          <KVm k="Paid to date" v={`${(fees.lifetime_fees_zats / 1e8).toFixed(5)} ZEC`} color={T.blue} />
        </>
      )}
      <div className="mp-section">ACCOUNT</div>
      <KVm k="Identity" v="your seed · no account" color={T.blue} />
      <KVm k="At rest" v="sealed · seed encrypted" color={T.teal} />
      <div className="mp-section">RECOVERY</div>
      <div className="mp-band mp-band-w">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 22, textTransform: "uppercase", lineHeight: 1 }}>Seed Phrase</div>
            <div className="mp-lbl-sm" style={{ marginTop: 5 }}>24 WORDS · YOUR ONLY BACKUP</div>
          </div>
          <button className="mp-link" style={{ color: showSeed ? T.signout : T.blue }} onClick={revealSeed}>{seedLoading ? "…" : showSeed ? "HIDE" : "REVEAL"}</button>
        </div>
        {showSeed && (
          <div style={{ marginTop: 12 }}>
            <div style={{ border: `2px solid ${T.black}`, background: T.off, padding: 12 }}>
              <div className="mp-mono" style={{ fontSize: 13, lineHeight: 1.9, wordBreak: "break-word" }}>{getSeedText() || "no seed available"}</div>
            </div>
            <button className="mp-link" style={{ marginTop: 10 }} onClick={() => { navigator.clipboard?.writeText(getSeedText()); setToast("Copied"); setTimeout(() => setToast(""), 1500); }}>TAP TO COPY</button>
          </div>
        )}
      </div>
      <div style={{ padding: 16 }}><button className="mp-btn danger" onClick={onLogout}>SIGN OUT AND SEAL</button></div>
      <div style={{ padding: "0 16px 8px", textAlign: "center" }}>
        <span className="mp-lbl-sm">SEALING ENCRYPTS YOUR WALLET ON THE SERVER. ONLY YOUR SEED REOPENS IT.</span>
      </div>
      <div style={{ padding: "8px 16px 20px", textAlign: "center" }}>
        <span onClick={onAdmin} className="mp-lbl-sm" style={{ userSelect: "none", cursor: "default", color: T.black, opacity: .5 }}>ZAIM v0.9.2</span>
      </div>
    </div>
  );
}

function NavBar({ active, onNav }) {
  const tabs = [
    { id: "home", icon: Prim.square, label: "Wallet" },
    { id: "messages", icon: Prim.triangle, label: "Message" },
    { id: "ai", icon: Prim.slash, label: "AI" },
    { id: "geo", icon: Prim.circle, label: "Geo" },
    { id: "settings", icon: Prim.diamond, label: "Settings" },
  ];
  return (
    <div className="mp-nav">
      {tabs.map(t => (
        <button key={t.id} className={`mp-nav-tab${active === t.id ? " active" : ""}`} onClick={() => onNav(t.id)}>
          {t.icon(24, "#fff")}
          <span className="mp-nav-lbl">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function ZaimApp() {
  const [authed, setAuthed] = useState(!!localStorage.getItem("zaim_token"));
  const [screen, setScreen] = useState("home"); const [chatContact, setChatContact] = useState(null);
  const [tapCount, setTapCount] = useState(0);
  const handleLogoTap = () => { const n = tapCount + 1; setTapCount(n); if (n >= 5) { setScreen("admin"); setTapCount(0); } };
  // Recovered from sessionStorage so a refresh keeps decryption working for
  // the rest of the session without ever putting the key on disk.
  const aiStoreKey = (() => {
    try {
      const raw = sessionStorage.getItem("zaim_ai_sk");
      return raw ? Uint8Array.from(raw.split(",").map(Number)) : null;
    } catch (e) { return null; }
  })();
  const nav = (s, d) => { if (s === "chat" && d) { setChatContact(d); setScreen("chat"); } else setScreen(s); };
  const logout = async () => {
    try { await API.logout(); } catch (e) { }  // seal server side, best effort
    localStorage.removeItem("zaim_token"); localStorage.removeItem("zaim_user");
    setAuthed(false); setScreen("home");
  };
  const render = () => {
    switch (screen) {
      case "home": return <HomeScreen onNav={nav} />;
      case "send": return <SendScreen onBack={() => setScreen("home")} />;
      case "request": return <RequestScreen onBack={() => setScreen("home")} />;
      case "swap": return <ZaimSwap onBack={() => setScreen("home")} />;
      case "messages": return <MessengerScreen onNav={nav} />;
      case "chat": return chatContact ? <ChatScreen contact={chatContact} onBack={() => setScreen("messages")} /> : null;
      case "geo": return <ZAIMGeoVault />;
      case "ai": return <AiTab aiReady={true} storeKey={aiStoreKey} />;
      case "settings": return <SettingsScreen onLogout={logout} onAdmin={handleLogoTap} />;
      case "admin": return <AdminDashboard onExit={() => setScreen("settings")} />;
      default: return <HomeScreen onNav={nav} />;
    }
  };
  const showNav = authed && !["send", "request", "swap", "chat", "admin"].includes(screen);
  return (
    <div className="mp mp-shell">
      <style>{MAXPAIN_CSS}</style>
      <div className="mp-frame">
        {!authed
          ? <AuthScreen onAuth={() => setAuthed(true)} />
          : <>{render()}{showNav && <NavBar active={screen} onNav={nav} />}</>}
      </div>
    </div>
  );
}
