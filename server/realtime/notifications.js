// Notification layer. When a target device has no live socket, the real system asks
// FCM/APNs to wake the app; the app then connects, syncs and sends the delivery ACK
// itself (a push is NOT a delivery). Here we just log it – plug a provider in below.
const pending = new Map(); // device_id -> count, to collapse a burst into one push

function notifyOffline(deviceId, chatId) {
  const n = (pending.get(deviceId) || 0) + 1;
  pending.set(deviceId, n);
  if (n === 1) {
    setTimeout(() => {
      const count = pending.get(deviceId);
      pending.delete(deviceId);
      console.log(`[push] would wake ${deviceId}: ${count} new message(s) (latest chat ${chatId})`);
    }, 1000);
  }
}

module.exports = { notifyOffline };
