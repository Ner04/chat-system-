// Presence layer: online / last seen / typing.
// Kept in memory with TTL semantics (Redis in production) and NEVER written to disk:
// it is worthless in 60s and losing it costs nothing.
//
// Delivery is subscription-based: a device only gets presence for users in the chat
// it currently has open, which turns "everyone in my contacts" into 0–2 recipients.
const registry = require('./connectionRegistry');

const lastSeen = new Map(); // user_id -> Date (last heartbeat)
const subscribers = new Map(); // watched user_id -> Set<device_id>
const subscriptionOf = new Map(); // device_id -> Set<watched user_id>

function state(userId) {
  return { type: 'presence', user_id: userId, online: registry.isUserOnline(userId), last_seen: lastSeen.get(userId) || null };
}

function broadcast(userId) {
  const ev = state(userId);
  for (const dev of subscribers.get(userId) || []) registry.send(dev, ev);
}

function heartbeat(userId) {
  lastSeen.set(userId, new Date());
}

function subscribe(deviceId, userIds) {
  unsubscribe(deviceId);
  const set = new Set(userIds);
  subscriptionOf.set(deviceId, set);
  for (const u of set) {
    if (!subscribers.has(u)) subscribers.set(u, new Set());
    subscribers.get(u).add(deviceId);
    registry.send(deviceId, state(u));
  }
}

function unsubscribe(deviceId) {
  for (const u of subscriptionOf.get(deviceId) || []) subscribers.get(u)?.delete(deviceId);
  subscriptionOf.delete(deviceId);
}

// Typing is an ephemeral event: never stored, receivers auto-expire it after ~5s,
// clients throttle to one event every few seconds.
const lastTyping = new Map(); // `${device}:${chat}` -> ms
function typing(sender, chat) {
  const key = `${sender.deviceId}:${chat._id}`;
  const now = Date.now();
  if (now - (lastTyping.get(key) || 0) < 2000) return; // server-side throttle too
  lastTyping.set(key, now);
  const ev = { type: 'typing', chat_id: chat._id, user_id: sender.userId };
  // Only devices that have this chat open (= are subscribed to the sender) get it.
  for (const dev of subscribers.get(sender.userId) || []) {
    const viewer = registry.socketFor(dev)?.auth.userId;
    if (viewer && viewer !== sender.userId && chat.members.includes(viewer)) registry.send(dev, ev);
  }
}

module.exports = { heartbeat, subscribe, unsubscribe, broadcast, typing, state };
