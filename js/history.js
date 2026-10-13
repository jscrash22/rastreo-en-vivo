import { CONFIG } from "./config.js";
import { haversine } from "./utils.js";
import { encryptPayload, decryptPayload } from "./secure.js";

const LS_URL = "rastreo.firebaseUrl";

const ctx = { topicHash: null, key: null, selfId: null, selfName: "", saveSelf: true };
let lastSaveTs = 0;
let lastSavedPoint = null;

function normalize(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function firebaseUrl() {
  return normalize(localStorage.getItem(LS_URL));
}

export function setFirebaseUrl(url) {
  const clean = normalize(url);
  if (clean) localStorage.setItem(LS_URL, clean);
  else localStorage.removeItem(LS_URL);
  lastSavedPoint = null;
  lastSaveTs = 0;
  return clean;
}

export function enabled() {
  return Boolean(firebaseUrl());
}

export function setContext(next) {
  Object.assign(ctx, next || {});
}

export function context() {
  return ctx;
}

function dateStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function put(path, body) {
  const base = firebaseUrl();
  if (!base) return false;
  const res = await fetch(`${base}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return true;
}

async function get(path) {
  const base = firebaseUrl();
  if (!base) return null;
  const res = await fetch(`${base}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return res.json();
}

async function del(path) {
  const base = firebaseUrl();
  if (!base) return false;
  const res = await fetch(`${base}/${path}.json`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return true;
}

function toText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function testConnection() {
  const base = firebaseUrl();
  if (!base) return { ok: false, message: "Sin URL configurada." };
  try {
    await put("historial/_ping", JSON.stringify({ ts: Date.now() }));
    const back = await get("historial/_ping");
    if (!back || typeof back.ts !== "number") return { ok: false, message: "Respuesta inesperada." };
    return { ok: true, message: "Conexión correcta ✅" };
  } catch (err) {
    return { ok: false, message: `No se pudo conectar (${err.message}). Revisa la URL y las reglas.` };
  }
}

export async function maybeSave(sample) {
  if (!ctx.saveSelf) return;
  if (!enabled() || !ctx.topicHash || typeof sample.lat !== "number") return;
  const now = Date.now();
  if (now - lastSaveTs < CONFIG.histMs) return;
  if (lastSavedPoint && haversine(lastSavedPoint, sample) < CONFIG.histMinMove) return;

  lastSaveTs = now;
  lastSavedPoint = { lat: sample.lat, lng: sample.lng };

  const payload = await encryptPayload(ctx.key, {
    id: ctx.selfId,
    nombre: ctx.selfName,
    lat: sample.lat,
    lng: sample.lng,
    acc: sample.acc,
    speed: sample.speed,
    ts: now,
  });

  try {
    await put(`historial/${ctx.topicHash}/${dateStr(now)}/${now}_${ctx.selfId}`, payload);
  } catch (err) {
    console.warn("Historial:", err.message);
  }
}

export async function loadDay(date) {
  if (!enabled() || !ctx.topicHash) return {};
  const data = await get(`historial/${ctx.topicHash}/${date}`);
  if (!data || typeof data !== "object") return {};

  const groups = {};
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    const cut = key.indexOf("_");
    const id = cut >= 0 ? key.slice(cut + 1) : "desconocido";
    const obj = await decryptPayload(ctx.key, toText(value));
    if (!obj || typeof obj.lat !== "number" || typeof obj.lng !== "number") continue;
    if (!groups[id]) groups[id] = [];
    groups[id].push({ ...obj, id });
  }

  for (const id of Object.keys(groups)) {
    groups[id].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  return groups;
}

export async function removeDay(date) {
  if (!enabled() || !ctx.topicHash) return false;
  return del(`historial/${ctx.topicHash}/${date}`);
}

export function groupStats(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) {
    meters += haversine(
      { lat: points[i - 1].lat, lng: points[i - 1].lng },
      { lat: points[i].lat, lng: points[i].lng }
    );
  }
  return { count: points.length, meters, first: points[0]?.ts || null, last: points[points.length - 1]?.ts || null };
}

export const History = {
  firebaseUrl,
  setFirebaseUrl,
  enabled,
  setContext,
  context,
  testConnection,
  maybeSave,
  loadDay,
  removeDay,
  groupStats,
  dateStr,
};
