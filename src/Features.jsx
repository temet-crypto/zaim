// Features preview shown from the sign in screen, under the dev log.
// Every visual below is built from the same tokens and classes the real screens
// use, so a redesign of the app carries through here instead of going stale.
// Nothing here is interactive. It is a look, not a demo.
import { useEffect, useState } from "react";
import { T, F } from "./styles/maxpain.js";
import { QRCodeSVG } from "qrcode.react";
import { apiGet } from "./api.js";

const BackArrow = ({ onClick }) => (
  <button onClick={onClick} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex" }} aria-label="Back">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke={T.black} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
);

// One feature: numbered blue rule, the highlight visual, one sentence.
function Feature({ n, name, tag, tagColor, desc, children }) {
  return (
    <>
      <div className="mp-section" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span>{n} · {name}</span>
        {tag && <span style={{ background: tagColor || T.white, color: tagColor ? T.white : T.blue, padding: "2px 7px", letterSpacing: 1 }}>{tag}</span>}
      </div>
      <div style={{ padding: 16, background: T.white, borderBottom: `2px solid ${T.black}` }}>
        <div aria-hidden="true" style={{ border: `2px solid ${T.black}`, background: T.off, overflow: "hidden", pointerEvents: "none", userSelect: "none" }}>
          {children}
        </div>
        <div style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{desc}</div>
      </div>
    </>
  );
}

// ── the highlight visuals ────────────────────────────────────────────────────
const Lbl = ({ children, color, style }) => (
  <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: color || T.black, ...style }}>{children}</div>
);
const Cell = ({ k, v, color, last }) => (
  <div style={{ padding: "9px 11px", borderRight: last ? "none" : `2px solid ${T.black}`, background: T.white }}>
    <Lbl>{k}</Lbl>
    <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 18, lineHeight: 1, marginTop: 5, color: color || T.black }}>{v}</div>
  </div>
);
const FakeField = ({ k, v, mono = true, dim }) => (
  <div style={{ marginBottom: 9 }}>
    <Lbl style={{ marginBottom: 4 }}>{k}</Lbl>
    <div style={{ border: `2px solid ${T.black}`, background: T.white, padding: "8px 10px", fontFamily: mono ? F.mono : F.body, fontSize: 11, color: dim ? "rgba(0,0,0,.4)" : T.black, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
  </div>
);

const WalletVisual = () => (
  <div>
    <div style={{ padding: "13px 12px", borderBottom: `2px solid ${T.black}` }}>
      <Lbl style={{ marginBottom: 7 }}>Shielded balance · all</Lbl>
      <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 46, lineHeight: .95, letterSpacing: -1.5 }}>2.4718</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <Lbl>ZEC total</Lbl>
        <span style={{ fontFamily: F.mono, fontSize: 10 }}>≈ $1,247.03 USD</span>
      </div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `2px solid ${T.black}` }}>
      <Cell k="Shielded" v="2.4718" color={T.teal} />
      <Cell k="Transparent" v="0.0000" color={T.blue} last />
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 12px", background: T.white }}>
      <div>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 26, letterSpacing: -.5 }}>$504.31</div>
        <Lbl style={{ marginTop: 4 }}>Zcash · coingecko</Lbl>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 20, color: T.teal, letterSpacing: -.5 }}>+4.62%</div>
        <Lbl style={{ marginTop: 3 }}>24h</Lbl>
      </div>
    </div>
  </div>
);

const SendVisual = () => (
  <div>
    <div style={{ padding: 12, borderBottom: `2px solid ${T.black}` }}>
      <FakeField k="To address" v="zs1w8q4m0hy7v2xk9d3rp6as5ftu1…" />
      <FakeField k="Amount · ZEC" v="0.2500" />
      <FakeField k="Memo · optional" v="Dinner, split four ways" mono={false} />
    </div>
    <div style={{ display: "flex" }}>
      <div style={{ flex: 1, padding: "11px 0", textAlign: "center", background: T.black, color: T.off, fontFamily: F.body, fontWeight: 600, fontSize: 12 }}>SEND</div>
    </div>
  </div>
);

