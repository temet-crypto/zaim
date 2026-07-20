import ZAIMGeoVault from "./GeoVault.jsx";
import ZaimSwap from "./Swap.jsx";
import { useState, useEffect, useRef, useCallback } from "react";
import AdminDashboard from "./AdminDashboard";
import { T, F, MAXPAIN_CSS } from "./styles/maxpain.js";

// four geometric primitives for the bottom nav (icon always white)
const Prim = {
  square: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" fill={c} /></svg>,
  triangle: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M5 8h14l-7 10z" fill={c} /></svg>,
  circle: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill={c} /></svg>,
  diamond: (s = 26, c = "#fff") => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M12 4l8 8-8 8-8-8z" fill={c} /></svg>,
};

const API = {
  token: () => localStorage.getItem("zaim_token"),
  headers: () => ({ "Content-Type": "application/json", ...(localStorage.getItem("zaim_token") ? { Authorization: `Bearer ${localStorage.getItem("zaim_token")}` } : {}) }),
  async post(p, b) { const r = await fetch(`/api${p}`, { method: "POST", headers: this.headers(), body: JSON.stringify(b) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Failed"); return d; },
  async get(p) { const r = await fetch(`/api${p}`, { headers: this.headers() }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Failed"); return d; },
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
};

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
  const [price, setPrice] = useState(null);
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
      if (res.seed) setSeed(typeof res.seed === "string" ? res.seed : (res.seed.seed || JSON.stringify(res.seed)));
      else onAuth();
    } catch (e) { setError(e.message); }
    setLoading(false); setRestoring(false);
  };
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
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>SEED PHRASE · YOUR ONLY KEY</div>
            <textarea className="mp-input" rows={4} value={seedIn} onChange={e => setSeedIn(e.target.value)} placeholder="Paste your 24 words" style={{ resize: "none", fontFamily: F.mono, fontSize: 13, lineHeight: 1.6 }} />
          </div>
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>BIRTHDAY HEIGHT · OPTIONAL</div>
            <input className="mp-input" type="number" value={birthday} onChange={e => setBirthday(e.target.value)} placeholder="Speeds up a first restore" />
          </div>
          {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
          <button className="mp-btn" onClick={submit} disabled={loading}>{loading ? (restoring ? "OPENING… A FIRST RESTORE CAN TAKE MINUTES" : "…") : "OPEN WALLET"}</button>
          <div className="mp-lbl-sm" style={{ textAlign: "center" }}>NO USERNAME. NO PASSWORD. THE SEED IS THE ACCOUNT.</div>
        </div>
      ) : (
        <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="mp-quip">A fresh wallet with a fresh seed. You will be shown the 24 words once. Save them like money, because they are.</div>
          {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
          <button className="mp-btn" onClick={submit} disabled={loading}>{loading ? "CREATING…" : "CREATE NEW WALLET"}</button>
        </div>
      )}
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
        <div className="mp-lbl" style={{ marginBottom: 10 }}>SHIELDED BALANCE · ALL</div>
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
        <button className="mp-btn" style={{ borderRight: `2px solid ${T.black}`, borderLeft: "none", borderTop: "none", borderBottom: "none" }} onClick={() => onNav("send")}>SEND</button>
        <button className="mp-btn" style={{ borderRight: `2px solid ${T.black}`, borderLeft: "none", borderTop: "none", borderBottom: "none", background: T.blue }} onClick={() => onNav("swap")}>SWAP</button>
        <button className="mp-btn ghost" style={{ border: "none" }} onClick={() => { if (address) { navigator.clipboard?.writeText(address); setToast("Address copied"); setTimeout(() => setToast(""), 1800); } }}>COPY</button>
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
        tx.memo = tx.memo || (Array.isArray(tx.memos) && tx.memos.length ? tx.memos[0] : "");
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
        <div className="mp-lbl" style={{ color: T.white, marginTop: 12 }}>ZEC SENT</div>
      </div>
      <div className="mp-band"><div className="mp-quip">Shielded and on its way.</div></div>
      <div style={{ padding: 16 }}><button className="mp-btn" onClick={onBack}>DONE</button></div>
    </div>
  );
  return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={onBack} /><div className="mp-title">Send ZEC</div></div></div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>TO ADDRESS</div><input className="mp-input" value={to} onChange={e => setTo(e.target.value)} placeholder="Shielded or unified address" /></div>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>AMOUNT · ZEC</div><input className="mp-input" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0000" /></div>
        <div><div className="mp-lbl-sm" style={{ marginBottom: 6 }}>MEMO · OPTIONAL</div><input className="mp-input" value={memo} onChange={e => setMemo(e.target.value)} placeholder="Encrypted memo on the chain" /></div>
        {error && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>{error}</div>}
        <button className="mp-btn" onClick={send} disabled={loading}>{loading ? "SENDING…" : "SEND"}</button>
      </div>
    </div>
  );
}

