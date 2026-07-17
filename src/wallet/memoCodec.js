/**
 * ZAIM Memo Codec
 * 
 * Encodes and decodes ZAIM messages within the 512-byte Zcash memo field.
 * The memo field is already E2E encrypted by the Zcash protocol (zk-SNARKs),
 * so we don't need additional encryption — just structured encoding.
 * 
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Byte 0     │ Protocol version (0x01)                       │
 * │ Byte 1     │ Message type (text, invoice, receipt, etc.)   │
 * │ Bytes 2-5  │ Timestamp (uint32 unix epoch)                 │
 * │ Bytes 6-7  │ Message ID (uint16)                           │
 * │ Byte 8     │ Flags (reply, chunked, chunk_index)           │
 * │ Bytes 9-10 │ Reply-to ID (if reply flag set)               │
 * │ Bytes 11+  │ Payload (up to 501 bytes UTF-8)               │
 * └─────────────────────────────────────────────────────────────┘
 */

const MEMO_SIZE = 512;
const HEADER_SIZE = 11;
const MAX_PAYLOAD = MEMO_SIZE - HEADER_SIZE; // 501 bytes
const PROTOCOL_VERSION = 0x01;
const ZAIM_MAGIC = 0x5A; // 'Z' — quick check if memo is a ZAIM message

// Message types
export const MessageType = {
  TEXT: 0x01,
  INVOICE: 0x02,
  READ_RECEIPT: 0x03,
  CONTACT_CARD: 0x04,
  FILE_REF: 0x05,
};

// Flag bits
const FLAG_IS_REPLY = 0x01;
const FLAG_IS_CHUNKED = 0x02;
const CHUNK_INDEX_MASK = 0x0C; // bits 2-3
const CHUNK_INDEX_SHIFT = 2;

// ─── Encoder ───

/**
 * Encode a text message into a ZAIM memo buffer.
 * 
 * @param {string} text - Message text (up to ~500 chars)
 * @param {object} options
 * @param {number} options.replyTo - Message ID to reply to
 * @param {number} options.messageId - Explicit message ID (auto-generated if omitted)
 * @returns {Uint8Array} 512-byte memo buffer
 */
export function encodeTextMessage(text, options = {}) {
  return encodeMemo({
    type: MessageType.TEXT,
    payload: new TextEncoder().encode(text),
    ...options,
  });
}

/**
 * Encode an invoice/payment request.
 * 
 * @param {bigint} amountZatoshis - Requested amount in zatoshis
 * @param {string} note - Optional note text
 * @returns {Uint8Array} 512-byte memo buffer
 */
export function encodeInvoice(amountZatoshis, note = '') {
  // Invoice payload: 8 bytes amount + text
  const amountBytes = new Uint8Array(8);
  const view = new DataView(amountBytes.buffer);
  view.setBigUint64(0, amountZatoshis, false); // big-endian

  const noteBytes = new TextEncoder().encode(note);
  const payload = new Uint8Array(8 + noteBytes.length);
  payload.set(amountBytes);
  payload.set(noteBytes, 8);

  return encodeMemo({ type: MessageType.INVOICE, payload });
}

/**
 * Encode a read receipt.
 * 
 * @param {number} messageId - ID of the message being acknowledged
 * @returns {Uint8Array} 512-byte memo buffer
 */
export function encodeReadReceipt(messageId) {
  const payload = new Uint8Array(2);
  new DataView(payload.buffer).setUint16(0, messageId, false);
  return encodeMemo({ type: MessageType.READ_RECEIPT, payload });
}

/**
 * Low-level memo encoder.
 */
function encodeMemo({ type, payload, replyTo, messageId, chunkIndex = 0, isChunked = false }) {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`Payload too large: ${payload.length} bytes (max ${MAX_PAYLOAD})`);
  }

  const memo = new Uint8Array(MEMO_SIZE);
  const view = new DataView(memo.buffer);

  // Header
  memo[0] = PROTOCOL_VERSION;
  memo[1] = type;
  view.setUint32(2, Math.floor(Date.now() / 1000), false); // timestamp
  view.setUint16(6, messageId ?? generateMessageId(), false); // message ID

  // Flags
  let flags = 0;
  if (replyTo !== undefined) flags |= FLAG_IS_REPLY;
  if (isChunked) flags |= FLAG_IS_CHUNKED;
  flags |= (chunkIndex << CHUNK_INDEX_SHIFT) & CHUNK_INDEX_MASK;
  memo[8] = flags;

  // Reply-to
  if (replyTo !== undefined) {
    view.setUint16(9, replyTo, false);
  }

  // Payload
  memo.set(payload, HEADER_SIZE);

  return memo;
}