const MessagesVisual = () => (
  <div style={{ padding: 12, background: T.off }}>
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 9 }}>
      <div style={{ maxWidth: "84%", padding: "8px 10px", border: `2px solid ${T.black}`, background: T.white }}>
        <div style={{ fontFamily: F.body, fontSize: 12, lineHeight: 1.4 }}>Landed. Same place as last time?</div>
        <Lbl style={{ marginTop: 4, opacity: .8 }}>Block 2,845,113 · 0.0001 ZEC</Lbl>
      </div>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{ maxWidth: "84%", padding: "8px 10px", border: `2px solid ${T.black}`, background: T.blue, color: T.white }}>
        <div style={{ fontFamily: F.body, fontSize: 12, lineHeight: 1.4 }}>Yes. Ten minutes.</div>
        <Lbl color={T.white} style={{ marginTop: 4, opacity: .8 }}>Pending · 0.0001 ZEC</Lbl>
      </div>
    </div>
  </div>
);

const SwapVisual = () => (
  <div>
    <div style={{ display: "flex", borderBottom: `2px solid ${T.black}` }}>
      {["BTC", "ETH", "SOL", "USDC"].map((a, i) => (
        <div key={a} style={{ flex: 1, padding: "9px 0", textAlign: "center", fontFamily: F.display, fontWeight: 800, fontSize: 13, borderRight: i < 3 ? `2px solid ${T.black}` : "none", background: a === "SOL" ? T.blue : T.off, color: a === "SOL" ? T.white : T.black }}>{a}</div>
      ))}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `2px solid ${T.black}` }}>
      <Cell k="You send" v="4.0000" />
      <Cell k="You get ≈" v="1.6214" color={T.teal} last />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", background: T.white }}>
      <Cell k="Est time" v="~46s" />
      <Cell k="Slippage" v="1%" last />
    </div>
  </div>
);

const GeoVisual = () => (
  <div style={{ padding: 12, background: T.white }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 9 }}>
      <div>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 19, lineHeight: 1, textTransform: "uppercase" }}>Tokyo Drop</div>
        <Lbl style={{ marginTop: 4 }}>Shibuya · 35.6620, 139.7038</Lbl>
      </div>
      <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 12, lineHeight: 1, padding: "4px 8px", background: T.teal, color: T.black, textTransform: "uppercase" }}>In range</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
      <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 19, color: T.teal, letterSpacing: -.5 }}>0.5000 ZEC</span>
      <span style={{ fontFamily: F.mono, fontSize: 9 }}>· 50m</span>
      <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 10, lineHeight: 1, padding: "2px 6px", background: T.blue, color: T.white, textTransform: "uppercase" }}>MSG</span>
    </div>
    <div style={{ height: 8, border: `2px solid ${T.black}`, background: T.blueTint, overflow: "hidden", marginBottom: 7 }}>
      <div style={{ height: "100%", width: "62%", background: T.teal }} />
    </div>
    <Lbl color={T.teal}>Closes in 02h 14m</Lbl>
  </div>
);

const RequestVisual = () => (
  <div style={{ display: "flex", alignItems: "stretch" }}>
    <div style={{ padding: 12, borderRight: `2px solid ${T.black}`, background: T.white, display: "flex", alignItems: "center" }}>
      <div style={{ padding: 5, border: `2px solid ${T.black}` }}>
        <QRCodeSVG value="zcash:zs1demo7request4visual9only?amount=0.25" size={74} />
      </div>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ padding: "9px 11px", borderBottom: `2px solid ${T.black}`, background: T.white }}>
        <Lbl>Requesting</Lbl>
        <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 22, lineHeight: 1, marginTop: 4 }}>0.2500 ZEC</div>
      </div>
      <div style={{ padding: "9px 11px", background: T.white }}>
        <Lbl color={T.blue}>zcash: link · fresh address</Lbl>
        <div style={{ fontFamily: F.mono, fontSize: 9, marginTop: 4, wordBreak: "break-all", opacity: .7 }}>zcash:zs1kq…x2f?amount=0.25</div>
        <span style={{ display: "inline-block", marginTop: 6, fontFamily: F.display, fontWeight: 800, fontSize: 10, padding: "2px 6px", background: T.teal, color: T.black, textTransform: "uppercase" }}>Paid</span>
      </div>
    </div>
  </div>
);

const SyncVisual = () => (
  <div>
    {[["N", "Naomi", "zs1w8q…tu1"], ["M", "Marcus", "u1kf…3lsv"]].map(([i, name, addr], idx) => (
      <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderBottom: `2px solid ${T.black}`, background: T.white }}>
        <div style={{ width: 30, height: 30, background: T.blue, color: T.white, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.display, fontWeight: 800, fontSize: 14, flexShrink: 0 }}>{i}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 13 }}>{name}</div>
          <div style={{ fontFamily: F.mono, fontSize: 9, opacity: .7 }}>{addr}</div>
        </div>
        <span style={{ fontFamily: F.mono, fontSize: 8, letterSpacing: 1, color: T.teal, textTransform: "uppercase" }}>On chain</span>
      </div>
    ))}
    <div style={{ padding: "8px 11px", background: T.white }}>
      <Lbl color={T.blue}>Encrypted memos to yourself · 1 transaction</Lbl>
      <div style={{ fontFamily: F.mono, fontSize: 9, marginTop: 4, opacity: .7 }}>zaim-sync:v1:1/2:1785… · only your seed reads it</div>
    </div>
  </div>
);

