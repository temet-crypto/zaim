/**
 * ZAIM Wallet Provider
 * 
 * React context providing wallet state and operations to the entire app.
 * Handles initialization, sync lifecycle, and state persistence.
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  initializeWasm,
  createWalletInstance,
  createAccount,
  importAccount,
  startSync,
  getBalance,
  sendMessage,
  sendPayment,
  getAddress,
  exportWalletState,
  setNetwork,
  DUST_AMOUNT,
} from './walletCore.js';
import {
  generateSeedPhrase,
  validateSeedPhrase,
  saveWalletState,
  loadWalletState,
  hasWalletState,
  saveSeedPhrase,
  deleteWalletData,
} from './keyManager.js';
import { encodeTextMessage, encodeInvoice, decodeMemo, isZaimMessage } from './memoCodec.js';

// ─── Context ───

const WalletContext = createContext(null);

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}

// ─── Wallet States ───

export const WalletStatus = {
  UNINITIALIZED: 'uninitialized',   // App just loaded, nothing started
  INITIALIZING: 'initializing',     // WASM loading
  NO_WALLET: 'no_wallet',           // No saved wallet, show onboarding
  LOCKED: 'locked',                 // Wallet exists but needs password
  UNLOCKING: 'unlocking',           // Decrypting wallet state
  SYNCING: 'syncing',               // Connected and syncing blockchain
  READY: 'ready',                   // Fully synced and operational
  ERROR: 'error',                   // Something went wrong
};

// ─── Provider Component ───

export function WalletProvider({ children }) {
  const [status, setStatus] = useState(WalletStatus.UNINITIALIZED);
  const [error, setError] = useState(null);
  const [balance, setBalance] = useState({ confirmed: 0n, pending: 0n });
  const [address, setAddress] = useState('');
  const [syncProgress, setSyncProgress] = useState(0);
  const [seedPhrase, setSeedPhrase] = useState(null); // Only during onboarding
  const syncIntervalRef = useRef(null);

  // ─── Initialization ───

  useEffect(() => {
    initialize();
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []);

  async function initialize() {
    try {
      setStatus(WalletStatus.INITIALIZING);

      // Initialize WASM module
      await initializeWasm();

      // Check for existing wallet
      const exists = await hasWalletState();
      setStatus(exists ? WalletStatus.LOCKED : WalletStatus.NO_WALLET);
    } catch (err) {
      console.error('[ZAIM] Initialization failed:', err);
      setError(err.message);
      setStatus(WalletStatus.ERROR);
    }
  }

  // ─── Wallet Creation ───

  const createNewWallet = useCallback(async (password) => {
    try {
      setStatus(WalletStatus.INITIALIZING);

      // Generate seed phrase
      const seed = await generateSeedPhrase();
      setSeedPhrase(seed);

      // Create wallet instance
      await createWalletInstance(null);

      // Create account (use current block height as birthday for new wallets)
      // In production, fetch current height from lightwalletd
      await createAccount(seed, 0, 'default', 0);

      // Save encrypted state
      const dbBytes = await exportWalletState();
      await saveWalletState(dbBytes, password);
      await saveSeedPhrase(seed, password);

      // Get address
      const addr = await getAddress();
      setAddress(addr);

      // Start syncing
      setStatus(WalletStatus.SYNCING);
      await performSync();

      return seed;
    } catch (err) {
      console.error('[ZAIM] Wallet creation failed:', err);
      setError(err.message);
      setStatus(WalletStatus.ERROR);
      throw err;
    }
  }, []);

  const importExistingWallet = useCallback(async (seed, password, birthdayHeight = 0) => {
    try {
      setStatus(WalletStatus.INITIALIZING);

      const isValid = await validateSeedPhrase(seed);
      if (!isValid) throw new Error('Invalid seed phrase');

      await createWalletInstance(null);
      await importAccount(seed, birthdayHeight, 'imported');

      const dbBytes = await exportWalletState();
      await saveWalletState(dbBytes, password);
      await saveSeedPhrase(seed, password);

      const addr = await getAddress();
      setAddress(addr);

      setStatus(WalletStatus.SYNCING);
      await performSync();
    } catch (err) {
      console.error('[ZAIM] Import failed:', err);
      setError(err.message);
      setStatus(WalletStatus.ERROR);
      throw err;
    }
  }, []);

  // ─── Unlock ───

  const unlock = useCallback(async (password) => {
    try {
      setStatus(WalletStatus.UNLOCKING);

      const dbBytes = await loadWalletState(password);
      if (!dbBytes) throw new Error('No wallet state found');

      await createWalletInstance(dbBytes);

      const addr = await getAddress();
      setAddress(addr);

      setStatus(WalletStatus.SYNCING);
      await performSync();
    } catch (err) {
      console.error('[ZAIM] Unlock failed:', err);
      setError(err.message);
      setStatus(WalletStatus.LOCKED);
      throw err;
    }
  }, []);

  // ─── Sync ───

  async function performSync() {
    try {
      await startSync((progress) => {
        setSyncProgress(progress?.percent || 0);
      });

      const bal = await getBalance();
      setBalance(bal);

      // Save updated wallet state periodically
      // (in production, also save after each sync)

      setStatus(WalletStatus.READY);

      // Set up periodic re-sync (every 75 seconds = ~1 block)
      syncIntervalRef.current = setInterval(async () => {
        try {
          await startSync();
          const updatedBal = await getBalance();
          setBalance(updatedBal);
        } catch (err) {
          console.warn('[ZAIM] Background sync error:', err);
        }
      }, 75_000);
    } catch (err) {
      console.error('[ZAIM] Sync failed:', err);
      setError(err.message);
      setStatus(WalletStatus.ERROR);
    }
  }

  // ─── Send Operations ───

  const sendTextMessage = useCallback(async (toAddress, text) => {
    const memo = encodeTextMessage(text);
    return sendMessage(toAddress, memo);
  }, []);

  const sendZecPayment = useCallback(async (toAddress, amountZec, message = '') => {
    const zatoshis = BigInt(Math.round(amountZec * 1e8));
    return sendPayment(toAddress, zatoshis, message);
  }, []);

  const sendInvoice = useCallback(async (toAddress, amountZec, note = '') => {
    const zatoshis = BigInt(Math.round(amountZec * 1e8));
    const memo = encodeInvoice(zatoshis, note);
    return sendMessage(toAddress, memo);
  }, []);

  // ─── Lock / Reset ───

  const lock = useCallback(async (password) => {
    try {
      const dbBytes = await exportWalletState();
      await saveWalletState(dbBytes, password);
    } catch (err) {
      console.warn('[ZAIM] Error saving state on lock:', err);
    }

    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }

    setStatus(WalletStatus.LOCKED);
    setBalance({ confirmed: 0n, pending: 0n });
    setAddress('');
  }, []);

  const resetWallet = useCallback(async () => {
    await deleteWalletData();
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    setStatus(WalletStatus.NO_WALLET);
    setBalance({ confirmed: 0n, pending: 0n });
    setAddress('');
    setSeedPhrase(null);
  }, []);

  // ─── Context Value ───

  const value = {
    // State
    status,
    error,
    balance,
    address,
    syncProgress,
    seedPhrase,

    // Computed
    isReady: status === WalletStatus.READY,
    isLocked: status === WalletStatus.LOCKED,
    needsOnboarding: status === WalletStatus.NO_WALLET,
    balanceZec: Number(balance.confirmed) / 1e8,

    // Actions
    createNewWallet,
    importExistingWallet,
    unlock,
    lock,
    resetWallet,
    sendTextMessage,
    sendZecPayment,
    sendInvoice,
    clearSeedPhrase: () => setSeedPhrase(null),
    clearError: () => setError(null),
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export default WalletProvider;
