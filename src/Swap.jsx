import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { T, F } from "./styles/maxpain.js";

// ZAIM ⇄ the world — cross-chain swaps via NEAR Intents (1Click API).
// BUY:  pick an asset, get a quote, send the asset to a one-time deposit
//       address from any external wallet; ZEC lands in this wallet.
// SELL: pick an asset + destination address, confirm, and the backend sends
//       your ZEC to the swap's deposit address; the asset arrives at your
//       destination. All quotes and state live server-side.

const api = {
  headers: () => ({
    "Content-Type": "application/json",
    ...(localStorage.getItem("zaim_token")
      ? { Authorization: `Bearer ${localStorage.getItem("zaim_token")}` }
      : {}),
  }),
  async post(p, b) {
    const r = await fetch(`/api${p}`, { method: "POST", headers: this.headers(), body: JSON.stringify(b) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Failed");
    return d;
  },
  async get(p) {
    const r = await fetch(`/api${p}`, { headers: this.headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Failed");
    return d;
  },
};

const ASSETS = [
  { key: "BTC", label: "BTC", chain: "bitcoin" },
  { key: "ETH", label: "ETH", chain: "ethereum" },
  { key: "SOL", label: "SOL", chain: "solana" },
  { key: "USDC", label: "USDC", chain: "solana" },
];

const STATUS_META = {
  AWAITING_DEPOSIT: { color: T.blue, text: "waiting for your deposit" },
  PENDING_DEPOSIT: { color: T.blue, text: "waiting for your deposit" },
  KNOWN_DEPOSIT_TX: { color: T.blue, text: "deposit seen · confirming" },
  INCOMPLETE_DEPOSIT: { color: T.red, text: "deposit was less than quoted" },
  READY_TO_SEND: { color: T.black, text: "ready · confirm to send" },
  DEPOSIT_SENT: { color: T.blue, text: "zec broadcast · swapping" },
  PROCESSING: { color: T.blue, text: "swapping" },
  SUCCESS: { color: T.teal, text: "swap complete" },
  REFUNDED: { color: T.red, text: "refunded" },
  FAILED: { color: T.red, text: "failed" },
  EXPIRED: { color: T.red, text: "quote expired" },
  CANCELLED: { color: T.black, text: "cancelled · nothing moved" },
};

const TERMINAL = ["SUCCESS", "REFUNDED", "FAILED", "EXPIRED", "CANCELLED"];

const Back = ({ onClick }) => (
  <button onClick={onClick} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex" }} aria-label="Back">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke={T.black} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
);

const Err = ({ msg }) => msg ? (
  <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: 0.5 }}>{msg}</div>
) : null;

function StatusBand({ status }) {
  const meta = STATUS_META[status] || { color: T.black, text: (status || "").toLowerCase() };
  const dark = meta.color === T.black || meta.color === T.blue || meta.color === T.red;
  return (
    <div style={{ padding: "12px 16px", background: meta.color, color: dark ? T.white : T.black, borderBottom: `2px solid ${T.black}`, fontFamily: F.mono, fontSize: 11, letterSpacing: 2, textTransform: "uppercase" }}>
      {status} · {meta.text}
    </div>
  );
}

function QuotePanel({ quote }) {
  return (
    <div className="mp-grid">
      <div className="mp-cell"><div className="mp-cell-key">YOU SEND</div><div className="mp-cell-val" style={{ fontSize: 17 }}>{quote.amount_in}</div></div>
      <div className="mp-cell"><div className="mp-cell-key">YOU GET ≈</div><div className="mp-cell-val" style={{ fontSize: 17, color: T.teal }}>{quote.amount_out}</div></div>
      <div className="mp-cell"><div className="mp-cell-key">IN · USD</div><div className="mp-cell-val" style={{ fontSize: 15 }}>${Number(quote.amount_in_usd || 0).toFixed(2)}</div></div>
      <div className="mp-cell"><div className="mp-cell-key">OUT · USD</div><div className="mp-cell-val" style={{ fontSize: 15 }}>${Number(quote.amount_out_usd || 0).toFixed(2)}</div></div>
      <div className="mp-cell"><div className="mp-cell-key">EST TIME</div><div className="mp-cell-val" style={{ fontSize: 15 }}>{quote.time_estimate_sec ? `~${quote.time_estimate_sec}s` : "···"}</div></div>
      <div className="mp-cell"><div className="mp-cell-key">SLIPPAGE</div><div className="mp-cell-val" style={{ fontSize: 15 }}>1%</div></div>
    </div>
  );
}

export default function ZaimSwap({ onBack }) {
  const [mode, setMode] = useState("buy");
  const [asset, setAsset] = useState("SOL");
  const [amount, setAmount] = useState("");
  const [refundAddr, setRefundAddr] = useState("");
  const [destAddr, setDestAddr] = useState("");
  const [quote, setQuote] = useState(null);      // dry quote view
  const [swap, setSwap] = useState(null);        // live swap record
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedAmt, setCopiedAmt] = useState(false);
  const pollRef = useRef(null);

  const chain = ASSETS.find(a => a.key === asset)?.chain || "";

  const loadHistory = useCallback(async () => {
    try { const r = await api.get("/swap/list"); setHistory(r.swaps || []); } catch (e) { }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Poll the active swap while it's non-terminal and the tab is visible.
  useEffect(() => {
    if (!swap || TERMINAL.includes(swap.status)) return;
    if (swap.status === "READY_TO_SEND") return; // nothing to poll until executed
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await api.get(`/swap/status/${swap.id}`);
        if (r.swap) setSwap(r.swap);
        if (r.swap && TERMINAL.includes(r.swap.status)) loadHistory();
      } catch (e) { }
    };
    pollRef.current = setInterval(tick, 10000);
    return () => clearInterval(pollRef.current);
  }, [swap, loadHistory]);

  const reset = () => { setQuote(null); setSwap(null); setError(""); };

  const getQuote = async () => {
    setError("");
    if (!amount || parseFloat(amount) <= 0) return setError("enter an amount");
    if (mode === "buy" && !refundAddr.trim()) return setError(`enter your ${chain} refund address`);
    if (mode === "sell" && !destAddr.trim()) return setError(`enter the ${chain} address that receives ${asset}`);
    setLoading(true);
    try {
      const r = await api.post("/swap/quote", {
        direction: mode, asset, amount: String(amount),
        refund_address: refundAddr.trim(), recipient_address: destAddr.trim(), dry: true,
      });
      setQuote(r.quote);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const confirm = async () => {
    setError(""); setLoading(true);
    try {
      const r = await api.post("/swap/quote", {
        direction: mode, asset, amount: String(amount),
        refund_address: refundAddr.trim(), recipient_address: destAddr.trim(), dry: false,
      });
      setSwap(r.swap); setQuote(null); loadHistory();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const execute = async () => {
    setError(""); setLoading(true);
    try {
      const r = await api.post("/swap/execute", { swap_id: swap.id });
      setSwap(r.swap);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const cancelSwap = async () => {
    setError(""); setLoading(true);
    try {
      const r = await api.post("/swap/cancel", { swap_id: swap.id });
      setSwap(r.swap); loadHistory();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const copyDeposit = () => {
    navigator.clipboard?.writeText(swap.deposit_address);
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };

  // ── active swap view ──────────────────────────────────────────────────────
  if (swap) {
    const q = swap.quote || {};
    const terminal = TERMINAL.includes(swap.status);
    const minsLeft = q.deadline ? Math.max(0, Math.round((new Date(q.deadline).getTime() - Date.now()) / 60000)) : null;
    return (
      <div className="mp-scroll">
        <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><Back onClick={() => { reset(); onBack(); }} /><div className="mp-title">Swap</div></div></div>
        <StatusBand status={swap.status} />

        {swap.direction === "buy" && !terminal && (
          <>
            <div className="mp-band mp-band-w">
              <div className="mp-lbl-sm" style={{ marginBottom: 6, color: T.blue }}>SEND EXACTLY</div>
              <div className="mp-big" style={{ fontSize: 34 }}>{q.amount_in} {swap.asset}</div>
              <button className="mp-link" style={{ marginTop: 8 }} onClick={() => { navigator.clipboard?.writeText(String(q.amount_in)); setCopiedAmt(true); setTimeout(() => setCopiedAmt(false), 1600); }}>{copiedAmt ? "COPIED" : "TAP TO COPY AMOUNT"}</button>
              <div className="mp-lbl-sm" style={{ marginTop: 10 }}>ON {swap.chain} · ONE PAYMENT · SEND LESS AND IT STALLS · YOU GET ≈ {q.amount_out} ZEC</div>
            </div>
            <div className="mp-band mp-band-w" style={{ textAlign: "center" }}>
              <div style={{ display: "inline-block", padding: 10, border: `2px solid ${T.black}`, background: T.white }}>
                <QRCodeSVG value={swap.deposit_address} size={168} />
              </div>
              <div className="mp-mono" style={{ marginTop: 12, wordBreak: "break-all", fontSize: 12 }}>{swap.deposit_address}</div>
              <button className="mp-link" style={{ marginTop: 8 }} onClick={copyDeposit}>{copied ? "COPIED" : "TAP TO COPY ADDRESS"}</button>
            </div>
            <div className="mp-band">
              <div className="mp-quip">send from any wallet you control. this quote expires in {minsLeft == null ? "a few" : minsLeft} min. an unpaid quote simply lapses, and a late deposit refunds to your address.</div>
            </div>
          </>
        )}

        {swap.direction === "sell" && swap.status === "READY_TO_SEND" && (
          <>
            <div className="mp-band mp-band-w">
              <div className="mp-lbl-sm" style={{ marginBottom: 6, color: T.blue }}>YOU ARE SENDING</div>
              <div className="mp-big" style={{ fontSize: 34 }}>{q.amount_in} ZEC</div>
              <div className="mp-lbl-sm" style={{ marginTop: 8 }}>YOU GET ≈ {q.amount_out} {swap.asset} AT</div>
              <div className="mp-mono" style={{ marginTop: 6, wordBreak: "break-all", fontSize: 12 }}>{swap.recipient}</div>
            </div>
            <div className="mp-band" style={{ background: T.signout }}>
              <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1, color: T.white, textTransform: "uppercase" }}>⚠ this sends real zec. it cannot be undone.</div>
            </div>
            <Err msg={error} />
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <button className="mp-btn" onClick={execute} disabled={loading}>{loading ? "SENDING…" : `SEND ${q.amount_in} ZEC NOW`}</button>
              <button className="mp-btn ghost" onClick={cancelSwap} disabled={loading}>CANCEL THIS SWAP</button>
            </div>
          </>
        )}

        {swap.direction === "sell" && swap.status !== "READY_TO_SEND" && !terminal && (
          <div className="mp-band">
            <div className="mp-quip">zec is on its way to the swap. this usually takes a couple of minutes.</div>
            {swap.txid && <div className="mp-mono" style={{ marginTop: 10, fontSize: 11, wordBreak: "break-all" }}>tx {swap.txid}</div>}
          </div>
        )}

        {terminal && (
          <>
            <div className="mp-band mp-band-w">
              <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>RESULT</div>
              {swap.status === "SUCCESS" ? (
                <>
                  <div className="mp-big" style={{ fontSize: 34, color: T.teal }}>
                    {(swap.details && swap.details.amount_out) || q.amount_out} {swap.direction === "buy" ? "ZEC" : swap.asset}
                  </div>
                  <div className="mp-lbl-sm" style={{ marginTop: 8 }}>DELIVERED</div>
                  {swap.details?.dest_tx && <div className="mp-mono" style={{ marginTop: 8, fontSize: 11, wordBreak: "break-all" }}>{swap.details.dest_tx}</div>}
                </>
              ) : (
                <div className="mp-quip">
                  {swap.status === "CANCELLED" ? "cancelled. nothing moved." : swap.status === "REFUNDED" ? "the swap did not complete. funds were returned to the refund address." : "the swap did not complete. nothing further will move."}
                </div>
              )}
            </div>
            <div style={{ padding: 16 }}><button className="mp-btn" onClick={reset}>NEW SWAP</button></div>
          </>
        )}

        {!terminal && swap.direction === "buy" && (
          <>
            <Err msg={error} />
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <button className="mp-btn danger" onClick={cancelSwap} disabled={loading}>{loading ? "…" : "CANCEL THIS SWAP"}</button>
              <button className="mp-btn ghost" onClick={reset} disabled={loading}>BACK</button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── quote form ────────────────────────────────────────────────────────────
  return (
    <div className="mp-scroll">
      <div className="mp-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><Back onClick={onBack} /><div className="mp-title">Swap</div></div></div>

      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        {["buy", "sell"].map((m, i) => (
          <div key={m} onClick={() => { setMode(m); setQuote(null); setError(""); }} style={{ flex: 1, padding: "14px 0", textAlign: "center", cursor: "pointer", fontFamily: F.display, fontWeight: 800, fontSize: 18, textTransform: "uppercase", letterSpacing: 0.5, borderRight: i === 0 ? `2px solid ${T.black}` : "none", background: mode === m ? (m === "buy" ? T.teal : T.red) : T.off, color: mode === m ? (m === "buy" ? T.black : T.white) : T.black }}>
            {m === "buy" ? "Buy ZEC" : "Sell ZEC"}
          </div>
        ))}
      </div>

      <div className="mp-section">{mode === "buy" ? "PAY WITH" : "RECEIVE"}</div>
      <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
        {ASSETS.map((a, i) => (
          <div key={a.key} onClick={() => { setAsset(a.key); setQuote(null); }} style={{ flex: 1, padding: "12px 0", textAlign: "center", cursor: "pointer", fontFamily: F.display, fontWeight: 800, fontSize: 15, borderRight: i < ASSETS.length - 1 ? `2px solid ${T.black}` : "none", background: asset === a.key ? T.blue : T.off, color: asset === a.key ? T.white : T.black }}>
            {a.label}
          </div>
        ))}
      </div>

      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>{mode === "buy" ? `AMOUNT · ${asset}` : "AMOUNT · ZEC"}</div>
          <input className="mp-input" type="number" value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} placeholder="0.00" />
        </div>
        {mode === "buy" ? (
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>YOUR {chain.toUpperCase()} REFUND ADDRESS</div>
            <input className="mp-input" value={refundAddr} onChange={e => { setRefundAddr(e.target.value); setQuote(null); }} placeholder={`the ${chain} wallet you are paying from`} />
          </div>
        ) : (
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>{asset} DESTINATION · {chain.toUpperCase()}</div>
            <input className="mp-input" value={destAddr} onChange={e => { setDestAddr(e.target.value); setQuote(null); }} placeholder={`where your ${asset} should arrive`} />
          </div>
        )}
        <Err msg={error} />
        {!quote && <button className="mp-btn" onClick={getQuote} disabled={loading}>{loading ? "PRICING…" : "GET QUOTE"}</button>}
      </div>

      {quote && (
        <>
          <div className="mp-section">QUOTE</div>
          <QuotePanel quote={quote} />
          <div className="mp-band">
            <div className="mp-quip">{mode === "buy" ? "confirm to lock a deposit address. rates refresh at confirm." : "confirm to lock the swap, then approve the send."}</div>
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="mp-btn" onClick={confirm} disabled={loading}>{loading ? "LOCKING…" : mode === "buy" ? "CONFIRM · GET DEPOSIT ADDRESS" : "CONFIRM SELL"}</button>
            <button className="mp-btn ghost" onClick={() => setQuote(null)} disabled={loading}>BACK</button>
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="mp-section">RECENT SWAPS</div>
          {history.slice(0, 6).map(s => {
            const meta = STATUS_META[s.status] || { color: T.black };
            return (
              <div key={s.id} className="mp-row" style={{ cursor: "pointer" }} onClick={() => { setSwap(s); setError(""); }}>
                <div style={{ width: 64, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: s.direction === "buy" ? T.teal : T.red, color: s.direction === "buy" ? T.black : T.white, fontFamily: F.display, fontWeight: 800, fontSize: 13 }}>{s.direction === "buy" ? "BUY" : "SELL"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14 }}>{(s.quote || {}).amount_in} {s.direction === "buy" ? s.asset : "ZEC"} → {(s.quote || {}).amount_out} {s.direction === "buy" ? "ZEC" : s.asset}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 10, marginTop: 2, textTransform: "uppercase", letterSpacing: 1, color: meta.color === T.off ? T.black : meta.color }}>{s.status}</div>
                </div>
              </div>
            );
          })}
        </>
      )}
      <div style={{ height: 12 }} />
    </div>
  );
}
