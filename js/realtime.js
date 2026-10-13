import { CONFIG } from "./config.js";
import { uid } from "./utils.js";
import { deriveSala, encryptPayload, decryptPayload, cryptoReady } from "./secure.js";

const STATE_TEXT = {
  connecting: "Conectando…",
  connected: "En vivo",
  reconnecting: "Reconectando…",
  offline: "Sin red",
  error: "Error de red",
};

export class Realtime {
  constructor() {
    this.client = null;
    this.base = null;
    this.selfTopic = null;
    this.key = null;
    this.me = null;
    this.sala = null;
    this.lastPeer = null;
    this.lastSample = null;
    this.watchTimer = null;
    this.messageHandlers = new Set();
    this.statusHandlers = new Set();
    this.state = "connecting";
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
      state: this.state,
      text: STATE_TEXT[this.state] || this.state,
      connected: this.state === "connected",
      encrypted: Boolean(this.key),
      sala: this.sala,
      id: this.me?.id || null,
    };
  }

  emitMessage(payload) {
    this.messageHandlers.forEach((handler) => handler(payload));
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    const current = this.status();
    this.statusHandlers.forEach((handler) => handler(current));
  }

  async connect({ sala, id, nombre, role = "guest" }) {
    this.sala = sala;
    this.role = role;
    this.me = { id, nombre, role };
    this.key = null;

    let topicHash = sala.toLowerCase();
    if (cryptoReady) {
      try {
        const derived = await deriveSala(sala);
        topicHash = derived.topicHash;
        this.key = derived.key;
      } catch (err) {
        console.warn("Sin cifrado:", err);
      }
    }

    this.topicHash = topicHash;
    this.base = `${CONFIG.topicBase}/${topicHash}`;
    const plainRoom = String(sala).toLowerCase().replace(/[^a-z0-9]/g, "");
    this.legacyBase = `${CONFIG.topicBase}/${plainRoom}`;
    this.selfTopic = `${this.base}/${id}`;
    this.setState("connecting");

    const willPayload = await encryptPayload(this.key, {
      id,
      nombre,
      role,
      online: false,
      ts: Date.now(),
    });

    this.client = mqtt.connect(CONFIG.brokerUrl, {
      clientId: `rastreo-${id}-${uid(4)}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2500,
      connectTimeout: 15000,
      will: { topic: this.selfTopic, payload: willPayload, qos: 1, retain: true },
    });

    this.client.on("connect", () => {
      this.client.subscribe(`${this.base}/+`, { qos: 1 });
      if (this.legacyBase !== this.base) this.client.subscribe(`${this.legacyBase}/+`, { qos: 1 });
      this.publishPresence(true);
      if (this.lastSample) this.publishLocation(this.lastSample);
      this.setState("connected");
      this.emitMessage({ type: "connected" });
    });

    this.client.on("reconnect", () => this.setState("reconnecting"));
    this.client.on("close", () => {
      if (this.state === "connected") this.setState("reconnecting");
    });
    this.client.on("offline", () => this.setState("offline"));
    this.client.on("error", (err) => {
      console.warn("MQTT error", err);
      this.setState("error");
    });

    this.client.on("message", async (topic, buffer) => {
      if (topic === this.selfTopic) return;
      const data = await decryptPayload(this.key, buffer.toString());
      if (!data || typeof data !== "object" || data.id === id) return;
      this.lastPeer = data;
      this.emitMessage({ type: "peer", data });
    });

    this.startStaleWatch();
    return this;
  }

  async publishPresence(online) {
    this.publish(
      await encryptPayload(this.key, {
        id: this.me.id,
        nombre: this.me.nombre,
        role: this.role,
        online,
        ts: Date.now(),
      })
    );
  }

  async publishLocation(sample) {
    this.lastSample = sample;
    this.publish(
      await encryptPayload(this.key, {
        id: this.me.id,
        nombre: this.me.nombre,
        role: this.role,
        online: true,
        lat: sample.lat,
        lng: sample.lng,
        acc: sample.acc,
        speed: sample.speed,
        heading: sample.heading,
        ts: Date.now(),
      })
    );
  }

  publish(payload) {
    if (!this.client) return;
    this.client.publish(this.selfTopic, payload, { qos: 1, retain: true });
  }

  reconnect() {
    if (!this.client) return;
    this.setState("connecting");
    this.client.end(true);
    this.client.reconnect();
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