const SeedVisual = () => (
  <div>
    {[["Identity", "your seed · no account", T.blue], ["Key storage", "server side · custodial", T.black], ["At rest", "sealed · seed encrypted", T.teal]].map(([k, v, c], i) => (
      <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: i < 2 ? `2px solid ${T.black}` : "none", background: T.white }}>
        <Lbl>{k}</Lbl>
        <span style={{ fontFamily: F.mono, fontSize: 11, color: c, textAlign: "right" }}>{v}</span>
      </div>
    ))}
  </div>
);

const AiVisual = () => (
  <div>
    <div style={{ padding: "11px 12px", borderBottom: `2px solid ${T.black}` }}>
      <Lbl>ANONYMOUS QUESTION</Lbl>
      <div style={{ border: `2px solid ${T.black}`, background: T.blue, color: T.white, padding: "7px 9px", marginTop: 6, fontFamily: F.body, fontSize: 12 }}>
        What is a shielded transaction?
      </div>
      <Lbl style={{ marginTop: 4, color: T.teal }}>SEALED ON THIS DEVICE</Lbl>
    </div>
    <div style={{ padding: "11px 12px", background: T.white }}>
      <div style={{ border: `2px solid ${T.black}`, background: T.off, padding: "7px 9px", fontFamily: F.body, fontSize: 12 }}>
        A transfer where the amount and the parties stay hidden behind a proof.
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <Lbl>ANSWERED IN A SHIELDED MEMO</Lbl>
        <Lbl style={{ color: T.blue }}>0.0008 ZEC</Lbl>
      </div>
    </div>
  </div>
);

