// Moving funds from Orchard to Ironwood (NU6.3, ZIP 318).
//
// Modeled on Zodl's flow, because it is the one most Zcash users will have
// seen: two choices, a plan reviewed before anything moves, progress as
// "transfer N of M", and the address stays the same.
//
// What this screen must say plainly:
//   1. The private path is slow on purpose. Fixed-size transfers spread over
//      time are what make them look like everyone else's.
//   2. It only advances while the wallet is open. Keeping this screen open is
//      the equivalent of Zodl's "keep the app open".
//   3. Anything too small to move stays behind, and we show how much.

import { useCallback, useEffect, useState } from "react";
import { T, F } from "./styles/maxpain.js";
import { apiGet, apiPost } from "./api.js";
import { takeSeed, canSpend, holdSeed } from "./ai/spendkey.js";

const zec = (zats) => ((zats || 0) / 1e8).toFixed(4);

function when(unix) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const mins = Math.round((d - Date.now()) / 60000);
  if (mins <= 1) return "any moment";
  if (mins < 90) return `in about ${mins} minutes`;
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Row({ k, v, color }) {
  return (
    <div className="mp-kv">
      <span className="mp-kv-key">{k}</span>
      <span className="mp-kv-val mono" style={{ color: color || T.black }}>{v}</span>
    </div>
  );
}

function Choice({ title, tag, body, onClick, primary }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left", cursor: "pointer",
      background: primary ? T.teal : T.white, color: T.black,
      border: "none", borderBottom: `2px solid ${T.black}`, padding: "16px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, textTransform: "uppercase" }}>{title}</span>
        {tag && <span className="mp-lbl-sm">{tag}</span>}
      </div>
      <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.5, marginTop: 6 }}>{body}</div>
    </button>
  );
}

