// Message bus. In the HLD this is Kafka between the storage service and the chat
// servers; here it is an in-process EventEmitter with the same publish/subscribe shape,
// so swapping in Kafka/Redis Streams only touches this file.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

module.exports = {
  publish(topic, event) {
    // Async hand-off: the producer (storage write + ack) never waits on fan-out.
    setImmediate(() => emitter.emit(topic, event));
  },
  subscribe(topic, handler) {
    emitter.on(topic, (event) => Promise.resolve(handler(event)).catch((e) => console.error(`[bus] ${topic} handler failed`, e)));
  },
};
