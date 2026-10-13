import { CONFIG } from "./config.js";
import { uid } from "./utils.js";

export class Realtime {
  constructor() {
    this.client = null;
    this.base = null;
    this.selfTopic = null;
    this.me = null;
    this.sala = null;
    this.lastPeer = null;
    this.watchTimer = null;
    this.messageHandlers = new Set();
    this.statusHandlers = new Set();
  }

  onMessage(handler) {
    this.messageHandlers.add(handler);
  }

  onStatus(handler) {
    this.statusHandlers.add(handler);
    handler(this.status());
  }

  status() {
    return {
      connected: Boolean(this.client?.connected),
      sala: this.sala,
      id: this.me?.id || null,
    };
  }

  emitMessage(payload) {
    this.messageHandlers.forEach((handler) => handler(payload));
  }

  emitStatus() {
    const current = this.status();
    this.statusHandlers.forEach((handler) => handler(current));
  }

  connect({ sala, id, nombre }) {
    this.sala = sala;
    this.me = { id, nombre };
    this.base = `${CONFIG.topicBase}/${sala}`;
    this.selfTopic = `${this.base}/${id}`;

    this.client = mqtt.connect(CONFIG.brokerUrl, {
      clientId: `rastreo-${id}-${uid(4)}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2000,
      connectTimeout: 15000,
      will: {
        topic: this.selfTopic,
        payload: JSON.stringify({ id, nombre, online: false, ts: Date.now() }),
        qos: 1,
        retain: true,
      },
    });

    this.client.on("connect", () => {
      this.client.subscribe(`${this.base}/+`, { qos: 1 });
      this.publishPresence(true);
      this.emitStatus();
      this.emitMessage({ type: "connected" });
    });

    this.client.on("reconnect", () => this.emitStatus());
    this.client.on("close", () => this.emitStatus());
    this.client.on("offline", () => this.emitStatus());
    this.client.on("error", (err) => {
      console.warn("MQTT error", err);
      this.emitStatus();
    });

    this.client.on("message", (topic, buffer) => {
      if (topic === this.selfTopic) return;
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      if (!data || data.id === id) return;
      this.lastPeer = data;
      this.emitMessage({ type: "peer", data });
    });

    this.startStaleWatch();
    return this;
  }

  publishPresence(online) {
    this.publish({
      id: this.me.id,
      nombre: this.me.nombre,
      online,
      ts: Date.now(),
    });
  }

  publishLocation(sample) {
    this.publish({
      id: this.me.id,
      nombre: this.me.nombre,
      online: true,
      lat: sample.lat,
      lng: sample.lng,
      acc: sample.acc,
      speed: sample.speed,
      heading: sample.heading,
      ts: Date.now(),
    });
  }

  publish(payload) {
    if (!this.client) return;
    this.client.publish(this.selfTopic, JSON.stringify(payload), { qos: 1, retain: true });
  }

  startStaleWatch() {
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => {
      if (!this.lastPeer) return;
      const age = Date.now() - (this.lastPeer.ts || 0);
      if (age > CONFIG.staleMs) {
        this.emitMessage({ type: "stale", data: this.lastPeer, age });
      }
    }, 3000);
  }

  peer() {
    return this.lastPeer;
  }

  disconnect() {
    clearInterval(this.watchTimer);
    if (this.client) {
      this.publishPresence(false);
      this.client.end(true);
    }
  }
}