// A plain claim in the honest section. No visual, no sample data: the point is
// that these read as statements the project is willing to be held to.
function Claim({ n, head, children }) {
  return (
    <div style={{ padding: "13px 16px", background: T.white, borderBottom: `2px solid ${T.black}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.5, color: T.blue }}>{n}</span>
        <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 15, letterSpacing: -.2 }}>{head}</span>
      </div>
      <div style={{ fontFamily: F.body, fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>{children}</div>
    </div>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────
/** Small square with a corner fold: a file, sitting in the open. */
function InscriptionVisual() {
  return (
    <div style={{ padding: 20, display: "flex", justifyContent: "center" }}>
      <svg width="120" height="90" viewBox="0 0 120 90" aria-hidden="true">
        <path d="M30 10h44l16 16v54H30z" fill={T.white} stroke={T.black} strokeWidth="2.5" />
        <path d="M74 10v16h16" fill="none" stroke={T.black} strokeWidth="2.5" />
        <rect x="40" y="40" width="40" height="4" fill={T.blue} />
        <rect x="40" y="52" width="30" height="4" fill={T.blue} />
        <rect x="40" y="64" width="36" height="4" fill={T.red} />
      </svg>
    </div>
  );
}

export default function FeaturesScreen({ onBack }) {
  // Advertise it only where it exists. The screen renders before sign in, so
  // this comes off the unauthenticated health route.
  const [inscriptions, setInscriptions] = useState(false);
  useEffect(() => {
    apiGet("/health").then(h => setInscriptions(!!h.inscriptions)).catch(() => {});
  }, []);
  return (
    <div className="mp-scroll">
      <div className="mp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BackArrow onClick={onBack} />
          <div className="mp-title">Features</div>
        </div>
        <div className="mp-meta" style={{ color: T.blue }}>ZAIM</div>
      </div>

      <div className="mp-band">
        <div className="mp-quip">Everything ZAIM does, one screen at a time. Sample numbers, real screens.</div>
      </div>

      <Feature n="01" name="Messages"
        desc="Each message is a real shielded transaction carrying an encrypted memo, so the chain proves it happened while the words stay between you and the recipient.">
        <MessagesVisual />
      </Feature>

      <Feature n="02" name="Anonymous AI" tag="PREVIEW" tagColor={T.blue}
        desc="Ask an AI a question from a separate account with its own seed. The question is sealed on your device, travels as a shielded transaction, and the answer comes back encrypted to a key only this browser holds.">
        <AiVisual />
      </Feature>

      <Feature n="03" name="GeoVault" tag="IN TESTING" tagColor={T.red}
        desc="Park ZEC and a message at a set of coordinates in ZAIM escrow, where only someone inside the radius during your window can release it, and anything nobody claims comes back to you when the window closes.">
        <GeoVisual />
      </Feature>

      <Feature n="04" name="Cross chain swaps"
        desc="Trade BTC, ETH, SOL or USDC for ZEC and back through NEAR Intents, with no account and no order book, and cancel any swap you have not funded.">
        <SwapVisual />
      </Feature>

      <Feature n="05" name="Shielded wallet"
        desc="A single screen for your shielded and transparent balances, the live ZEC price, and every transaction the wallet has seen.">
        <WalletVisual />
      </Feature>

      <Feature n="06" name="Send ZEC"
        desc="Pay any shielded or unified address, with an optional memo that travels encrypted inside the transaction itself.">
        <SendVisual />
      </Feature>

      <Feature n="07" name="Payment requests"
        desc="Ask for an exact amount with a zcash: link and QR that any Zcash wallet can pay, built on a fresh address every time so your invoices cannot be tied together.">
        <RequestVisual />
      </Feature>

      <Feature n="08" name="Chain synced contacts"
        desc="Your contact book can ride the chain as encrypted memos written to yourself, so a new device with your seed pulls your people with no server copy anywhere.">
        <SyncVisual />
      </Feature>

      <Feature n="09" name="Seed only sign in"
        desc="There is no username and no password, because your seed phrase is the login, and signing out seals the wallet with a key derived from that same seed.">
        <SeedVisual />
      </Feature>

      {inscriptions && (
        <Feature n="10" name="Inscriptions" tag="PUBLIC" tagColor={T.red}
          desc="Write a small file onto Zcash itself and keep it at your own address. Read the warning on the screen first: an inscription is stored in the clear, unlike everything else here, and anyone can read it for as long as the chain exists.">
          <InscriptionVisual />
        </Feature>
      )}

      <div className="mp-section">THE HONEST PART</div>
      <div className="mp-band mp-band-w">
        <div className="mp-quip">Read this before you put real money in. It is the part most wallets bury.</div>
      </div>
      <Claim n="01" head="Signing in no longer sends us your seed">
        Your seed stays in your browser. It goes into a key derivation that runs on your own
        device, and only the viewing key that comes out is sent to us. A viewing key lets us
        sync your wallet, show your balance and read your memos. It cannot move money, and
        that is arithmetic, not a promise we are making. Open the network tab and check.
      </Claim>
      <Claim n="02" head="Sending is the exception, and it has a time limit">
        Because we hold no spending key, a payment needs one. Your seed is sent with it and
        opens your wallet for spending, and it stays open for 10 minutes after your last
        payment so a conversation does not wait on every message. Then it is sealed again, and
        signing out seals it at once. So the window where this server could spend your funds is
        10 minutes after each payment rather than your whole session. It is smaller. It is not
        zero, and we will not pretend it is. Closing the tab drops the seed from your browser,
        which is why sending again after a reload asks once more.
      </Claim>
      <Claim n="03" head="Sealed means sealed">
        When you sign out, or after 30 idle minutes, your wallet is encrypted and the plaintext
        is deleted. The key comes from your viewing key, so it arrives with you and leaves with
        you. Someone who steals the disk gets ciphertext. Be clear on the limit though: anyone
        who can replay your sign in holds that key, so this protects a stolen disk, not a
        compromised server.
      </Claim>
      <Claim n="04" head="You can leave whenever you want">
        Your seed is a standard Zcash seed. Type it into Zashi, Ywallet or any other Zcash wallet and you get the same funds and the same history. Nothing here is locked to us.
      </Claim>
      <Claim n="05" head="The AI tab knows less about you than we do">
        Questions are sealed in your browser before they reach us, so our server carries
        ciphertext it cannot read. The relay and the AI provider read the question and
        never learn who asked. What we can still see is that your account used the AI tab
        and what it paid, and we would rather say that than let you assume otherwise.
      </Claim>
      <Claim n="06" head="If you want none of the above">
        Run ZAIM yourself. The whole thing is public and MIT licensed, and self hosting is documented in the repo, so the only server holding your seed is one you control.
      </Claim>

      <div style={{ padding: 16 }}>
        <button className="mp-btn" onClick={onBack}>BACK TO SIGN IN</button>
      </div>
    </div>
  );
}
