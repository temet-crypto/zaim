import { useState, useEffect } from "react";
import { T, F } from "./styles/maxpain.js";

// ── time helpers (unchanged logic) ───────────────────────────────────────────
function parseT(str) { return str ? new Date(str) : null; }
function getTimeState(start, end, now) {
  if (!start || !end) return "active";
  const s = parseT(start), e = parseT(end);
  if (now < s) return "pending";
  if (now > e) return "expired";
  return "active";
}
function msUntil(target, now) { return Math.max(0, parseT(target) - now); }
function fmtCountdown(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const d = Math.floor(totalSec / 86400), h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return { d: String(d).padStart(2, "0"), h: String(h).padStart(2, "0"), m: String(m).padStart(2, "0"), s: String(s).padStart(2, "0") };
}
function windowPct(start, end, now) {
  const s = parseT(start), e = parseT(end);
  if (!s || !e || now < s) return 0;
  if (now > e) return 100;
  return Math.round(((now - s) / (e - s)) * 100);
}
function fmtDate(str) {
  if (!str) return "···";
  return parseT(str).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const API = {
  headers: () => ({ "Content-Type": "application/json", ...(localStorage.getItem("zaim_token") ? { Authorization: `Bearer ${localStorage.getItem("zaim_token")}` } : {}) }),
  async get(p) { const r = await fetch(`/api${p}`, { headers: this.headers() }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Failed"); return d; },
  async post(p, b) { const r = await fetch(`/api${p}`, { method: "POST", headers: this.headers(), body: JSON.stringify(b) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Failed"); return d; },
  async del(p) { const r = await fetch(`/api${p}`, { method: "DELETE", headers: this.headers() }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Failed"); return d; },
};

const STATE_META = {
  active: { c: T.teal, bg: T.teal, fg: T.black, t: "LIVE" },
  pending: { c: T.blue, bg: T.blue, fg: T.white, t: "SCHEDULED" },
  expired: { c: T.black, bg: T.black, fg: T.white, t: "EXPIRED" },
};

const BackArrow = ({ onClick }) => (
  <button onClick={onClick} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex" }} aria-label="Back">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke={T.black} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
);

function Countdown({ ms, label, big }) {
  const p = fmtCountdown(ms);
  const units = p.d !== "00" ? [["D", p.d], ["H", p.h], ["M", p.m], ["S", p.s]] : [["H", p.h], ["M", p.m], ["S", p.s]];
  const fs = big ? 34 : 24;
  return (
    <div>
      {label && <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>{label}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        {units.map(([u, v]) => (
          <div key={u} style={{ border: `2px solid ${T.black}`, padding: "6px 8px", minWidth: fs, textAlign: "center", background: T.off }}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: fs, lineHeight: 1, letterSpacing: -1 }}>{v}</div>
            <div style={{ fontFamily: F.mono, fontSize: 8, letterSpacing: 1, marginTop: 2 }}>{u}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimeWindowBar({ vault, now }) {
  const state = getTimeState(vault.timeStart, vault.timeEnd, now);
  const pct = windowPct(vault.timeStart, vault.timeEnd, now);
  const msEnd = msUntil(vault.timeEnd, now), msStart = msUntil(vault.timeStart, now);
  const fill = state === "active" ? T.teal : state === "pending" ? T.blue : T.black;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontFamily: F.mono, fontSize: 10 }}>
        <div><div style={{ fontSize: 8, letterSpacing: 1, marginBottom: 2 }}>OPENS</div><div>{fmtDate(vault.timeStart)}</div></div>
        <div style={{ textAlign: "right" }}><div style={{ fontSize: 8, letterSpacing: 1, marginBottom: 2 }}>CLOSES</div><div>{fmtDate(vault.timeEnd)}</div></div>
      </div>
      <div style={{ height: 14, border: `2px solid ${T.black}`, background: T.blueTint, position: "relative", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: fill }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: F.mono, fontSize: 9 }}>
        <span>0%</span>
        <span style={{ fontWeight: 500, letterSpacing: 1, color: fill }}>{state === "active" ? `${pct}% ELAPSED` : state === "pending" ? "NOT OPEN" : "CLOSED"}</span>
        <span>100%</span>
      </div>
      <div style={{ marginTop: 14 }}>
        {state === "active" && msEnd > 0 && <Countdown ms={msEnd} label="WINDOW CLOSES IN" big />}
        {state === "pending" && <Countdown ms={msStart} label="OPENS IN" big />}
        {state === "expired" && <div style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase" }}>Vault closed · ZEC returned to sender</div>}
      </div>
    </div>
  );
}

function Badge({ state }) {
  const s = STATE_META[state] || STATE_META.active;
  return <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 14, letterSpacing: .5, color: s.fg, background: s.bg, padding: "3px 9px", textTransform: "uppercase" }}>{s.t}</span>;
}

function VaultCard({ vault, now, onClick, onDelete }) {
  const state = getTimeState(vault.timeStart, vault.timeEnd, now);
  const isActive = state === "active", isPending = state === "pending", isExpired = state === "expired";
  const msEnd = msUntil(vault.timeEnd, now), msStart = msUntil(vault.timeStart, now);
  const pct = windowPct(vault.timeStart, vault.timeEnd, now);
  const p = fmtCountdown(isActive ? msEnd : msStart);
  const fill = isActive ? T.teal : isPending ? T.blue : T.black;
  return (
    <div className="mp-band mp-band-w" style={{ opacity: isExpired ? .55 : 1, cursor: isExpired ? "default" : "pointer" }} onClick={() => !isExpired && onClick(vault)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 22, lineHeight: 1, textTransform: "uppercase" }}>{vault.label}</div>
          <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 4, letterSpacing: .5 }}>{vault.city}</div>
        </div>
        <Badge state={state} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 22, color: T.teal, letterSpacing: -.5 }}>{vault.zec} ZEC</span>
        <span style={{ fontFamily: F.mono, fontSize: 10 }}>· {vault.radius}m</span>
        {vault.message && <span className="mp-tag blue" style={{ fontSize: 11, padding: "2px 6px" }}>MSG</span>}
        {vault.wallet && <span className="mp-tag" style={{ fontSize: 11, padding: "2px 6px" }}>GATED</span>}
      </div>
      <div style={{ height: 8, border: `2px solid ${T.black}`, background: T.blueTint, overflow: "hidden", marginBottom: 8 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: fill }} />
      </div>
      <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: .5, color: fill }}>
        {isActive && `CLOSES IN ${p.d !== "00" ? p.d + "D " : ""}${p.h}H ${p.m}M`}
        {isPending && `OPENS IN ${p.d !== "00" ? p.d + "D " : ""}${p.h}H ${p.m}M`}
        {isExpired && "WINDOW EXPIRED"}
      </div>
      {onDelete && <button onClick={e => { e.stopPropagation(); if (window.confirm("Delete this vault?")) onDelete(vault.id); }} style={{ marginTop: 12, width: "100%", padding: "9px 0", background: "transparent", border: `2px solid ${T.signout}`, color: T.signout, fontFamily: F.mono, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>DELETE VAULT</button>}
    </div>
  );
}

function PseudoMap({ vaults, now, onSelect }) {
  return (
    <div style={{ width: "100%", height: 200, background: T.off, border: `2px solid ${T.black}`, position: "relative", overflow: "hidden" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: .12 }}>
        {Array.from({ length: 8 }).map((_, i) => <line key={`h${i}`} x1="0" y1={`${i * 14}%`} x2="100%" y2={`${i * 14}%`} stroke={T.black} strokeWidth="1" />)}
        {Array.from({ length: 12 }).map((_, i) => <line key={`v${i}`} x1={`${i * 9}%`} y1="0" x2={`${i * 9}%`} y2="100%" stroke={T.black} strokeWidth="1" />)}
      </svg>
      <div style={{ position: "absolute", top: 8, left: 10, fontFamily: F.mono, fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: T.blue }}>GEOVAULT MAP</div>
      {vaults.map(v => {
        const state = getTimeState(v.timeStart, v.timeEnd, now);
        const s = STATE_META[state] || STATE_META.active;
        return (
          <div key={v.id} onClick={() => state !== "expired" && onSelect(v)} style={{ position: "absolute", left: `${v.mapX}%`, top: `${v.mapY}%`, transform: "translate(-50%,-50%)", cursor: state !== "expired" ? "pointer" : "default" }}>
            <div style={{ width: 12, height: 12, background: state === "expired" ? "transparent" : s.bg, border: `2px solid ${T.black}` }} />
          </div>
        );
      })}
      <div style={{ position: "absolute", bottom: 8, right: 10, display: "flex", gap: 12 }}>
        {[["LIVE", T.teal], ["SCHED", T.blue], ["EXPIRED", T.black]].map(([l, c]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 7, height: 7, background: c, border: `1px solid ${T.black}` }} />
            <span style={{ fontFamily: F.mono, fontSize: 8, letterSpacing: .5 }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateVault({ onBack, onCreate }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ label: "", lat: "", lng: "", radius: 50, zec: "", message: "", timeStart: "", timeEnd: "", walletMode: "any", wallet: "", locLoading: false });
  const up = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const lbl = { fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6, display: "block" };
  const STEPS = ["Location", "Time", "Payload", "Access"];
  const durMs = form.timeStart && form.timeEnd ? parseT(form.timeEnd) - parseT(form.timeStart) : 0;
  const durP = fmtCountdown(durMs > 0 ? durMs : 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="mp-head" style={{ position: "static" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BackArrow onClick={onBack} />
          <div><div className="mp-title" style={{ fontSize: 22 }}>New Vault</div><div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, marginTop: 2 }}>STEP {step + 1}/{STEPS.length} · {STEPS[step].toUpperCase()}</div></div>
        </div>
      </div>
      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        {STEPS.map((s, i) => (
          <div key={i} onClick={() => i <= step && setStep(i)} style={{ flex: 1, padding: "10px 0", textAlign: "center", borderRight: i < STEPS.length - 1 ? `2px solid ${T.black}` : "none", background: i === step ? T.blue : i < step ? T.teal : T.off, color: i === step ? T.white : T.black, cursor: i <= step ? "pointer" : "default", fontFamily: F.mono, fontSize: 11, fontWeight: 500 }}>{i < step ? "✓" : i + 1}</div>
        ))}
      </div>
      <div className="mp-scroll" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {step === 0 && <>
          <div><label style={lbl}>VAULT LABEL</label><input className="mp-input" placeholder="e.g. Tokyo Drop" value={form.label} onChange={e => up("label", e.target.value)} /></div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ ...lbl, marginBottom: 0 }}>LOCATION</label>
              <button type="button" onClick={() => {
                if (!navigator.geolocation) { alert("GPS not available"); return; }
                up("locLoading", true);
                navigator.geolocation.getCurrentPosition(
                  pos => { up("lat", pos.coords.latitude.toFixed(6)); up("lng", pos.coords.longitude.toFixed(6)); up("locLoading", false); },
                  err => { alert("Location error: " + err.message); up("locLoading", false); },
                  { enableHighAccuracy: true, timeout: 10000 }
                );
              }} style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: .5, textTransform: "uppercase", color: T.white, background: T.blue, border: `2px solid ${T.black}`, padding: "5px 9px", cursor: "pointer" }}>{form.locLoading ? "LOCATING…" : "USE MY LOCATION"}</button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="mp-input" placeholder="Latitude" value={form.lat} onChange={e => up("lat", e.target.value)} />
              <input className="mp-input" placeholder="Longitude" value={form.lng} onChange={e => up("lng", e.target.value)} />
            </div>
          </div>
          <div>
            <label style={lbl}>UNLOCK RADIUS · {form.radius}M</label>
            <input type="range" min={10} max={500} step={10} value={form.radius} onChange={e => up("radius", +e.target.value)} style={{ width: "100%", accentColor: T.blue }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.mono, fontSize: 9, marginTop: 4 }}><span>10M PRECISE</span><span>500M BROAD</span></div>
          </div>
        </>}
        {step === 1 && <>
          <div className="mp-band-blue" style={{ padding: 14, border: `2px solid ${T.black}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, color: T.white, textTransform: "uppercase", marginBottom: 4 }}>AVAILABILITY WINDOW</div>
            <div style={{ fontFamily: F.body, fontSize: 12, color: T.white, lineHeight: 1.5 }}>Only claimable inside this window. Before open → blocked. After close → ZEC returns automatically.</div>
          </div>
          <div><label style={lbl}>OPEN · START</label><input type="datetime-local" className="mp-input" style={{ colorScheme: "light" }} value={form.timeStart} onChange={e => up("timeStart", e.target.value)} /></div>
          <div><label style={lbl}>CLOSE · END</label><input type="datetime-local" className="mp-input" style={{ colorScheme: "light" }} value={form.timeEnd} onChange={e => up("timeEnd", e.target.value)} /></div>
          {form.timeStart && form.timeEnd && durMs > 0 && (
            <div className="mp-band mp-band-w" style={{ border: `2px solid ${T.black}` }}>
              <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>WINDOW DURATION</div>
              <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 30, letterSpacing: -1 }}>{durP.d !== "00" ? `${durP.d}D ` : ""}{durP.h}H {durP.m}M</div>
            </div>
          )}
        </>}
        {step === 2 && <>
          <div><label style={lbl}>ZEC AMOUNT</label><input className="mp-input" placeholder="0.0000" value={form.zec} onChange={e => up("zec", e.target.value)} /></div>
          <div>
            <label style={lbl}>ENCRYPTED MESSAGE · OPTIONAL</label>
            <textarea className="mp-input" style={{ resize: "none", height: 88, lineHeight: 1.5 }} placeholder="Revealed only at unlock via Zcash memo" value={form.message} onChange={e => up("message", e.target.value)} />
            <div style={{ fontFamily: F.mono, fontSize: 9, marginTop: 4, color: form.message.length > 490 ? T.red : T.black }}>{512 - form.message.length} BYTES REMAINING</div>
          </div>
          <div style={{ border: `2px solid ${T.black}`, background: T.blueTint, padding: 12 }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: T.blue, marginBottom: 4 }}>ESCROW + TIME LOCK</div>
            <div style={{ fontFamily: F.body, fontSize: 12, lineHeight: 1.5 }}>ZEC held in escrow until claimed. Unclaimed by {fmtDate(form.timeEnd) || "close"} → returns automatically.</div>
          </div>
        </>}
        {step === 3 && <>
          <div>
            <label style={lbl}>WALLET ACCESS</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[{ val: "any", label: "Anyone at location", desc: "First wallet in range during window claims it" }, { val: "specific", label: "Specific wallet only", desc: "Only one address can unlock" }].map(opt => (
                <div key={opt.val} onClick={() => up("walletMode", opt.val)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", background: form.walletMode === opt.val ? T.blueTint : T.white, border: `2px solid ${T.black}`, padding: "12px 14px" }}>
                  <div style={{ width: 16, height: 16, border: `2px solid ${T.black}`, background: form.walletMode === opt.val ? T.blue : "transparent", flexShrink: 0 }} />
                  <div><div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{opt.label}</div><div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 2 }}>{opt.desc}</div></div>
                </div>
              ))}
            </div>
          </div>
          {form.walletMode === "specific" && <div><label style={lbl}>TARGET WALLET</label><input className="mp-input" placeholder="zs1…" value={form.wallet} onChange={e => up("wallet", e.target.value)} /></div>}
          <div className="mp-band mp-band-w" style={{ border: `2px solid ${T.black}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>VAULT SUMMARY</div>
            {[["Label", form.label || "···"], ["Location", form.lat && form.lng ? `${(+form.lat).toFixed(4)}, ${(+form.lng).toFixed(4)}` : "···"], ["Radius", `${form.radius}m`], ["Opens", fmtDate(form.timeStart)], ["Closes", fmtDate(form.timeEnd)], ["ZEC", form.zec ? `${form.zec} ZEC` : "···"], ["Message", form.message ? `${form.message.length} bytes` : "None"], ["Access", form.walletMode === "any" ? "Open to all" : "Wallet gated"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${T.faint}`, fontFamily: F.mono, fontSize: 12 }}>
                <span>{k}</span><span style={{ color: k === "Opens" ? T.teal : k === "Closes" ? T.red : T.black }}>{v}</span>
              </div>
            ))}
          </div>
        </>}
      </div>
      <div style={{ display: "flex", borderTop: `2px solid ${T.black}` }}>
        {step > 0 && <button className="mp-btn ghost" style={{ flex: 1, border: "none", borderRight: `2px solid ${T.black}` }} onClick={() => setStep(s => s - 1)}>BACK</button>}
        <button className="mp-btn blue" style={{ flex: 2, border: "none" }} onClick={() => step < STEPS.length - 1 ? setStep(s => s + 1) : onCreate(form)}>{step < STEPS.length - 1 ? "CONTINUE" : "DEPLOY VAULT"}</button>
      </div>
    </div>
  );
}

function UnlockScreen({ vault, now, onBack }) {
  const state = getTimeState(vault.timeStart, vault.timeEnd, now);
  const [phase, setPhase] = useState(state === "active" ? "scanning" : state);
  const [gpsError, setGpsError] = useState("");
  const [userDist, setUserDist] = useState(null);
  const msEnd = msUntil(vault.timeEnd, now);
  useEffect(() => {
    if (phase !== "scanning" || state !== "active") return;
    if (!navigator.geolocation) { setGpsError("GPS not available on this device"); setPhase("error"); return; }
    const opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 };
    const onSuccess = (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const R = 6371000;
      const dLat = (vault.lat - latitude) * Math.PI / 180, dLon = (vault.lng - longitude) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(latitude * Math.PI / 180) * Math.cos(vault.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const dist = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      setUserDist(dist);
      setPhase(dist <= (vault.radius + (accuracy || 20)) ? "near" : "far");
    };
    const onError = (err) => {
      if (err.code === 1) setGpsError("Location permission denied. Enable in browser settings.");
      else if (err.code === 2) setGpsError("GPS signal unavailable. Try moving outdoors.");
      else setGpsError("Location timed out. Try again.");
      setPhase("error");
    };
    navigator.geolocation.getCurrentPosition(onSuccess, onError, opts);
  }, [phase]);
  const statusBlock = () => {
    const M = {
      scanning: { c: T.blue, t: "SCANNING LOCATION", s: "verifying GPS coordinates…" },
      near: { c: T.teal, t: "IN RANGE", s: userDist !== null ? `${userDist}m away · within ${vault.radius}m` : "within range" },
      far: { c: T.red, t: "OUT OF RANGE", s: userDist !== null ? `${userDist}m away · needs within ${vault.radius}m` : "too far from vault" },
      error: { c: T.red, t: "LOCATION ERROR", s: gpsError },
      unlocked: { c: T.teal, t: "VAULT UNLOCKED", s: "ZEC transferred to your wallet" },
    }[phase] || { c: T.blue, t: "…", s: "" };
    return (
      <div style={{ border: `2px solid ${T.black}`, background: phase === "unlocked" || phase === "near" ? T.tealTint : phase === "far" || phase === "error" ? T.redTint : T.blueTint, padding: 20, textAlign: "center" }}>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 30, letterSpacing: -1, color: M.c, textTransform: "uppercase" }}>{M.t}</div>
        <div style={{ fontFamily: F.mono, fontSize: 11, marginTop: 6, letterSpacing: .5 }}>{M.s}</div>
      </div>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="mp-head" style={{ position: "static" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><BackArrow onClick={onBack} /><div className="mp-title" style={{ fontSize: 22 }}>{vault.label}</div></div>
        <Badge state={state} />
      </div>
      <div className="mp-scroll" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="mp-band mp-band-w" style={{ border: `2px solid ${T.black}` }}>
          <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 }}>ACCESS WINDOW</div>
          <TimeWindowBar vault={vault} now={now} />
        </div>
        {state === "expired" && <div style={{ border: `2px solid ${T.black}`, background: T.redTint, padding: 20, textAlign: "center" }}><div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 26, color: T.red, textTransform: "uppercase" }}>Window Expired</div><div style={{ fontFamily: F.mono, fontSize: 11, marginTop: 6 }}>closed {fmtDate(vault.timeEnd)} · ZEC returned</div></div>}
        {state === "pending" && <div style={{ border: `2px solid ${T.black}`, background: T.blueTint, padding: 20, textAlign: "center" }}><div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 26, color: T.blue, textTransform: "uppercase" }}>Not Yet Open</div><div style={{ fontFamily: F.mono, fontSize: 11, marginTop: 6 }}>be here when the window opens · {vault.radius}m radius</div></div>}
        {state === "active" && statusBlock()}
        <div className="mp-band mp-band-w" style={{ border: `2px solid ${T.black}`, padding: 0 }}>
          <div style={{ padding: 14, borderBottom: `2px solid ${T.black}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>VAULT CONTENTS</div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 34, color: T.teal, letterSpacing: -1 }}>{vault.zec} ZEC</div>
          </div>
          {vault.message && <div style={{ padding: 14, borderBottom: `2px solid ${T.black}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>ENCRYPTED MESSAGE</div>
            {phase === "unlocked" ? <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.5, background: T.off, border: `2px solid ${T.black}`, padding: 10 }}>{vault.message}</div> : <div style={{ fontFamily: F.mono, fontSize: 14, letterSpacing: 3, color: T.black, opacity: .3 }}>████ ████████ ████ ████</div>}
          </div>}
          <div style={{ padding: 14 }}>
            {[["Location", vault.city], ["Radius", `${vault.radius}m`], ["Access", vault.wallet ? `Gated: ${vault.wallet.slice(0, 12)}…` : "Open to all"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontFamily: F.mono, fontSize: 11 }}><span>{k.toUpperCase()}</span><span>{v}</span></div>
            ))}
          </div>
        </div>
        {phase === "near" && <button className="mp-btn" onClick={() => setPhase("unlocked")}>UNLOCK VAULT</button>}
        {phase === "unlocked" && <button className="mp-btn" onClick={onBack}>DONE</button>}
        {phase === "error" && <button className="mp-btn" onClick={() => { setPhase("scanning"); setGpsError(""); }}>TRY AGAIN</button>}
        {(phase === "far" || phase === "error" || state !== "active") && <button className="mp-btn ghost" onClick={onBack}>← BACK</button>}
      </div>
    </div>
  );
}

export default function ZAIMGeoVault() {
  const [screen, setScreen] = useState("list");
  const [selected, setSelected] = useState(null);
  const [now, setNow] = useState(new Date());
  const [vaults, setVaults] = useState([]);
  const [loading, setLoading] = useState(true);
  const store = {
    list: () => { try { return JSON.parse(localStorage.getItem("zaim_geovaults") || "[]"); } catch (e) { return []; } },
    save: (v) => localStorage.setItem("zaim_geovaults", JSON.stringify(v)),
  };
  const loadVaults = async () => {
    try {
      const r = { vaults: store.list() };
      setVaults((r.vaults || []).map(v => ({
        ...v, timeStart: v.time_start, timeEnd: v.time_end,
        mapX: Math.abs(parseFloat(v.lng || 0)) % 100, mapY: Math.abs(parseFloat(v.lat || 0)) % 80,
        city: v.city || `${parseFloat(v.lat || 0).toFixed(2)}, ${parseFloat(v.lng || 0).toFixed(2)}`,
      })));
    } catch (e) { } setLoading(false);
  };
  useEffect(() => { loadVaults(); }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const activeCount = vaults.filter(v => getTimeState(v.timeStart, v.timeEnd, now) === "active").length;
  const pendCount = vaults.filter(v => getTimeState(v.timeStart, v.timeEnd, now) === "pending").length;
  const totalZec = vaults.reduce((a, v) => a + (parseFloat(v.zec) || 0), 0).toFixed(1);
  if (screen === "create") return <CreateVault onBack={() => setScreen("list")} onCreate={async (form) => {
    try {
      const all = store.list();
      all.push({ id: String(Date.now()), label: form.label || "Unnamed Vault", lat: parseFloat(form.lat) || 0, lng: parseFloat(form.lng) || 0, radius: form.radius, zec: parseFloat(form.zec) || 0, message: form.message, time_start: form.timeStart, time_end: form.timeEnd, wallet_mode: form.walletMode, wallet: form.wallet, created: new Date().toISOString(), status: "active" });
      store.save(all);
      await loadVaults();
    } catch (e) { alert("Failed to save vault: " + e.message); }
    setScreen("list");
  }} />;
  if (screen === "unlock" && selected) return <UnlockScreen vault={selected} now={now} onBack={() => { setScreen("list"); setSelected(null); }} />;
  return (
    <div className="mp-scroll">
      <div className="mp-head" style={{ position: "static" }}>
        <div className="mp-title">GeoVault</div>
        <div className="mp-meta" style={{ color: T.blue }}>ZEC DROPS</div>
      </div>
      <div className="mp-band"><PseudoMap vaults={vaults} now={now} onSelect={v => { setSelected(v); setScreen("unlock"); }} /></div>
      <div className="mp-grid">
        <div className="mp-cell"><div className="mp-cell-key">LIVE NOW</div><div className="mp-cell-val" style={{ color: T.teal }}>{activeCount}</div></div>
        <div className="mp-cell"><div className="mp-cell-key">SCHEDULED</div><div className="mp-cell-val" style={{ color: T.blue }}>{pendCount}</div></div>
      </div>
      <div className="mp-kv"><span className="mp-kv-key">TOTAL ESCROWED</span><span className="mp-kv-val" style={{ color: T.teal }}>{totalZec} ZEC</span></div>
      <div className="mp-section">YOUR VAULTS</div>
      {loading ? <div className="mp-band" style={{ textAlign: "center" }}><span className="mp-quip">Loading vaults…</span></div>
        : vaults.length === 0 ? <div className="mp-band" style={{ textAlign: "center" }}><span className="mp-quip">No vaults yet. Drop one below.</span></div>
          : vaults.map(v => <VaultCard key={v.id} vault={v} now={now} onClick={vault => { setSelected(vault); setScreen("unlock"); }} onDelete={async (id) => { store.save(store.list().filter(v => v.id !== id)); await loadVaults(); }} />)}
      <div style={{ padding: 16 }}><button className="mp-btn blue" onClick={() => setScreen("create")}>+ CREATE GEOVAULT</button></div>
    </div>
  );
}