function MessengerScreen({ onNav }) {
  const [contacts, setContacts] = useState([]); const [showAdd, setShowAdd] = useState(false);
  const [nn, setNn] = useState(""); const [na, setNa] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { setContacts(Contacts.list()); }, []);
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
  useEffect(() => { API.getMessages().then(r => { setMessages((r.messages || []).filter(m => m.memo)); }).catch(() => { }); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const sendMsg = async () => {
    if (!input.trim()) return; setSending(true);
    try { await API.sendMessage(contact.address, input.trim()); setMessages(p => [...p, { memo: input.trim(), amount: 0.0001, txid: "pending", sent: true }]); setInput(""); setToast("Sent"); setTimeout(() => setToast(""), 2500); }
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
        {messages.length === 0 && <div style={{ textAlign: "center", padding: "32px 0" }}><span className="mp-quip">Send a message as a shielded memo. 0.0001 ZEC each.</span></div>}
        {messages.map((m, i) => {
          const me = m.sent;
          return (
            <div key={i} style={{ marginBottom: 12, display: "flex", justifyContent: me ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "82%", padding: "10px 12px", border: `2px solid ${T.black}`, background: me ? T.blue : T.white, color: me ? T.white : T.black }}>
                <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.45 }}>{m.memo}</div>
                <div style={{ fontFamily: F.mono, fontSize: 9, marginTop: 5, letterSpacing: .5, textTransform: "uppercase", opacity: .8 }}>{m.txid === "pending" ? "PENDING" : m.height ? `BLOCK ${m.height}` : ""}{m.amount ? ` · ${m.amount} ZEC` : ""}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div style={{ borderTop: `2px solid ${T.black}`, background: T.off }}>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !sending && sendMsg()} placeholder="Type a message…" style={{ flex: 1, fontFamily: F.mono, fontSize: 14, padding: 14, background: T.white, border: "none", borderRight: `2px solid ${T.black}`, color: T.black, outline: "none" }} />
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
  useEffect(() => { API.health().then(setHealth).catch(() => { }); }, []);
  const revealSeed = async () => {
    if (seed) { setShowSeed(!showSeed); return; }
    setSeedLoading(true);
    try { const r = await API.getSeed(); setSeed(r); setShowSeed(true); }
    catch (e) { setToast("Could not retrieve seed"); setTimeout(() => setToast(""), 2500); }
    setSeedLoading(false);
  };
  const getSeedText = () => { if (!seed) return ""; if (typeof seed === "string") return seed; if (seed.seed) return seed.seed; if (seed.raw) return seed.raw; return JSON.stringify(seed); };
  const conn = health?.status === "ok";
  const srv = health?.server ? health.server.replace("https://", "").replace("http://", "").split(":")[0] : "···";
  const KV = ({ k, v, color }) => (<div className="mp-kv"><span className="mp-kv-key">{k}</span><span className="mp-kv-val" style={{ color: color || T.black }}>{v}</span></div>);
  const KVm = ({ k, v, color }) => (<div className="mp-kv"><span className="mp-kv-key">{k}</span><span className="mp-kv-val mono" style={{ color: color || T.black }}>{v}</span></div>);
  return (
    <div className="mp-scroll">
      <Toast msg={toast} type="error" />
      <ScreenHead title="Settings" meta="ZAIM" />
      <div className="mp-section">NETWORK</div>
      <KV k="Status" v={conn ? "ONLINE" : "OFFLINE"} color={conn ? T.teal : T.red} />
      <KVm k="Server" v={srv} />
      <KVm k="Protocol" v="Shielded · Sapling" color={T.blue} />
      <KVm k="Network" v="Zcash Mainnet" />
      <div className="mp-section">SECURITY</div>
      <KV k="Encryption" v="E2E SHIELDED" color={T.teal} />
      <KVm k="Key Storage" v="Server side · custodial" />
      <KV k="Memo Privacy" v="ON-CHAIN" color={T.teal} />
      <KVm k="Address Type" v="z address · shielded" />
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
        <span onClick={onAdmin} className="mp-lbl-sm" style={{ userSelect: "none", cursor: "default", color: T.black, opacity: .5 }}>ZAIM v0.9.0</span>
      </div>
    </div>
  );
}

function NavBar({ active, onNav }) {
  const tabs = [
    { id: "home", icon: Prim.square, label: "Wallet" },
    { id: "messages", icon: Prim.triangle, label: "Message" },
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
      case "swap": return <ZaimSwap onBack={() => setScreen("home")} />;
      case "messages": return <MessengerScreen onNav={nav} />;
      case "chat": return chatContact ? <ChatScreen contact={chatContact} onBack={() => setScreen("messages")} /> : null;
      case "geo": return <ZAIMGeoVault />;
      case "settings": return <SettingsScreen onLogout={logout} onAdmin={handleLogoTap} />;
      case "admin": return <AdminDashboard onExit={() => setScreen("settings")} />;
      default: return <HomeScreen onNav={nav} />;
    }
  };
  const showNav = authed && !["send", "swap", "chat", "admin"].includes(screen);
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
