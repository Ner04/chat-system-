// Connection registry: "which chat server holds Bob's laptop socket?"
// In production this is Redis (device_id -> server_id) so any chat server can route
// to any other. With a single process it is just two maps.
const byDevice = new Map(); // device_id -> ws
const byUser = new Map(); // user_id -> Set<device_id>

function register(ws) {
  const { userId, deviceId } = ws.auth;
  const prev = byDevice.get(deviceId);
  if (prev && prev !== ws) prev.close(4000, 'replaced by a newer connection');
  byDevice.set(deviceId, ws);
  if (!byUser.has(userId)) byUser.set(userId, new Set());
  byUser.get(userId).add(deviceId);
}

function unregister(ws) {
  const { userId, deviceId } = ws.auth;
  if (byDevice.get(deviceId) !== ws) return false;
  byDevice.delete(deviceId);
  const set = byUser.get(userId);
  set?.delete(deviceId);
  if (set && !set.size) byUser.delete(userId);
  return true;
}

const socketFor = (deviceId) => byDevice.get(deviceId);
const isUserOnline = (userId) => (byUser.get(userId)?.size || 0) > 0;
const devicesOnline = (userId) => [...(byUser.get(userId) || [])];

function send(deviceId, event) {
  const ws = byDevice.get(deviceId);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function sendToUser(userId, event, exceptDeviceId) {
  for (const d of devicesOnline(userId)) if (d !== exceptDeviceId) send(d, event);
}

module.exports = { register, unregister, socketFor, isUserOnline, devicesOnline, send, sendToUser };
