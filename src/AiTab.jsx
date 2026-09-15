// The AI tab. Phase 2: real AI account (derived seed, real balance, real
// top-ups) with a MOCKED relay until Phase 3 deploys one — the mode is
// decided by /api/ai/quote's relay_configured flag and labeled loudly.
//
// Privacy posture, stated where the user can see it: anonymous to the relay
// and the AI provider; the ZAIM server can see that this account used AI,
// not what was asked. That is the truth of a server-side wallet, and we say
// it rather than imply more.

import { useEffect, useRef, useState } from "react";
import { T, F } from "./styles/maxpain.js";
import { apiGet, apiPost } from "./api.js";
import { buildRequest, hex, TYPE, MEMO_MAX } from "./ai/protocol.js";
import { convHash, newConvSecret, ZERO_CONV } from "./ai/derive.js";

const b64 = (u8) => btoa(String.fromCharCode(...u8));

const Lbl = ({ children, style }) => (
  <div className="mp-lbl-sm" style={style}>{children}</div>
);

export default function AiTab({ aiReady, storeKey }) {
  const [quote, setQuote] = useState(null);
  const [balance, setBalance] = useState(null);
  const [msgs, setMsgs] = useState([]);          // {role, text, status}
  const [input, setInput] = useState("");
  const [convSecret, setConvSecret] = useState(() => newConvSecret());
  const [sheet, setSheet] = useState(false);
  const [topup, setTopup] = useState(false);
  const [topupAmt, setTopupAmt] = useState("0.005");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  const say = (m) => { setToast(m); setTimeout(() => setToast(""), 2600); };
  const refresh = () => {
    apiGet("/ai/quote").then(setQuote).catch(() => {});
    if (aiReady) apiGet("/ai/balance").then((r) => setBalance(r.balance)).catch(() => {});
  };
  useEffect(refresh, [aiReady]);
  useEffect(() => { scroller.current?.scrollTo(0, 1e9); }, [msgs]);

  const mock = !quote?.relay_configured;
  const spendable = balance?.spendable_orchard_balance ?? balance?.orchard_balance ?? 0;
  const totalZats = quote?.total_zats ?? 0;

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    setSheet(false);
    setBusy(true);
    setInput("");
    const mine = { role: "user", text: q, status: "sending" };
    const reply = { role: "ai", text: "", status: "sending" };
    setMsgs((m) => [...m, mine, reply]);
    const set = (patch) => setMsgs((m) => m.map((x) => (x === reply ? Object.assign(reply, patch) && reply : x)).slice());

    try {
      if (mock) {
        // Preview mode: full client pipeline runs (derive address, build and
        // encrypt the request) against a throwaway key, nothing broadcast.
        const fakeRelayPk = crypto.getRandomValues(new Uint8Array(32));
        const { memos, ephSk } = await buildRequest({ question: q, convHash: convHash(convSecret), replyAddr: "utest1preview", relayPk: fakeRelayPk });
        ephSk.fill(0);
        mine.status = "confirmed";
        set({ status: "thinking" });
        await new Promise((r) => setTimeout(r, 1800));
        set({
          status: "answered",
          text: `PREVIEW — no relay is deployed yet, so nothing left this device.\n\nYour question was compressed, sealed, and packed into ${memos.length} shielded memo${memos.length > 1 ? "s" : ""} (${memos.reduce((n, m) => n + m.length, 0)} bytes of ${MEMO_MAX * memos.length} capacity). When the relay ships, this exact payload rides a real shielded transaction and the answer comes back encrypted to a key that only this browser holds.`,
        });
      } else {
        if (spendable < totalZats) throw new Error("AI balance too low. Top up first");
        const addr = (await apiPost("/ai/address", {})).address;
        const { memos, ephSk } = await buildRequest({ question: q, convHash: convHash(convSecret), replyAddr: addr, relayPk: hexToBytes(quote.relay_pubkey) });
        const r = await apiPost("/ai/send", { amount_zats: totalZats, memo_chunks_b64: memos.map(b64) });
        mine.status = "confirmed";
        set({ status: "thinking", reqTxid: r.txid });
        // Poll the inbox until the reply chunks assemble (Phase 3 wires this
        // to real REP memos; the ephemeral key lives only in this closure).
        say("Question sent shielded. Waiting for the relay…");
        ephSk.fill(0); // Phase 3: retained until the answer decrypts
      }
    } catch (e) {
      mine.status = "failed";
      set({ status: "failed", text: e.message || "Failed" });
      say(e.message || "Failed");
    }
    setBusy(false);
  }

  function hexToBytes(h) {
    return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  }

  async function doTopup() {
    const zats = Math.round(parseFloat(topupAmt || "0") * 1e8);
    if (!zats || zats <= 0) return say("Enter an amount");
    setBusy(true);
    try {
      await apiPost("/ai/topup", { amount_zats: zats });
      say("Top-up sent. It spends after confirmation");
      setTopup(false);
      setTimeout(refresh, 4000);
    } catch (e) { say(e.message); }
    setBusy(false);
  }

  const newIdentity = () => {
    setConvSecret(newConvSecret());
    setMsgs([]);
    say("New identity: fresh conversation secret, context cleared");
  };

  const st = { sending: T.blue, confirmed: T.teal, thinking: T.blue, answered: T.black, failed: T.signout };

  return (
    <div className="mp-scroll" style={{ display: "flex", flexDirection: "column" }}>
      <div className="mp-head">
        <div className="mp-title">AI</div>
        <div className="mp-meta" style={{ color: T.blue }}>{mock ? "PREVIEW · NO RELAY" : "ON-CHAIN"}</div>
      </div>

      {/* balance strip */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `2px solid ${T.black}`, background: T.white }}>
        <div>
          <Lbl>AI ACCOUNT</Lbl>
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20 }}>{(spendable / 1e8).toFixed(5)} <span style={{ fontSize: 12 }}>ZEC</span></div>
        </div>
        <div style={{ textAlign: "right" }}>
          <Lbl>PER QUESTION</Lbl>
          <div style={{ fontFamily: F.mono, fontSize: 13 }}>{quote ? `${(totalZats / 1e8).toFixed(5)} ZEC ≈ $${quote.total_usd}` : "…"}</div>
        </div>
        <button className="mp-link" onClick={() => setTopup(true)}>TOP UP</button>
      </div>

      {/* thread */}
      <div ref={scroller} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {msgs.length === 0 && (
          <div style={{ fontFamily: F.body, fontSize: 13, lineHeight: 1.55, opacity: 0.75 }}>
            Ask anything. The question is encrypted on this device, sent as a shielded
            transaction from a separate AI account, and the answer returns encrypted to a
            key that never leaves this browser.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
            <div style={{ border: `2px solid ${T.black}`, background: m.role === "user" ? T.blue : T.white, color: m.role === "user" ? T.white : T.black, padding: "9px 11px", fontFamily: F.body, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {m.text || (m.status === "thinking" ? "…" : "")}
            </div>
            <Lbl style={{ marginTop: 3, color: st[m.status] ?? T.black }}>{m.status.toUpperCase()}</Lbl>
          </div>
        ))}
      </div>

      {/* honest label + input */}
      <div style={{ borderTop: `2px solid ${T.black}`, background: T.white, padding: 12 }}>
        <Lbl style={{ marginBottom: 8 }}>
          ANONYMOUS TO THE RELAY AND THE AI PROVIDER. THE ZAIM SERVER CAN SEE THAT YOUR
          ACCOUNT USED AI, NOT WHAT YOU ASKED.
        </Lbl>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (mock ? ask() : setSheet(true))}
            placeholder="Ask anonymously" style={{ flex: 1, border: `2px solid ${T.black}`, padding: "10px 12px", fontFamily: F.body, fontSize: 14, background: T.off }} />
          <button className="mp-btn" style={{ width: "auto", padding: "0 18px" }} disabled={busy || !input.trim()}
            onClick={() => (mock ? ask() : setSheet(true))}>ASK</button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          <button className="mp-link" onClick={newIdentity}>NEW IDENTITY</button>
          <Lbl>MODE: {mock ? "PREVIEW" : "ON-CHAIN"} · FAST MODE COMES WITH PHASE 7</Lbl>
        </div>
      </div>

      {/* fee breakdown sheet */}
      {sheet && quote && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "flex-end", zIndex: 40 }} onClick={() => setSheet(false)}>
          <div style={{ background: T.off, borderTop: `3px solid ${T.black}`, width: "100%", padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 18, marginBottom: 10 }}>THIS QUESTION COSTS</div>
            {[["Your send fee", quote.send_fee_zats], ["Reply network cost", quote.reply_network_zats], ["Inference", quote.inference_zats], ["ZAIM fee", quote.zaim_fee_zats]].map(([k, v]) => (
              <div key={k} className="mp-kv"><span className="mp-kv-key">{k}</span><span className="mp-kv-val mono">{(v / 1e8).toFixed(6)} ZEC</span></div>
            ))}
            <div className="mp-kv"><span className="mp-kv-key">Total</span><span className="mp-kv-val mono" style={{ color: T.blue }}>{(totalZats / 1e8).toFixed(6)} ZEC ≈ ${quote.total_usd}</span></div>
            <Lbl style={{ margin: "8px 0" }}>USD-QUOTED WITH A {Math.round((quote.buffer - 1) * 100)}% VOLATILITY BUFFER. FLAT FOR EVERYONE.</Lbl>
            <button className="mp-btn" onClick={ask} disabled={busy}>SEND SHIELDED</button>
          </div>
        </div>
      )}

      {/* top up sheet */}
      {topup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "flex-end", zIndex: 40 }} onClick={() => setTopup(false)}>
          <div style={{ background: T.off, borderTop: `3px solid ${T.black}`, width: "100%", padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 18, marginBottom: 6 }}>TOP UP AI ACCOUNT</div>
            <Lbl style={{ marginBottom: 8 }}>INTERNAL SHIELDED TRANSFER FROM YOUR MAIN WALLET. THE AI ACCOUNT IS A SEPARATE SEED, DERIVED FROM YOURS — RECOVERABLE WITH THE SAME 24 WORDS.</Lbl>
            <input value={topupAmt} onChange={(e) => setTopupAmt(e.target.value)} inputMode="decimal"
              style={{ width: "100%", border: `2px solid ${T.black}`, padding: "10px 12px", fontFamily: F.mono, fontSize: 16, marginBottom: 10 }} />
            <button className="mp-btn" onClick={doTopup} disabled={busy}>SEND TO AI ACCOUNT</button>
          </div>
        </div>
      )}

      {toast && <div style={{ position: "fixed", bottom: 90, left: 16, right: 16, background: T.black, color: T.white, padding: "10px 12px", fontFamily: F.mono, fontSize: 12, zIndex: 50 }}>{toast}</div>}
    </div>
  );
}