export default function Ironwood({ onBack }) {
  const [status, setStatus] = useState(null);
  const [plan, setPlan] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [seedIn, setSeedIn] = useState("");

  const refresh = useCallback(async () => {
    try { setStatus(await apiGet("/migration/status")); } catch (e) { setErr(e.message); }
  }, []);

  // Polling does double duty: fresh progress, and the activity that keeps the
  // wallet open so the next window's transfers can be signed.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const needsSeed = status?.view_only && !status?.unlocked && !canSpend();
  const seed = () => {
    if (!status?.view_only || status?.unlocked) return "";
    const s = takeSeed() || seedIn.trim();
    if (s) holdSeed(s);
    return s;
  };

  const review = async (mode) => {
    setBusy(true); setErr(""); setPlan(null);
    try {
      setPlan(await apiPost("/migration/plan", { mode, seed_phrase: seed() }));
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const confirm = async () => {
    setBusy(true); setErr("");
    try {
      const r = await apiPost("/migration/start", { mode: plan.mode, plan_hash: plan.plan_hash || "", seed_phrase: seed() });
      if (r.mode === "immediate") setDone(r);
      setPlan(null);
      await refresh();
    } catch (e) {
      // A changed wallet invalidates the hash; plan again rather than guess.
      setErr(e.message);
      setPlan(null);
    }
    setBusy(false);
  };

  const cancel = async () => {
    setBusy(true); setErr("");
    try { await apiPost("/migration/cancel", {}); await refresh(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const head = (
    <div className="mp-head">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke={T.black} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="mp-title">Ironwood</div>
      </div>
      <div className="mp-meta" style={{ color: T.blue }}>NU6.3</div>
    </div>
  );

  const errBand = err && (
    <div className="mp-band" style={{ background: T.red, color: T.white, fontFamily: F.body, fontSize: 14 }}>{err}</div>
  );

  if (!status) return <div className="mp-scroll">{head}{errBand}<div className="mp-band"><span className="mp-quip">Checking your wallet…</span></div></div>;

  // Immediate path finished.
  if (done) return (
    <div className="mp-scroll">{head}
      <div className="mp-band" style={{ background: T.teal }}>
        <div className="mp-lbl" style={{ marginBottom: 8 }}>SENT TO IRONWOOD</div>
        <div className="mp-big" style={{ fontSize: 40 }}>{zec(done.migrated_zats)}</div>
        <div className="mp-lbl-sm" style={{ marginTop: 6 }}>ZEC, NETWORK FEE {zec(done.fee_zats)}</div>
      </div>
      <div className="mp-band"><div className="mp-quip-sm">It shows in your balance once the network confirms it, usually within a few minutes.</div></div>
      {done.txids.map((t) => <div key={t} className="mp-band mp-band-w"><div className="mp-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{t}</div></div>)}
    </div>
  );

  // Private path in progress.
  if (status.active && status.mode === "private") {
    const total = status.parts_total || 0;
    const sent = status.parts_confirmed || 0;
    const pct = status.value_total ? Math.round(100 * (status.value_migrated || 0) / status.value_total) : 0;
    const splitting = String(status.phase || "").startsWith("note splitting") || status.phase === "planned";
    return (
      <div className="mp-scroll">{head}{errBand}
        <div className="mp-band" style={{ paddingTop: 20, paddingBottom: 18 }}>
          <div className="mp-lbl" style={{ marginBottom: 10 }}>{splitting ? "PREPARING" : "TRANSFERS, MOVING PRIVATELY"}</div>
          <div className="mp-big" style={{ fontSize: 44 }}>{splitting ? "Step 1 of 2" : `${sent} of ${total} done`}</div>
          <div className="mp-lbl-sm" style={{ marginTop: 10 }}>{pct}% MOVED</div>
          <div style={{ height: 10, border: `2px solid ${T.black}`, marginTop: 10 }}>
            <div style={{ height: "100%", width: `${pct}%`, background: T.teal }} />
          </div>
        </div>
        <Row k="Moved" v={`${zec(status.value_migrated)} of ${zec(status.value_total)} ZEC`} />
        <Row k="Left in Orchard" v={`${zec(status.orchard_zats)} ZEC`} />
        {status.next_window_unix && <Row k="Next transfer" v={when(status.next_window_unix)} color={T.blue} />}
        {status.finish_by_unix && <Row k="Done by" v={when(status.finish_by_unix)} />}
        <div className="mp-band">
          <div className="mp-quip-sm">
            {splitting
              ? "First your balance is reshaped into standard sizes. Nothing leaves your wallet in this step."
              : "Each transfer is a standard size, sent at a scheduled time, so it looks like everyone else's."}
            {" "}Keep this screen open. Transfers are signed when their time comes, and that needs your wallet open.
          </div>
        </div>
        <button className="mp-btn ghost" disabled={busy} onClick={cancel} style={{ borderTop: `2px solid ${T.black}` }}>STOP MIGRATING</button>
      </div>
    );
  }

  // Nothing to move.
  if (!status.needed) return (
    <div className="mp-scroll">{head}{errBand}
      <div className="mp-band">
        <div className="mp-quip">Nothing to move.</div>
        <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.5, marginTop: 10 }}>
          {status.orchard_zats > 0
            ? `${zec(status.orchard_zats)} ZEC is still in Orchard, which is too little to be worth a transfer fee. It stays spendable there.`
            : "Your shielded funds are already in Ironwood. New funds arrive there automatically."}
        </div>
      </div>
    </div>
  );

  // Review a plan.
  if (plan) {
    const priv = plan.mode === "private";
    return (
      <div className="mp-scroll">{head}{errBand}
        <div className="mp-section">{priv ? "PRIVATE MIGRATION PLAN" : "IMMEDIATE MIGRATION PLAN"}</div>
        <Row k="Moves" v={`${zec(plan.migrated_zats)} ZEC`} color={T.teal} />
        <Row k="Transfers" v={priv ? `${plan.transfers}, spread over time` : `${plan.transfers}, now`} />
        {priv && plan.prep_transactions > 0 && <Row k="Preparation" v={`${plan.prep_transactions} to yourself`} />}
        <Row k={priv ? "Fees, estimated" : "Network fee"} v={`${zec(plan.fee_zats)} ZEC`} />
        {plan.stranded_zats > 0 && <Row k="Stays in Orchard" v={`${zec(plan.stranded_zats)} ZEC`} />}
        <div className="mp-band">
          <div className="mp-quip-sm">
            {priv
              ? "Smaller balances finish in a few hours. Larger ones are spread over a longer window on purpose. Keep this screen open while it runs."
              : "One transfer, right away. The amount is visible on chain and can be linked to this wallet."}
            {plan.stranded_zats > 0 && " What stays in Orchard is too small to move and remains spendable."}
            {" "}Your address does not change.
          </div>
        </div>
        <button className="mp-btn display blue" disabled={busy} onClick={confirm}>{busy ? "STARTING…" : "CONFIRM AND START"}</button>
        <button className="mp-btn ghost" disabled={busy} onClick={() => setPlan(null)} style={{ borderTop: `2px solid ${T.black}` }}>BACK</button>
      </div>
    );
  }

  // Choose a path.
  return (
    <div className="mp-scroll">{head}{errBand}
      <div className="mp-band" style={{ paddingTop: 20, paddingBottom: 18 }}>
        <div className="mp-lbl" style={{ marginBottom: 10 }}>IN ORCHARD</div>
        <div className="mp-big" style={{ fontSize: 44 }}>{zec(status.orchard_zats)}</div>
        <div className="mp-lbl-sm" style={{ marginTop: 6 }}>ZEC TO MOVE</div>
      </div>
      <div className="mp-band">
        <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.55 }}>
          Zcash moved shielded funds to a new pool, Ironwood, on July 28, 2026. Orchard no longer takes
          new payments, so these funds need to move. Your address stays the same.
        </div>
      </div>
      {needsSeed && (
        <div className="mp-band mp-band-w">
          <div className="mp-lbl-sm" style={{ marginBottom: 6, color: T.blue }}>YOUR SEED</div>
          <div style={{ fontFamily: F.body, fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
            You signed in with a viewing key, which can read but not move funds. Moving them needs your
            seed, the same as sending. It is used for this and not stored.
          </div>
          <textarea className="mp-input" rows={3} value={seedIn} onChange={(e) => setSeedIn(e.target.value)}
            placeholder="24 words" autoComplete="off" spellCheck={false} style={{ width: "100%" }} />
        </div>
      )}
      <div className="mp-section">CHOOSE HOW</div>
      <Choice primary title="Private" tag="RECOMMENDED" onClick={() => !busy && review("private")}
        body="Several standard size transfers spread over time, so they blend in with everyone else's. Hours for small balances, longer for large ones." />
      <Choice title="Immediate" onClick={() => !busy && review("immediate")}
        body="Everything in one transfer, now. Fastest, but the amount is visible on chain and links to this wallet." />
      {busy && <div className="mp-band"><span className="mp-quip-sm">Working out the plan…</span></div>}
    </div>
  );
}
