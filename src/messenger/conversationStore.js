/**
 * ZAIM Conversation Store
 * 
 * Persists conversations and contacts in IndexedDB.
 * Messages are derived from on-chain memo fields during sync.
 */

import { openDB } from 'idb';

const DB_NAME = 'zaim-messenger';
const DB_VERSION = 1;

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Contacts store
      if (!db.objectStoreNames.contains('contacts')) {
        const contactStore = db.createObjectStore('contacts', { keyPath: 'address' });
        contactStore.createIndex('name', 'name');
      }

      // Messages store
      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        msgStore.createIndex('address', 'address');
        msgStore.createIndex('timestamp', 'timestamp');
        msgStore.createIndex('txid', 'txid');
      }

      // Conversations metadata
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'address' });
      }
    },
  });
}

// ─── Contacts ───

export async function saveContact(contact) {
  const db = await getDB();
  await db.put('contacts', {
    address: contact.address,
    name: contact.name || '',
    avatar: contact.avatar || contact.name?.[0]?.toUpperCase() || '?',
    color: contact.color || generateColor(contact.address),
    addedAt: contact.addedAt || Date.now(),
  });
}

export async function getContacts() {
  const db = await getDB();
  return db.getAll('contacts');
}

export async function getContact(address) {
  const db = await getDB();
  return db.get('contacts', address);
}

export async function deleteContact(address) {
  const db = await getDB();
  await db.delete('contacts', address);
}

// ─── Messages ───

export async function saveMessage(message) {
  const db = await getDB();
  // Check for duplicate (same txid)
  if (message.txid) {
    const existing = await db.getFromIndex('messages', 'txid', message.txid);
    if (existing) return existing.id;
  }

  const id = await db.add('messages', {
    address: message.address,       // counterparty address
    from: message.from,             // 'me' or 'them'
    type: message.type,             // 'text', 'invoice', 'receipt', 'payment'
    text: message.text || '',
    amount: message.amount || null,  // ZEC amount if payment/invoice
    txid: message.txid || null,
    timestamp: message.timestamp || Date.now(),
    messageId: message.messageId,
    status: message.status || 'confirmed', // 'pending', 'confirmed', 'failed'
    chain: message.chain || null,    // on-chain data for expandable view
  });

  // Update conversation metadata
  await updateConversation(message.address, message);

  return id;
}

export async function getMessages(address, limit = 50) {
  const db = await getDB();
  const tx = db.transaction('messages', 'readonly');
  const index = tx.store.index('address');
  const messages = await index.getAll(address);
  return messages.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
}

export async function updateMessageStatus(txid, status) {
  const db = await getDB();
  const msg = await db.getFromIndex('messages', 'txid', txid);
  if (msg) {
    msg.status = status;
    await db.put('messages', msg);
  }
}

// ─── Conversations ───

async function updateConversation(address, lastMessage) {
  const db = await getDB();
  const existing = await db.get('conversations', address) || { address, unread: 0 };

  await db.put('conversations', {
    ...existing,
    lastMessage: lastMessage.text || (lastMessage.amount ? `${lastMessage.amount} ZEC` : ''),
    lastTimestamp: lastMessage.timestamp,
    unread: lastMessage.from === 'them' ? existing.unread + 1 : existing.unread,
  });
}

export async function getConversations() {
  const db = await getDB();
  const convos = await db.getAll('conversations');
  const contacts = await db.getAll('contacts');

  // Merge contact info into conversations
  return convos
    .map(convo => {
      const contact = contacts.find(c => c.address === convo.address);
      return {
        ...convo,
        name: contact?.name || truncateAddress(convo.address),
        avatar: contact?.avatar || '?',
        color: contact?.color || '#666',
      };
    })
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
}

export async function markConversationRead(address) {
  const db = await getDB();
  const convo = await db.get('conversations', address);
  if (convo) {
    convo.unread = 0;
    await db.put('conversations', convo);
  }
}

// ─── Utilities ───

function truncateAddress(addr) {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function generateColor(address) {
  // Deterministic color from address
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = address.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 60%, 50%)`;
}

export async function clearAllData() {
  const db = await getDB();
  await db.clear('contacts');
  await db.clear('messages');
  await db.clear('conversations');
}
