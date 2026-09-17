// Inscriptions — writing a file onto the Zcash chain itself.
//
// Two things this screen has to keep saying, because both are surprising in a
// wallet whose whole premise is privacy:
//
//   1. An inscription lives at a TRANSPARENT address, in public, permanently.
//      Anyone can see it and link it to that address. That is inherent to how
//      inscriptions work on Zcash, not a shortcut we took.
//   2. We mint it for you, which means for one transaction you are trusting us
//      to actually send it. You do not hold the key that signs it.
//
// Neither belongs in small print, so both are on the screen before the button.

import { useCallback, useEffect, useState } from "react";
import { T, F } from "./styles/maxpain.js";
import { apiGet, apiPost } from "./api.js";

const MAX_BYTES = 9_000;

/** Read a File into base64 without loading it twice. */
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });
}

function Owned({ items, indexedTo }) {
  if (!items.length) {
    return (
      <div className="mp-band">
        <div className="mp-quip" style={{ margin: 0 }}>
          Nothing inscribed yet. What you mint here lands at your transparent address
          and shows up in this list once it is in a block.
        </div>
      </div>
    );
  }
  return (
    <>
      {items.map((i) => (
        <div key={i.id} style={{ background: T.white, borderBottom: `2px solid ${T.black}`, padding: "14px 16px" }}>
          <div className="mp-lbl-sm" style={{ color: T.blue, marginBottom: 6 }}>
            {i.contentType} {i.height ? `  BLOCK ${i.height}` : ""}
          </div>
          <div className="mp-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{i.id}</div>
          {i.contentType?.startsWith("image/") && (
            <img alt="" src={`data:${i.contentType};base64,${i.contentBase64}`}
              style={{ maxWidth: "100%", marginTop: 10, border: `2px solid ${T.black}` }} />
          )}
          {i.contentType?.startsWith("text/") && (
            <div style={{ fontFamily: F.body, fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
              {atob(i.contentBase64 || "").slice(0, 300)}
            </div>
          )}
        </div>
      ))}
      {indexedTo != null && (
        <div className="mp-band">
          <div className="mp-lbl-sm">INDEXED TO BLOCK {indexedTo}</div>
        </div>
      )}
    </>
  );
}

export default function Inscriptions({ onBack, viewOnly }) {
  const [status, setStatus] = useState(null);
  const [owned, setOwned] = useState({ inscriptions: [], indexedTo: null });
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [seed, setSeed] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await apiGet("/inscriptions/status");
      setStatus(s);
      if (s.enabled) setOwned(await apiGet("/inscriptions/owned"));
    } catch (e) {
      setStatus({ enabled: false });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Any edit invalidates a quote: charging a price that was calculated for
  // different bytes would be indefensible, however small the difference.
  const changed = (fn) => (...a) => { setQuote(null); setError(""); fn(...a); };

  const body = async () => {
    if (file) {
      return { kind: "artifact", content_type: file.type || "application/octet-stream",
               content_base64: await toBase64(file) };
    }
    return { kind: "text", text: text.trim() };
  };

  const getQuote = async () => {
    setError(""); setBusy("quoting");
    try {
      setQuote(await apiPost("/inscriptions/quote", await body()));
    } catch (e) { setError(e.message); }
    setBusy("");
  };

  const mint = async () => {
    setError(""); setBusy("minting");
    try {
      const payload = await body();
      if (viewOnly) {
        if (seed.trim().split(/\s+/).length < 12) {
          setBusy(""); return setError("Enter your seed phrase to pay for this");
        }
        payload.seed_phrase = seed.trim();
      }
      const r = await apiPost("/inscriptions/mint", payload);
      setSeed("");
      setResult(r);
      load();
    } catch (e) { setError(e.message); }
    setBusy("");
  };

  const size = file ? file.size : new TextEncoder().encode(text).length;
  const tooBig = size > MAX_BYTES;
  const ready = (file || text.trim()) && !tooBig;

  if (status && !status.enabled) {
    return (
      <div className="mp-scroll">
        <div className="mp-head"><div className="mp-title">Inscriptions</div></div>
        <div className="mp-band">
          <div className="mp-quip" style={{ margin: 0 }}>
            Not switched on yet. Writing files onto the chain is built and tested, and it
            stays off until it has been proven end to end on mainnet.
          </div>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="mp-scroll">
        <div className="mp-head"><div className="mp-title">Inscribed</div></div>
        <div className="mp-band-blue" style={{ padding: "34px 16px", borderBottom: `2px solid ${T.black}` }}>
          <div className="mp-lbl" style={{ color: T.white, marginBottom: 10 }}>ON THE CHAIN</div>
          <div className="mp-mono" style={{ color: T.white, fontSize: 12, wordBreak: "break-all" }}>
            {result.inscription_id}
          </div>
        </div>
        {result.charge_failed && (
          <div className="mp-band">
            <div className="mp-quip" style={{ margin: 0 }}>
              It is yours and it is on the chain. We could not take payment for it, which is
              our problem and not yours.
            </div>
          </div>
        )}
        <div className="mp-band">
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>REVEAL TX</div>
          <div className="mp-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{result.reveal_txid}</div>
        </div>
        <div style={{ padding: 16 }}>
          <button className="mp-btn" onClick={() => { setResult(null); setText(""); setFile(null); setQuote(null); }}>
            INSCRIBE ANOTHER
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mp-scroll">
      <div className="mp-head"><div className="mp-title">Inscriptions</div></div>

      <div className="mp-band mp-band-w">
        <div className="mp-quip" style={{ margin: 0 }}>
          Write a small file onto Zcash itself. It lands at your transparent address and
          stays there, readable by anyone, for as long as the chain exists.
        </div>
      </div>

      <div className="mp-section">THIS IS PUBLIC</div>
      <div className="mp-band">
        <div className="mp-quip" style={{ margin: 0 }}>
          Everything else in ZAIM is shielded. This is not. An inscription is stored in the
          clear and tied to a transparent address that anyone can look up. If that address
          ever receives funds traceable to you, the link is permanent. Inscribe nothing you
          would mind being read.
        </div>
      </div>

      <div className="mp-section">WE MINT IT FOR YOU</div>
      <div className="mp-band">
        <div className="mp-quip" style={{ margin: 0 }}>
          Inscriptions need transparent coins and your wallet holds shielded ones, so we pay
          for the transaction and send the result straight to you. For that one transaction
          you are trusting us to actually send it.
        </div>
      </div>

      <div className="mp-section">WHAT TO INSCRIBE</div>
      <div className="mp-band" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>TEXT</div>
          <textarea className="mp-input" rows={3} value={text} disabled={!!file}
            onChange={changed((e) => setText(e.target.value))}
            placeholder="A few words, a poem, a key" style={{ resize: "none", fontFamily: F.mono, fontSize: 13 }} />
        </div>
        <div>
          <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>OR A FILE</div>
          <input type="file" onChange={changed((e) => setFile(e.target.files?.[0] ?? null))}
            style={{ fontFamily: F.mono, fontSize: 12 }} />
          {file && <div className="mp-lbl-sm" style={{ marginTop: 8 }}>{file.name}  {size} BYTES</div>}
        </div>

        {tooBig && (
          <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>
            {size} bytes is too big. One inscription holds about {MAX_BYTES}
          </div>
        )}

        {quote && (
          <div style={{ border: `2px solid ${T.black}`, padding: 14 }}>
            <div className="mp-lbl-sm" style={{ marginBottom: 8 }}>WHAT IT COSTS</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.mono, fontSize: 13 }}>
              <span>Chain</span><span>{(quote.chain_zats / 1e8).toFixed(5)} ZEC</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.mono, fontSize: 13, marginTop: 4 }}>
              <span>ZAIM</span><span>{(quote.fee_zats / 1e8).toFixed(5)} ZEC</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.display, fontWeight: 800, marginTop: 10 }}>
              <span>TOTAL</span><span>{quote.total_zec.toFixed(5)} ZEC</span>
            </div>
          </div>
        )}

        {quote && viewOnly && (
          <div>
            <div className="mp-lbl-sm" style={{ marginBottom: 6 }}>SEED PHRASE  TO PAY</div>
            <textarea className="mp-input" rows={3} value={seed} onChange={(e) => setSeed(e.target.value)}
              placeholder="Your 24 words" style={{ resize: "none", fontFamily: F.mono, fontSize: 13 }} />
          </div>
        )}

        {error && (
          <div style={{ fontFamily: F.mono, fontSize: 12, color: T.red, textTransform: "uppercase", letterSpacing: .5 }}>
            {error}
          </div>
        )}

        {!quote ? (
          <button className="mp-btn" onClick={getQuote} disabled={!ready || busy === "quoting"}>
            {busy === "quoting" ? "PRICING…" : "WHAT WOULD THIS COST"}
          </button>
        ) : (
          <button className="mp-btn" onClick={mint} disabled={busy === "minting"}>
            {busy === "minting" ? "INSCRIBING…" : `INSCRIBE FOR ${quote.total_zec.toFixed(5)} ZEC`}
          </button>
        )}
      </div>

      <div className="mp-section">YOURS</div>
      <Owned items={owned.inscriptions ?? []} indexedTo={owned.indexedTo} />
    </div>
  );
}
