// Where the seed lives between sign in and a send.
//
// In memory, in this tab, and nowhere else. Not localStorage, not
// sessionStorage, not IndexedDB — a seed written to disk by the browser
// outlives the session and shows up in profile backups and forensic images.
// A module variable dies with the tab, which is the behaviour we want.
//
// The consequence is deliberate and visible to the user: reload the page and
// the session keeps reading (the server still holds the viewing key) but can
// no longer send until the seed is supplied again. A read-only session that
// survives a refresh is the safe default; silently keeping spend authority
// around would be the surprising one.

let seed = null;

export function holdSeed(mnemonic) {
  seed = (mnemonic || "").trim().toLowerCase() || null;
}

/** The seed for one send. Callers must not store what they get back. */
export function takeSeed() {
  return seed;
}

export function canSpend() {
  return seed !== null;
}

export function forgetSeed() {
  seed = null;
}

// Signing out or closing the tab must not leave it reachable.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", forgetSeed);
}
