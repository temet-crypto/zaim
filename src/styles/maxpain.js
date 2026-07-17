// ── MAXPAIN brutalist design system (ported to ZAIM) ─────────────────────────
// Source of truth: MAXPAIN-DESIGN.md. Locked palette — do not extend.
// Five rules: 2px black borders as the only separator · no radius/shadow/gradient ·
// color = meaning (teal up / red down / blue brand) · type does the hierarchy ·
// flat edge-to-edge bands, not floating cards.

export const T = {
  blue: "#3300FF",
  black: "#0A0A0A",
  white: "#FFFFFF",
  teal: "#00C4B4",
  red: "#E8465A",
  signout: "#FF0033",
  off: "#F6F5F2",
  faint: "rgba(0,0,0,0.12)",
  faintW: "rgba(255,255,255,0.18)",
  // the only sanctioned derived colors — base-palette RGBA tints for zone maps
  tealTint: "rgba(0,196,180,0.12)",
  redTint: "rgba(232,70,90,0.12)",
  blueTint: "rgba(51,0,255,0.12)",
};

export const F = {
  display: "'Big Shoulders', sans-serif",
  body: "'DM Sans', -apple-system, sans-serif",
  mono: "'DM Mono', ui-monospace, monospace",
  italic: "'Instrument Serif', Georgia, serif",
};

