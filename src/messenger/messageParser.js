/**
 * ZAIM Message Parser
 * 
 * Processes incoming transaction memos from blockchain sync,
 * identifies ZAIM messages, and routes them to the conversation store.
 */

import { decodeMemo, isZaimMessage, reassembleChunks, MessageType } from '../wallet/memoCodec.js';
import { saveMessage, getContact, saveContact } from './conversationStore.js';

// Buffer for chunked messages awaiting reassembly
const chunkBuffer = new Map(); // messageId → { chunks: [], timeout }

/**
 * Process a batch of incoming transactions from a sync cycle.
 * Extracts ZAIM messages from memo fields and stores them.
 * 
 * @param {Array} transactions - Transactions from WebZjs sync
 * @param {string} myAddress - Our wallet address (to determine direction)
 * @returns {Array} New messages added
 */
export async function processIncomingTransactions(transactions, myAddress) {
  const newMessages = [];

  for (const tx of transactions) {
    // Skip transactions without memo fields
    if (!tx.memo) continue;

    const memoBytes = typeof tx.memo === 'string'
      ? new TextEncoder().encode(tx.memo)
      : new Uint8Array(tx.memo);

    // Check if this is a ZAIM message
    if (!isZaimMessage(memoBytes)) continue;

    const decoded = decodeMemo(memoBytes);
    if (!decoded) continue;

    // Determine direction
    const from = tx.from === myAddress ? 'me' : 'them';
    const counterpartyAddress = from === 'me' ? tx.to : tx.from;

    // Handle chunked messages
    if (decoded.isChunked) {
      const assembled = handleChunk(decoded, tx, counterpartyAddress, from);
      if (assembled) {
        newMessages.push(assembled);
      }
      continue;
    }

    // Process single message
    const message = await processMessage(decoded, tx, counterpartyAddress, from);
    if (message) {
      newMessages.push(message);
    }
  }

  return newMessages;
}

/**
 * Process a single decoded ZAIM message.
 */
async function processMessage(decoded, tx, counterpartyAddress, from) {
  const baseMsg = {
    address: counterpartyAddress,
    from,
    txid: tx.txid,
    timestamp: decoded.timestamp * 1000 || tx.timestamp || Date.now(),
    messageId: decoded.messageId,
    status: 'confirmed',
    chain: {
      txid: tx.txid,
      blockHeight: tx.blockHeight,
      confirmations: tx.confirmations,
      fee: tx.fee,
      timestamp: decoded.timestamp,
    },
  };

  switch (decoded.type) {
    case MessageType.TEXT:
      return await saveAndReturn({
        ...baseMsg,
        type: 'text',
        text: decoded.text,
      });

    case MessageType.INVOICE:
      return await saveAndReturn({
        ...baseMsg,
        type: 'invoice',
        text: decoded.note || 'Payment requested',
        amount: decoded.amountZec,
      });

    case MessageType.READ_RECEIPT:
      // Update the referenced message's read status
      // (don't create a visible message)
      console.log(`[ZAIM] Read receipt for message #${decoded.acknowledgedMessageId}`);
      return null;

    default:
      console.log(`[ZAIM] Unknown message type: ${decoded.type}`);
      return null;
  }
}

/**
 * Handle a chunked message fragment.
 * Buffers chunks and reassembles when all parts arrive.
 */
function handleChunk(decoded, tx, counterpartyAddress, from) {
  const key = `${counterpartyAddress}-${decoded.messageId}`;

  if (!chunkBuffer.has(key)) {
    chunkBuffer.set(key, {
      chunks: [],
      from,
      address: counterpartyAddress,
      txid: tx.txid,
      timestamp: decoded.timestamp,
      chain: {
        txid: tx.txid,
        blockHeight: tx.blockHeight,
      },
    });

    // Auto-expire buffer after 10 minutes (in case chunks never complete)
    setTimeout(() => {
      if (chunkBuffer.has(key)) {
        console.warn(`[ZAIM] Chunk buffer expired for ${key}`);
        chunkBuffer.delete(key);
      }
    }, 600_000);
  }

  const buffer = chunkBuffer.get(key);
  buffer.chunks[decoded.chunkIndex] = decoded;

  // Check if all chunks have arrived (max 4)
  const hasAll = buffer.chunks.length > 0 &&
    buffer.chunks.every((c, i) => c !== undefined) &&
    (!buffer.chunks[buffer.chunks.length - 1]?.isChunked ||
     buffer.chunks.length >= 4);

  if (hasAll) {
    const fullText = reassembleChunks(buffer.chunks);
    chunkBuffer.delete(key);

    return saveAndReturn({
      address: buffer.address,
      from: buffer.from,
      type: 'text',
      text: fullText,
      txid: buffer.txid,
      timestamp: buffer.timestamp * 1000,
      messageId: decoded.messageId,
      status: 'confirmed',
      chain: buffer.chain,
    });
  }

  return null; // Still waiting for more chunks
}

/**
 * Save message and return it.
 */
async function saveAndReturn(message) {
  await saveMessage(message);

  // Auto-create contact if we don't have one
  if (message.from === 'them') {
    const existing = await getContact(message.address);
    if (!existing) {
      await saveContact({
        address: message.address,
        name: '', // Unknown — user can name them later
      });
    }
  }

  return message;
}

/**
 * Create and save an outgoing message (called before sending tx).
 * Sets status to 'pending' until confirmed on-chain.
 */
export async function createOutgoingMessage(toAddress, text, type = 'text', amount = null) {
  const message = {
    address: toAddress,
    from: 'me',
    type,
    text,
    amount,
    txid: null, // Will be updated after broadcast
    timestamp: Date.now(),
    messageId: Math.floor(Math.random() * 0xFFFF),
    status: 'pending',
    chain: null,
  };

  const id = await saveMessage(message);
  return { ...message, id };
}
