// Chat + Group service: membership, admins, per-chat sequence counter.
const { db } = require('../db');
const config = require('../config');
const bus = require('../pipeline/bus');
const users = require('./users');
const { newId, HttpError } = require('../util');

async function getChatForMember(chatId, userId) {
  const chat = await db.chats.findOne({ _id: chatId });
  if (!chat || !chat.members.includes(userId)) throw new HttpError(404, 'chat_not_found', 'Chat not found');
  return chat;
}

async function openDirect(userId, phone) {
  const other = await users.findByPhone(phone);
  if (other._id === userId) throw new HttpError(400, 'self_chat', "You can't start a chat with yourself");
  const pair = [userId, other._id].sort();
  const direct_key = pair.join('|');
  const now = new Date();
  await db.chats.updateOne(
    { type: 'direct', direct_key },
    { $setOnInsert: { _id: newId('cht'), type: 'direct', direct_key, members: pair, last_seq: 0, created_at: now, last_message_at: now } },
    { upsert: true },
  );
  const chat = await db.chats.findOne({ type: 'direct', direct_key });
  bus.publish('chat.updated', { chat_id: chat._id, members: chat.members });
  return describe(chat, userId);
}

async function createGroup(userId, { name, members = [] }) {
  const title = String(name || '').trim().slice(0, 60);
  if (!title) throw new HttpError(400, 'invalid_name', 'Give the group a name');
  const ids = new Set([userId]);
  for (const phone of members) ids.add((await users.findByPhone(phone))._id);
  if (ids.size > config.maxGroupSize) throw new HttpError(400, 'group_too_large', `Groups are capped at ${config.maxGroupSize} members`);
  const now = new Date();
  const chat = {
    _id: newId('grp'), type: 'group', name: title, members: [...ids], admins: [userId],
    created_by: userId, last_seq: 0, created_at: now, last_message_at: now,
  };
  await db.chats.insertOne(chat);
  bus.publish('chat.updated', { chat_id: chat._id, members: chat.members });
  return describe(chat, userId);
}

async function addMember(userId, groupId, phone) {
  const chat = await getChatForMember(groupId, userId);
  if (chat.type !== 'group') throw new HttpError(400, 'not_group');
  if (!chat.admins.includes(userId)) throw new HttpError(403, 'not_admin', 'Only group admins can add people');
  const u = await users.findByPhone(phone);
  if (chat.members.length >= config.maxGroupSize) throw new HttpError(400, 'group_too_large');
  await db.chats.updateOne({ _id: groupId }, { $addToSet: { members: u._id } });
  const updated = await db.chats.findOne({ _id: groupId });
  bus.publish('chat.updated', { chat_id: groupId, members: updated.members });
  return describe(updated, userId);
}

async function removeMember(userId, groupId, targetId) {
  const chat = await getChatForMember(groupId, userId);
  if (chat.type !== 'group') throw new HttpError(400, 'not_group');
  if (targetId !== userId && !chat.admins.includes(userId)) throw new HttpError(403, 'not_admin', 'Only group admins can remove people');
  await db.chats.updateOne({ _id: groupId }, { $pull: { members: targetId, admins: targetId } });
  const updated = await db.chats.findOne({ _id: groupId });
  // A group with members but no admin promotes the oldest remaining member.
  if (updated.members.length && !updated.admins.length) {
    await db.chats.updateOne({ _id: groupId }, { $set: { admins: [updated.members[0]] } });
  }
  // Removed member's devices stop receiving new message keys immediately, because
  // senders encrypt only for current members' devices (the "rotate on leave" property).
  bus.publish('chat.updated', { chat_id: groupId, members: [...updated.members, targetId] });
  return { ok: true };
}

// Aggregate receipts into the two numbers the viewer's UI needs:
// everyone-else delivered up to X (✓✓) and everyone-else read up to Y (blue ✓✓).
// Per member we take the MAX over their devices (first device ack wins),
// then MIN over members (group ✓✓ means EVERYONE got it).
async function receiptSummary(chat) {
  const rows = await db.receipts.aggregate([
    { $match: { chat_id: chat._id } },
    { $group: { _id: '$user_id', delivered: { $max: '$delivered_seq' }, read: { $max: '$read_seq' } } },
  ]).toArray();
  const perUser = Object.fromEntries(rows.map((r) => [r._id, r]));
  return (viewerId) => {
    const others = chat.members.filter((m) => m !== viewerId);
    if (!others.length) return { delivered_up_to: 0, read_up_to: 0 };
    let delivered = Infinity; let read = Infinity;
    for (const m of others) {
      delivered = Math.min(delivered, perUser[m]?.delivered || 0);
      read = Math.min(read, perUser[m]?.read || 0);
    }
    return { delivered_up_to: delivered, read_up_to: read };
  };
}

async function describe(chat, viewerId, extras = {}) {
  const members = await users.usersByIds(chat.members);
  const summary = (await receiptSummary(chat))(viewerId);
  return {
    chat_id: chat._id,
    type: chat.type,
    name: chat.type === 'group' ? chat.name : (members.find((m) => m.user_id !== viewerId)?.name || 'Chat'),
    members,
    admins: chat.admins || [],
    last_seq: chat.last_seq,
    last_message_at: chat.last_message_at,
    ...summary,
    ...extras,
  };
}

async function listChats(userId, deviceId) {
  const chats = await db.chats.find({ members: userId }).sort({ last_message_at: -1 }).limit(200).toArray();
  const mine = await db.receipts.find({ device_id: deviceId }).toArray();
  const cursor = Object.fromEntries(mine.map((r) => [r.chat_id, r]));
  return Promise.all(chats.map(async (c) => {
    const readSeq = cursor[c._id]?.read_seq || 0;
    const unread = c.last_seq > readSeq
      ? await db.messages.countDocuments({ chat_id: c._id, seq: { $gt: readSeq }, sender_user_id: { $ne: userId } })
      : 0;
    return describe(c, userId, { my_read_seq: readSeq, my_delivered_seq: cursor[c._id]?.delivered_seq || 0, unread });
  }));
}

module.exports = { getChatForMember, openDirect, createGroup, addMember, removeMember, listChats, describe, receiptSummary };