// Injected once at the app root. GeoVault / AdminDashboard render inside the app,
// so they inherit these classes without re-injecting.
export const MAXPAIN_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Big+Shoulders:wght@700;800;900&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap');
:root{
  --blue:#3300FF;--black:#0A0A0A;--white:#FFFFFF;--teal:#00C4B4;--red:#E8465A;
  --signout:#FF0033;--off:#F6F5F2;--faint:rgba(0,0,0,.12);--faint-w:rgba(255,255,255,.18);
  --f-display:'Big Shoulders',sans-serif;--f-body:'DM Sans',-apple-system,sans-serif;
  --f-mono:'DM Mono',ui-monospace,monospace;--f-italic:'Instrument Serif',Georgia,serif;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body,#root{margin:0;min-height:100vh;}
body{background:var(--blue);font-family:var(--f-body);}
.mp{font-family:var(--f-body);color:var(--black);-webkit-font-smoothing:antialiased;}
.mp-shell{min-height:100vh;background:var(--blue);display:flex;justify-content:center;}
.mp-frame{width:100%;max-width:420px;min-height:100vh;background:var(--off);
  border-left:2px solid var(--black);border-right:2px solid var(--black);
  display:flex;flex-direction:column;position:relative;overflow:hidden;}
@media(min-width:460px){
  .mp-shell{padding:24px;}
  .mp-frame{min-height:calc(100vh - 48px);border:2px solid var(--black);}
}
.mp-scroll{flex:1;overflow-y:auto;overflow-x:hidden;}
.mp-scroll::-webkit-scrollbar{width:0;}
.mp-head{padding:14px 16px 12px;display:flex;justify-content:space-between;align-items:center;
  border-bottom:2px solid var(--black);background:var(--off);position:sticky;top:0;z-index:20;}
.mp-title{font-family:var(--f-display);font-weight:800;font-size:28px;line-height:1;
  letter-spacing:-.5px;text-transform:uppercase;margin:0;}
.mp-meta{font-family:var(--f-mono);font-size:11px;letter-spacing:1px;text-transform:uppercase;}
.mp-section{padding:12px 16px;font-family:var(--f-mono);font-size:11px;letter-spacing:2px;
  text-transform:uppercase;background:var(--blue);color:var(--white);border-bottom:2px solid var(--black);}
.mp-band{padding:16px;border-bottom:2px solid var(--black);background:var(--off);}
.mp-band-w{background:var(--white);}
.mp-band-blue{background:var(--blue);color:var(--white);}
.mp-lbl{font-family:var(--f-mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;}
.mp-lbl-sm{font-family:var(--f-mono);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;}
.mp-big{font-family:var(--f-display);font-weight:800;font-size:64px;line-height:.95;letter-spacing:-2px;}
.mp-mid{font-family:var(--f-display);font-weight:800;font-size:22px;line-height:1;letter-spacing:-.5px;}
.mp-quip{font-family:var(--f-italic);font-style:italic;font-size:19px;line-height:1.35;}
.mp-quip-sm{font-family:var(--f-italic);font-style:italic;font-size:16px;line-height:1.35;}
.mp-mono{font-family:var(--f-mono);font-size:12px;line-height:1.5;word-break:break-all;}
.mp-tag{display:inline-block;font-family:var(--f-display);font-weight:800;font-size:15px;line-height:1;
  padding:4px 10px;text-transform:uppercase;background:var(--black);color:var(--white);white-space:nowrap;}
.mp-tag.teal{background:var(--teal);color:var(--black);}
.mp-tag.red{background:var(--red);color:var(--white);}
.mp-tag.blue{background:var(--blue);color:var(--white);}
.mp-btn{font-family:var(--f-body);font-weight:600;font-size:15px;padding:15px 16px;width:100%;
  text-align:center;background:var(--black);color:var(--off);border:2px solid var(--black);
  cursor:pointer;transition:background 80ms;}
.mp-btn:active{background:#242424;}
.mp-btn:disabled{opacity:.5;cursor:not-allowed;}
.mp-btn.blue{background:var(--blue);color:var(--white);}
.mp-btn.danger{background:var(--signout);color:var(--white);}
.mp-btn.ghost{background:transparent;color:var(--black);}
.mp-btn.ghost:active{background:var(--faint);}
.mp-btn.display{font-family:var(--f-display);font-weight:800;font-size:20px;letter-spacing:.5px;text-transform:uppercase;}
.mp-link{font-family:var(--f-mono);font-size:11px;color:var(--blue);text-transform:uppercase;
  letter-spacing:1px;text-decoration:underline;background:none;border:none;cursor:pointer;padding:0;}
.mp-input{width:100%;font-family:var(--f-mono);font-size:14px;padding:14px;background:var(--white);
  border:2px solid var(--black);color:var(--black);outline:none;}
.mp-input:focus{border-color:var(--blue);}
.mp-input::placeholder{color:rgba(0,0,0,.4);}
.mp-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:2px solid var(--black);}
.mp-kv{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;
  border-bottom:2px solid var(--black);}
.mp-kv-key{font-family:var(--f-mono);font-size:11px;letter-spacing:1px;text-transform:uppercase;}
.mp-kv-val{font-family:var(--f-display);font-weight:800;font-size:20px;line-height:1;text-align:right;}
.mp-kv-val.mono{font-family:var(--f-mono);font-weight:400;font-size:13px;}
.mp-action{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px;
  border-bottom:2px solid var(--black);cursor:pointer;background:var(--off);transition:background 80ms;}
.mp-action:active{background:var(--faint);}
.mp-action.blue{background:var(--blue);color:var(--white);}
.mp-action-title{font-family:var(--f-display);font-weight:800;font-size:22px;line-height:1;text-transform:uppercase;}
.mp-action-sub{font-family:var(--f-mono);font-size:11px;letter-spacing:.5px;margin-top:5px;}
.mp-nav{display:flex;border-top:2px solid var(--black);background:var(--black);}
.mp-nav-tab{flex:1;height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:5px;cursor:pointer;color:var(--white);background:var(--black);transition:background 80ms;border:none;}
.mp-nav-tab.active{background:var(--blue);}
.mp-nav-tab:active{background:rgba(255,255,255,.1);}
.mp-nav-lbl{font-family:var(--f-mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;}
.mp-grid{display:grid;grid-template-columns:1fr 1fr;border-top:2px solid var(--black);border-left:2px solid var(--black);}
.mp-cell{padding:12px 14px;border-right:2px solid var(--black);border-bottom:2px solid var(--black);}
.mp-cell-key{font-family:var(--f-mono);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;}
.mp-cell-val{font-family:var(--f-display);font-weight:800;font-size:22px;line-height:1;margin-top:6px;}
`;
