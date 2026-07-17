/**
 * ZAIM Wallet Core — API Mode
 * Calls the FastAPI backend which talks to zcashd.
 * Real Zcash addresses, real transactions.
 */

const API_BASE = '/api';
let authToken = null;
let walletState = null;

// ── API Helper ──
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.detail || `API error: ${resp.status}`);
  }
  return data;
}

// ── Initialization ──
export async function initializeWasm() {
  // No WASM needed — check if backend is reachable
  try {
    const health = await api('/health');
    console.log('[ZAIM] Backend connected:', health.status);
    if (health.zcashd && !health.zcashd.synced) {
      console.warn('[ZAIM] zcashd is still syncing. Some features may be limited.');
    }
    return health;
  } catch (e) {
    console.error('[ZAIM] Backend not reachable:', e.message);
    throw new Error('Cannot connect to ZAIM server. Please try again later.');
  }
}

// ── Wallet Creation ──
export async function createWalletInstance(dbBytes = null) {
  walletState = { accounts: [], synced: false };
  return walletState;
}

export async function createAccount(seedPhrase, birthdayHeight, accountName = 'default') {
  // seedPhrase is repurposed as username in API mode
  // The API creates the real zcashd HD account
  // This gets called from the onboarding flow
  console.log('[ZAIM] Creating wallet via API...');
  // Actual creation happens in createNewWallet in WalletProvider
}

export async function createNewWallet(username, password) {
  const result = await api('/wallet/create', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  authToken = result.token;
  localStorage.setItem('zaim_token', authToken);
  localStorage.setItem('zaim_username', username);

  walletState = {
    accounts: [{
      name: username,
      address: result.address,
      receivers: result.receivers,
    }],
    synced: true,
  };

  return result;
}

export async function login(username, password) {
  const result = await api('/wallet/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  authToken = result.token;
  localStorage.setItem('zaim_token', authToken);
  localStorage.setItem('zaim_username', username);

  walletState = {
    accounts: [{
      name: username,
      address: result.address,
      receivers: result.receivers,
    }],
    synced: true,
  };

  return result;
}

export function restoreSession() {
  const token = localStorage.getItem('zaim_token');
  const username = localStorage.getItem('zaim_username');
  if (token && username) {
    authToken = token;
    return { username };
  }
  return null;
}

export function logout() {
  authToken = null;
  walletState = null;
  localStorage.removeItem('zaim_token');
  localStorage.removeItem('zaim_username');
}

// ── Balance ──
export async function getBalance() {
  const data = await api('/wallet/balance');
  return data;
}

// ── Address ──
export async function getAddress() {
  if (walletState && walletState.accounts.length > 0) {
    return walletState.accounts[0].address;
  }
  const data = await api('/wallet/address');
  return data.unified_address;
}

// ── Send Payment ──
export async function sendPayment(toAddress, amount, message = '') {
  const data = await api('/wallet/send', {
    method: 'POST',
    body: JSON.stringify({
      to_address: toAddress,
      amount: amount,
      memo: message,
    }),
  });
  return data;
}

// ── Send Message ──
export async function sendMessage(toAddress, message) {
  const data = await api('/message/send', {
    method: 'POST',
    body: JSON.stringify({
      to_address: toAddress,
      message: message,
    }),
  });
  return data;
}

// ── Receive Messages ──
export async function getMessages() {
  const data = await api('/messages');
  return data.messages;
}

// ── Transaction History ──
export async function getTransactions(count = 20) {
  const data = await api(`/wallet/transactions?count=${count}`);
  return data.transactions;
}

// ── Operation Status ──
export async function checkOperation(opId) {
  const data = await api(`/wallet/operation/${opId}`);
  return data;
}

// ── Contacts ──
export async function addContact(name, address) {
  return api('/contacts', {
    method: 'POST',
    body: JSON.stringify({ name, address }),
  });
}

export async function getContacts() {
  const data = await api('/contacts');
  return data.contacts;
}

// ── Sync (polls for new messages) ──
export async function startSync(onProgress) {
  // In API mode, sync just checks node status and fetches messages
  if (onProgress) onProgress({ current: 50, total: 100, percent: 50 });
  try {
    const health = await api('/health');
    if (onProgress) onProgress({ current: 100, total: 100, percent: 100 });
    return health;
  } catch (e) {
    if (onProgress) onProgress({ current: 100, total: 100, percent: 100 });
    throw e;
  }
}

// ── Node Info (public) ──
export async function getNodeInfo() {
  return api('/node/info');
}

export function getWalletInstance() {
  return walletState;
}

export function isAuthenticated() {
  return !!authToken;
}

export const DUST_AMOUNT = 0.0001;
export const NETWORKS = {
  main: { name: 'main', explorerUrl: 'https://zcashblockexplorer.com' },
  test: { name: 'test', explorerUrl: 'https://explorer.testnet.z.cash' },
};

// ─── Stubs for WalletProvider compatibility ───────────────────────────────────
export async function importAccount(seedPhrase, birthdayHeight, accountName = 'default') {
  return createAccount(seedPhrase, birthdayHeight, accountName);
}

export async function exportWalletState() {
  return null;
}

export function setNetwork(network) {
  // network switching not yet implemented
  console.log('setNetwork called with:', network);
}
