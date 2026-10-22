// User service: account profile, devices and their public keys.
const { db } = require('../db');
const { normalizePhone, HttpError, publicUser } = require('../util');

async function getUser(userId) {
  return db.users.findOne({ _id: userId });
}

async function updateName(userId, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new HttpError(400, 'invalid_name', 'Enter a name');
  await db.users.updateOne({ _id: userId }, { $set: { name: clean } });
  return publicUser(await getUser(userId));
}

async function findByPhone(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid phone number');
  const u = await db.users.findOne({ phone });
  if (!u) throw new HttpError(404, 'user_not_found', `${phone} hasn't joined yet. Ask them to sign in once first.`);
  return u;
}

async function usersByIds(ids) {
  const list = await db.users.find({ _id: { $in: ids } }).toArray();
  return list.map(publicUser);
}

// All devices (with public keys) for a set of users – what a sender needs to
// encrypt one copy of the message key per device ("cost = members × devices").
async function devicesFor(userIds) {
  const list = await db.devices.find({ user_id: { $in: userIds } }, { projection: { user_id: 1, public_key: 1, name: 1 } }).toArray();
  return list.map((d) => ({ device_id: d._id, user_id: d.user_id, name: d.name, public_key: d.public_key }));
}

async function getDevice(deviceId) {
  const d = await db.devices.findOne({ _id: deviceId });
  return d && { device_id: d._id, user_id: d.user_id, name: d.name, public_key: d.public_key };
}

async function touchDevice(deviceId) {
  await db.devices.updateOne({ _id: deviceId }, { $set: { last_seen: new Date() } });
}

module.exports = { getUser, updateName, findByPhone, usersByIds, devicesFor, getDevice, touchDevice };
