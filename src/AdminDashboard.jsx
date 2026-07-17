import { useState, useEffect, useCallback } from "react";
import { T, F } from "./styles/maxpain.js";

const API = "/api";
const ADMIN_TOKEN_KEY = "zaim_admin_token";
const TABS = ["Stats", "Users", "GeoVaults", "Sessions"];

export default function AdminDashboard({ onExit }) {
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [input, setInput] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState("Stats");
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [vaults, setVaults] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [msg, setMsg] = useState("");

  const headers = { "X-Admin-Token": token };

  const fetchStats = useCallback(async () => { const r = await fetch(`${API}/admin/stats`, { headers }); if (r.ok) setStats(await r.json()); }, [token]);
  const fetchUsers = useCallback(async () => { const r = await fetch(`${API}/admin/users`, { headers }); if (r.ok) { const d = await r.json(); setUsers(d.users); } }, [token]);
  const fetchVaults = useCallback(async () => { const r = await fetch(`${API}/admin/geovaults`, { headers }); if (r.ok) { const d = await r.json(); setVaults(d.geovaults); } }, [token]);
  const fetchSessions = useCallback(async () => { const r = await fetch(`${API}/admin/sessions`, { headers }); if (r.ok) { const d = await r.json(); setSessions(d.sessions); } }, [token]);

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
    if (tab === "Users") fetchUsers();
    if (tab === "GeoVaults") fetchVaults();
    if (tab === "Sessions") fetchSessions();
  }, [authed, tab]);

  const deleteUser = async (username) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    const r = await fetch(`${API}/admin/users/${username}`, { method: "DELETE", headers });
    if (r.ok) { setMsg(`Deleted ${username}`); fetchUsers(); fetchStats(); }
  };
  const deleteVault = async (id) => {
    if (!window.confirm("Delete this GeoVault?")) return;
    const r = await fetch(`${API}/admin/geovaults/${id}`, { method: "DELETE", headers });
    if (r.ok) { setMsg("Vault deleted."); fetchVaults(); fetchStats(); }
  };
  const logout = () => { localStorage.removeItem(ADMIN_TOKEN_KEY); setToken(""); setAuthed(false); setInput(""); };

  // ── Login ──
  if (!authed) return (
    <div className="mp-scroll">
      <div className="mp-band-blue" style={{ padding: "36px 16px", borderBottom: `2px solid ${T.black}` }}>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 52, lineHeight: .95, letterSpacing: -2, color: T.white, textTransform: "uppercase" }}>ZAIM<br />ADMIN</div>
        <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 2, color: T.white, marginTop: 10, textTransform: "uppercase" }}>Restricted Access</div>
      </div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="mp-lbl-sm">ADMIN PASSWORD</div>
        <input className="mp-input" type="password" placeholder="password" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && tryAuth()} />
        {authError && <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase" }}>{authError}</div>}
        <button className="mp-btn" onClick={tryAuth}>ENTER</button>
        {onExit && <button className="mp-link" onClick={onExit}>← BACK TO APP</button>}
      </div>
    </div>
  );

  const StatCell = ({ label, value }) => (
    <div className="mp-cell"><div className="mp-cell-key">{label}</div><div className="mp-cell-val" style={{ fontSize: 40 }}>{value ?? "—"}</div></div>
  );
  const DelBtn = ({ onClick }) => (
    <button onClick={onClick} style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.white, background: T.signout, border: `2px solid ${T.black}`, padding: "6px 12px", cursor: "pointer", whiteSpace: "nowrap" }}>DELETE</button>
  );

  // ── Dashboard ──
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

      {tab === "Stats" && stats && (
        <div className="mp-grid">
          <StatCell label="Total Users" value={stats.total_users} />
          <StatCell label="GeoVaults" value={stats.total_geovaults} />
          <StatCell label="Contacts" value={stats.total_contacts} />
          <StatCell label="Sessions" value={stats.active_sessions} />
          <StatCell label="Cached Wallets" value={stats.cached_wallets} />
        </div>
      )}

      {tab === "Users" && (<>
        <div className="mp-section">{users.length} USERS</div>
        {users.map(u => (
          <div key={u.username} className="mp-band" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, textTransform: "uppercase" }}>{u.username}</span>
                {u.is_admin && <span className="mp-tag teal">ADMIN</span>}
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 6 }}>{u.geovault_count} VAULTS · {u.contact_count} CONTACTS</div>
              <div className="mp-mono" style={{ fontSize: 10, marginTop: 6 }}>z: {u.z_address || "—"}</div>
              <div className="mp-mono" style={{ fontSize: 10, marginTop: 3 }}>t: {u.t_address || "—"}</div>
            </div>
            <DelBtn onClick={() => deleteUser(u.username)} />
          </div>
        ))}
      </>)}

      {tab === "GeoVaults" && (<>
        <div className="mp-section">{vaults.length} GEOVAULTS</div>
        {vaults.map(v => (
          <div key={v.id} className="mp-band" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, textTransform: "uppercase" }}>{v.label}</span>
                <span className="mp-tag teal">{v.zec} ZEC</span>
                <span className="mp-tag blue">{v.status}</span>
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 6 }}>OWNER: {v.owner} · {v.lat}, {v.lng} · {v.radius}m</div>
              {v.message && <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 4, color: T.blue }}>MSG: {v.message}</div>}
            </div>
            <DelBtn onClick={() => deleteVault(v.id)} />
          </div>
        ))}
      </>)}

      {tab === "Sessions" && (<>
        <div className="mp-section">{sessions.length} ACTIVE SESSIONS</div>
        {sessions.map((s, i) => (
          <div key={i} className="mp-kv">
            <span className="mp-kv-key" style={{ color: T.blue }}>{s.session_id}</span>
            <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 14 }}>{s.user_id}</span>
            <span style={{ fontFamily: F.mono, fontSize: 10 }}>{s.created?.slice(0, 16).replace("T", " ")}</span>
          </div>
        ))}
      </>)}
      <div style={{ height: 20 }} />
    </div>
  );
}
