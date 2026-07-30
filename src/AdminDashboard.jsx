import { useState, useEffect, useCallback } from "react";
import { T, F } from "./styles/maxpain.js";

// Ops panel, reachable by five taps on the version line in Settings. Strictly
// read plus two levers: seal every wallet, and read the escrow seed for backup.
// There are no accounts to administer; the seed is the account.

const API = "/api";
const ADMIN_TOKEN_KEY = "zaim_admin_token";
const TABS = ["Stats", "Vaults", "Sessions", "Escrow"];

export default function AdminDashboard({ onExit }) {
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [input, setInput] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState("Stats");
  const [stats, setStats] = useState(null);
  const [vaults, setVaults] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [escrow, setEscrow] = useState(null);
  const [seed, setSeed] = useState("");
  const [msg, setMsg] = useState("");

  const headers = { "X-Admin-Token": token };
  const say = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };

  const fetchStats = useCallback(async () => { const r = await fetch(`${API}/admin/stats`, { headers }); if (r.ok) setStats(await r.json()); }, [token]);
  const fetchVaults = useCallback(async () => { const r = await fetch(`${API}/admin/geovaults`, { headers }); if (r.ok) setVaults((await r.json()).geovaults || []); }, [token]);
  const fetchSessions = useCallback(async () => { const r = await fetch(`${API}/admin/sessions`, { headers }); if (r.ok) setSessions((await r.json()).sessions || []); }, [token]);
  const fetchEscrow = useCallback(async () => { const r = await fetch(`${API}/admin/escrow`, { headers }); if (r.ok) setEscrow(await r.json()); }, [token]);

  const tryAuth = async () => {
    setAuthError("");
    const r = await fetch(`${API}/admin/stats`, { headers: { "X-Admin-Token": input } });
    if (r.ok) { setToken(input); localStorage.setItem(ADMIN_TOKEN_KEY, input); setAuthed(true); }
    else setAuthError("Invalid admin password.");
  };

  useEffect(() => { if (token) fetch(`${API}/admin/stats`, { headers }).then(r => { if (r.ok) setAuthed(true); }); }, []);
  useEffect(() => {
    if (!authed) return;
    fetchStats();
    if (tab === "Vaults") fetchVaults();
    if (tab === "Sessions") fetchSessions();
    if (tab === "Escrow") fetchEscrow();
  }, [authed, tab]);

  const sealAll = async () => {
    if (!window.confirm("Seal every open wallet and drop all sessions? Every user signs in again with their seed.")) return;
    const r = await fetch(`${API}/admin/seal_all`, { method: "POST", headers });
    if (r.ok) { const d = await r.json(); say(`Sealed ${d.sealed.length}, plaintext left ${d.left_plaintext.length}`); fetchStats(); }
    else say("Seal failed");
  };
  const revealSeed = async () => {
    if (seed) { setSeed(""); return; }
    if (!window.confirm("Show the escrow seed on screen? Anyone who reads it controls every vaulted coin.")) return;
    const r = await fetch(`${API}/admin/escrow?reveal_seed=true`, { headers });
    if (r.ok) { const d = await r.json(); setSeed(d.seed || d.seed_error || "unavailable"); }
  };
  const logout = () => { localStorage.removeItem(ADMIN_TOKEN_KEY); setToken(""); setAuthed(false); setInput(""); };

  if (!authed) return (
    <div className="mp-scroll">
      <div className="mp-band-blue" style={{ padding: "36px 16px", borderBottom: `2px solid ${T.black}` }}>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 52, lineHeight: .95, letterSpacing: -2, color: T.white, textTransform: "uppercase" }}>ZAIM<br />ADMIN</div>
        <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 2, color: T.white, marginTop: 10, textTransform: "uppercase" }}>Restricted Access</div>
      </div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="mp-lbl-sm">ADMIN PASSWORD</div>
        <input className="mp-input" type="password" placeholder="Password" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && tryAuth()} />
        {authError && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase" }}>{authError}</div>}
        <button className="mp-btn" onClick={tryAuth}>ENTER</button>
        {onExit && <button className="mp-link" onClick={onExit}>← BACK TO APP</button>}
      </div>
    </div>
  );

  const StatCell = ({ label, value }) => (
    <div className="mp-cell"><div className="mp-cell-key">{label}</div><div className="mp-cell-val" style={{ fontSize: 40 }}>{value ?? "···"}</div></div>
  );
  const fmtT = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "···";

  return (
    <div className="mp-scroll">
      <div className="mp-head" style={{ position: "static" }}>
        <div className="mp-title">Admin</div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {msg && <span style={{ fontFamily: F.mono, fontSize: 10, color: T.teal, textTransform: "uppercase" }}>{msg}</span>}
          <button className="mp-link" onClick={logout}>LOGOUT</button>
          {onExit && <button className="mp-link" onClick={onExit} style={{ color: T.black }}>EXIT</button>}
        </div>
      </div>
      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        {TABS.map((t, i) => (
          <div key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "12px 0", textAlign: "center", cursor: "pointer", fontFamily: F.mono, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", borderRight: i < TABS.length - 1 ? `2px solid ${T.black}` : "none", background: tab === t ? T.blue : T.off, color: tab === t ? T.white : T.black }}>{t}</div>
        ))}
      </div>

      {tab === "Stats" && stats && (<>
        <div className="mp-grid">
          <StatCell label="Open Wallets" value={Array.isArray(stats.wallets_active) ? stats.wallets_active.length : stats.wallets_active} />
          <StatCell label="Sealed" value={stats.wallets_sealed} />
          <StatCell label="Sessions" value={stats.active_sessions} />
          <StatCell label="Swaps Open" value={stats.swaps_open} />
        </div>
        <div style={{ padding: 16 }}>
          <button className="mp-btn danger" onClick={sealAll}>SEAL ALL WALLETS NOW</button>
        </div>
        <div style={{ padding: "0 16px 16px", textAlign: "center" }}>
          <span className="mp-lbl-sm">EVERY OPEN WALLET IS ENCRYPTED AND EVERY SESSION DROPPED. FOR MAINTENANCE WINDOWS.</span>
        </div>
      </>)}

      {tab === "Vaults" && (<>
        <div className="mp-section">{vaults.length} GEOVAULTS · ALL TIME</div>
        {vaults.length === 0 && <div className="mp-band" style={{ textAlign: "center" }}><span className="mp-quip">No vaults yet.</span></div>}
        {vaults.map(v => (
          <div key={v.id} className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, textTransform: "uppercase" }}>{v.label}</span>
              <span className="mp-tag teal">{v.zec} ZEC</span>
              <span className="mp-tag blue">{v.status}</span>
              {v.gated && <span className="mp-tag">GATED</span>}
              {v.status === "review" && <span className="mp-tag red">NEEDS A HUMAN</span>}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 10 }}>{v.lat.toFixed(4)}, {v.lng.toFixed(4)} · {v.radius}m · {fmtT(v.opens_at)} → {fmtT(v.closes_at)} · {v.attempts} claim attempts</div>
            <div style={{ fontFamily: F.mono, fontSize: 9, wordBreak: "break-all", opacity: .7 }}>
              {v.fund_txid && <>FUND {v.fund_txid}<br /></>}
              {v.claim_txid && <>CLAIM {v.claim_txid}<br /></>}
              {v.refund_txid && <>REFUND {v.refund_txid}</>}
            </div>
          </div>
        ))}
      </>)}

      {tab === "Sessions" && (<>
        <div className="mp-section">{sessions.length} ACTIVE SESSIONS</div>
        {sessions.map((s, i) => (
          <div key={i} className="mp-kv">
            <span className="mp-kv-key" style={{ color: T.blue }}>{s.session_id}</span>
            <span style={{ fontFamily: F.mono, fontSize: 11 }}>{s.wallet_name}</span>
            <span style={{ fontFamily: F.mono, fontSize: 10 }}>{s.created?.slice(0, 16).replace("T", " ")}</span>
          </div>
        ))}
      </>)}

      {tab === "Escrow" && (<>
        <div className="mp-section">VAULT ESCROW WALLET</div>
        {!escrow ? <div className="mp-band"><span className="mp-quip">Loading…</span></div> : (<>
          <div className="mp-grid">
            <StatCell label="Owed To Vaults" value={`${escrow.owed_zec} ZEC`} />
            <StatCell label="Confirmed Held" value={`${(((escrow.balance || {}).confirmed_orchard_balance || 0) + ((escrow.balance || {}).confirmed_sapling_balance || 0) + ((escrow.balance || {}).confirmed_transparent_balance || 0)) / 1e8} ZEC`} />
          </div>
          <div className="mp-band mp-band-w">
            <div className="mp-lbl-sm" style={{ marginBottom: 6, color: T.blue }}>ESCROW ADDRESS</div>
            <div className="mp-mono">{escrow.address || "···"}</div>
            <div className="mp-lbl-sm" style={{ margin: "12px 0 6px", color: T.blue }}>VAULTS BY STATUS</div>
            <div className="mp-mono">{Object.entries(escrow.vaults || {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "none"}</div>
          </div>
          <div className="mp-band" style={{ background: T.redTint }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span className="mp-lbl-sm">ESCROW SEED · THE ONLY RECOVERY IF THIS BOX DIES</span>
              <button className="mp-link" style={{ color: T.signout }} onClick={revealSeed}>{seed ? "HIDE" : "REVEAL"}</button>
            </div>
            {seed && <div className="mp-mono" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>{seed}</div>}
          </div>
        </>)}
      </>)}
      <div style={{ height: 20 }} />
    </div>
  );
}