// ─── Decoder ───

/**
 * Decode a raw memo buffer into a ZAIM message object.
 * Returns null if the memo isn't a valid ZAIM message.
 * 
 * @param {Uint8Array} memoBytes - Raw 512-byte memo
 * @returns {object|null} Parsed message or null
 */
export function decodeMemo(memoBytes) {
  if (!memoBytes || memoBytes.length < HEADER_SIZE) return null;

  // Check protocol version
  if (memoBytes[0] !== PROTOCOL_VERSION) return null;

  const view = new DataView(memoBytes.buffer, memoBytes.byteOffset);

  const type = memoBytes[1];
  const timestamp = view.getUint32(2, false);
  const messageId = view.getUint16(6, false);
  const flags = memoBytes[8];

  const isReply = !!(flags & FLAG_IS_REPLY);
  const isChunked = !!(flags & FLAG_IS_CHUNKED);
  const chunkIndex = (flags & CHUNK_INDEX_MASK) >> CHUNK_INDEX_SHIFT;

  const replyTo = isReply ? view.getUint16(9, false) : null;

  // Extract payload (everything after header, trimmed of trailing zeros)
  const rawPayload = memoBytes.slice(HEADER_SIZE);
  let payloadEnd = rawPayload.length;
  while (payloadEnd > 0 && rawPayload[payloadEnd - 1] === 0) payloadEnd--;
  const payload = rawPayload.slice(0, payloadEnd);

  const base = {
    type,
    timestamp,
    messageId,
    isReply,
    isChunked,
    chunkIndex,
    replyTo,
    date: new Date(timestamp * 1000),
  };

  // Type-specific decoding
  switch (type) {
    case MessageType.TEXT:
      return {
        ...base,
        text: new TextDecoder().decode(payload),
      };

    case MessageType.INVOICE: {
      const amountView = new DataView(payload.buffer, payload.byteOffset);
      const amount = amountView.getBigUint64(0, false);
      const note = payload.length > 8
        ? new TextDecoder().decode(payload.slice(8))
        : '';
      return {
        ...base,
        amount, // in zatoshis
        amountZec: Number(amount) / 1e8,
        note,
      };
    }

    case MessageType.READ_RECEIPT: {
      const ackView = new DataView(payload.buffer, payload.byteOffset);
      return {
        ...base,
        acknowledgedMessageId: ackView.getUint16(0, false),
      };
    }

    default:
      return {
        ...base,
        rawPayload: payload,
      };
  }
}

/**
 * Check if a raw memo buffer contains a ZAIM message.
 * Quick check without full decode.
 */
export function isZaimMessage(memoBytes) {
  return memoBytes && memoBytes.length >= HEADER_SIZE && memoBytes[0] === PROTOCOL_VERSION;
}

// ─── Chunking ───

/**
 * Split a long message into multiple ZAIM memo chunks.
 * Each chunk is a separate transaction.
 * 
 * @param {string} text - Long message text
 * @returns {Uint8Array[]} Array of 512-byte memo buffers (max 4)
 */
export function chunkMessage(text) {
  const encoded = new TextEncoder().encode(text);
  const chunks = [];
  const messageId = generateMessageId();

  for (let i = 0; i < encoded.length && chunks.length < 4; i += MAX_PAYLOAD) {
    const chunk = encoded.slice(i, i + MAX_PAYLOAD);
    chunks.push(encodeMemo({
      type: MessageType.TEXT,
      payload: chunk,
      messageId,
      isChunked: true,
      chunkIndex: chunks.length,
    }));
  }

  return chunks;
}

/**
 * Reassemble chunked messages.
 * 
 * @param {object[]} messages - Array of decoded ZAIM messages with same messageId
 * @returns {string} Reassembled text
 */
export function reassembleChunks(messages) {
  const sorted = messages
    .filter(m => m.isChunked)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);

  return sorted.map(m => m.text || '').join('');
}

// ─── Utilities ───

function generateMessageId() {
  return Math.floor(Math.random() * 0xFFFF);
}

/**
 * Get the maximum text length for a single memo.
 * UTF-8 can use 1-4 bytes per character, so this is approximate.
 */
export function getMaxTextLength() {
  return MAX_PAYLOAD; // 501 bytes, ~500 ASCII chars, ~167 emoji/CJK chars
}
