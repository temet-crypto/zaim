/**
 * ZAIM Key Manager
 * 
 * Handles seed phrase generation, password-based encryption of wallet state,
 * and secure storage in IndexedDB. No seed phrase or key material ever
 * touches localStorage or plaintext storage.
 * 
 * Encryption: AES-256-GCM with PBKDF2-derived key (100k iterations)
 */

import { openDB } from 'idb';

const DB_NAME = 'zaim-wallet';
const DB_VERSION = 1;
const STORE_NAME = 'wallet-state';
const PBKDF2_ITERATIONS = 100_000;

// ─── IndexedDB Setup ───

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

// ─── Seed Phrase Generation ───

/**
 * Generate a new BIP39 24-word seed phrase.
 * Uses WebCrypto for entropy generation.
 * 
 * NOTE: In production, use a proper BIP39 library (@scure/bip39)
 * for wordlist validation and checksum. This is a simplified version.
 * 
 * @returns {string} 24-word mnemonic phrase
 */
export async function generateSeedPhrase() {
  // In production, import from @scure/bip39:
  // import { generateMnemonic } from '@scure/bip39';
  // import { wordlist } from '@scure/bip39/wordlists/english';
  // return generateMnemonic(wordlist, 256);

  // Placeholder — MUST use proper BIP39 library in production
  const { generateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english');
  return generateMnemonic(wordlist, 256); // 256 bits = 24 words
}

/**
 * Validate a seed phrase.
 * 
 * @param {string} phrase - Space-separated word list
 * @returns {boolean}
 */
export async function validateSeedPhrase(phrase) {
  try {
    const { validateMnemonic } = await import('@scure/bip39');
    const { wordlist } = await import('@scure/bip39/wordlists/english');
    return validateMnemonic(phrase.trim(), wordlist);
  } catch {
    return false;
  }
}

// ─── Encryption / Decryption ───

/**
 * Derive an AES-256 key from a user password using PBKDF2.
 */
async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt data with a password.
 * 
 * @param {Uint8Array} data - Data to encrypt
 * @param {string} password - User password
 * @returns {{ encrypted: Uint8Array, salt: Uint8Array, iv: Uint8Array }}
 */
export async function encryptData(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  );

  return {
    encrypted: new Uint8Array(encrypted),
    salt,
    iv,
  };
}

/**
 * Decrypt data with a password.
 * 
 * @param {{ encrypted: Uint8Array, salt: Uint8Array, iv: Uint8Array }} encryptedData
 * @param {string} password - User password
 * @returns {Uint8Array} Decrypted data
 */
export async function decryptData(encryptedData, password) {
  const { encrypted, salt, iv } = encryptedData;
  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );

  return new Uint8Array(decrypted);
}

// ─── Wallet State Persistence ───

/**
 * Save encrypted wallet state to IndexedDB.
 * 
 * @param {Uint8Array} walletDbBytes - Serialized wallet state from WebZjs
 * @param {string} password - User password for encryption
 */
export async function saveWalletState(walletDbBytes, password) {
  const encryptedState = await encryptData(walletDbBytes, password);
  const db = await getDB();
  await db.put(STORE_NAME, {
    encrypted: Array.from(encryptedState.encrypted),
    salt: Array.from(encryptedState.salt),
    iv: Array.from(encryptedState.iv),
    timestamp: Date.now(),
  }, 'wallet-db');
  console.log('[ZAIM] Wallet state saved (encrypted)');
}

/**
 * Load and decrypt wallet state from IndexedDB.
 * 
 * @param {string} password - User password for decryption
 * @returns {Uint8Array|null} Decrypted wallet DB bytes, or null if not found
 */
export async function loadWalletState(password) {
  const db = await getDB();
  const stored = await db.get(STORE_NAME, 'wallet-db');

  if (!stored) return null;

  try {
    const decrypted = await decryptData({
      encrypted: new Uint8Array(stored.encrypted),
      salt: new Uint8Array(stored.salt),
      iv: new Uint8Array(stored.iv),
    }, password);
    console.log('[ZAIM] Wallet state loaded (decrypted)');
    return decrypted;
  } catch (err) {
    console.error('[ZAIM] Failed to decrypt wallet state — wrong password?');
    throw new Error('Invalid password');
  }
}

/**
 * Check if a saved wallet state exists.
 */
export async function hasWalletState() {
  const db = await getDB();
  const stored = await db.get(STORE_NAME, 'wallet-db');
  return !!stored;
}

/**
 * Save encrypted seed phrase backup to IndexedDB.
 * This is the "nuclear option" backup — user should also have written it down.
 */
export async function saveSeedPhrase(seedPhrase, password) {
  const encoder = new TextEncoder();
  const encryptedSeed = await encryptData(encoder.encode(seedPhrase), password);
  const db = await getDB();
  await db.put(STORE_NAME, {
    encrypted: Array.from(encryptedSeed.encrypted),
    salt: Array.from(encryptedSeed.salt),
    iv: Array.from(encryptedSeed.iv),
  }, 'seed-backup');
}

/**
 * Delete all wallet data from IndexedDB.
 * Nuclear option — use with extreme caution.
 */
export async function deleteWalletData() {
  const db = await getDB();
  await db.delete(STORE_NAME, 'wallet-db');
  await db.delete(STORE_NAME, 'seed-backup');
  console.log('[ZAIM] All wallet data deleted');
}
