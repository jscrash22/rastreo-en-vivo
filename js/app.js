import { CONFIG } from "./config.js";
import {
  $,
  uid,
  haversine,
  formatDistance,
  formatTime,
  timeAgo,
} from "./utils.js";
import { Realtime } from "./realtime.js";
import { GeoWatcher } from "./geo.js";
import { MapView } from "./map.js";
import { getRoute, formatDuration } from "./route.js";

const LS = {
  nombre: "rastreo.nombre",
  sala: "rastreo.sala",
  id: "rastreo.id",
  lastSelf: "rastreo.lastSelf",
  lastPeer: "rastreo.lastPeer",
};

const state = {
  nombre: "",
  sala: "",
  id: "",
  selfSample: null,
  peer: null,
  follow: "self",
  route: null,
  lastRouteAt: 0,
  nearAlert: false,
  wasNear: false,
  lastSavedAt: 0,
};

let realtime;
let geo;
let mapView;
let publishTimer;
let wakeLock = null;

function toast(message, type = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s ease, transform .25s ease";
    el.style.opacity = "0";
    el.style.transform = "translateX(28px)";
    setTimeout(() => el.remove(), 250);
  }, ms);
}

function setNetPill(state) {
  const pill = $("#netPill");
  pill.classList.remove("is-ok", "is-bad", "is-wait");
  if (state === "connected") pill.classList.add("is-ok");
  else if (state === "offline" || state === "error") pill.classList.add("is-bad");
  else pill.classList.add("is-wait");

  const labels = {
    connected: "En vivo",
    connecting: "Conectando…",
    reconnecting: "Reconectando…",
    offline: "Sin red",
    error: "Error de red",
  };
  $("#netText").textContent = labels[state] || "…";
  $("#reconnectBtn").hidden = state === "connected";
}

function updateWakeBadge(active) {
  const badge = $("#wakeBadge");
  if (!badge) return;
  badge.hidden = !active;
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    updateWakeBadge(true);
    wakeLock.addEventListener("release", () => updateWakeBadge(false));
  } catch {
    updateWakeBadge(false);
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  wakeLock = null;
  updateWakeBadge(false);
}

function saveLastKnown() {
  const now = Date.now();
  if (now - state.lastSavedAt < 4000) return;
  state.lastSavedAt = now;
  try {
    if (state.selfSample) localStorage.setItem(LS.lastSelf, JSON.stringify(state.selfSample));
    if (state.peer) localStorage.setItem(LS.lastPeer, JSON.stringify(state.peer));
  } catch {
    /* ignore */
  }
}

function restoreLastKnown() {
  try {
    const self = JSON.parse(localStorage.getItem(LS.lastSelf) || "null");
    const peer = JSON.parse(localStorage.getItem(LS.lastPeer) || "null");
    if (peer && typeof peer.lat === "number") {
      state.peer = peer;
      mapView.updatePeer(peer);
      updatePeerUI(peer);
    }
    if (self && typeof self.lat === "number") {
      state.selfSample = self;
      mapView.updateSelf(self);
      updateSelfUI(self);
      updateDistance();
    }
  } catch {
    /* ignore */
  }
}

function updateSelfUI(sample) {
  $("#selfName").textContent = state.nombre || "Tú";
  $("#selfCoords").textContent = `${sample.lat.toFixed(5)}, ${sample.lng.toFixed(5)}`;
  $("#selfAcc").textContent = `±${Math.round(sample.acc || 0)} m`;
  $("#selfSpeed").textContent =
    sample.speed == null || sample.speed < 0 ? "—" : `${(sample.speed * 3.6).toFixed(1)} km/h`;
  $("#selfStatus").textContent = `GPS activo · actualizado ${timeAgo(sample.ts)}`;
}

function updatePeerUI(peer) {
  const online = peer.online !== false;
  $("#peerName").textContent = peer.nombre || "Tu pareja";
  $("#peerAvatar").textContent = online ? "❤️" : "💤";

  if (typeof peer.lat === "number") {
    $("#peerCoords").textContent = `${peer.lat.toFixed(5)}, ${peer.lng.toFixed(5)}`;
    $("#peerAcc").textContent = `±${Math.round(peer.acc || 0)} m`;
    $("#peerUpdated").textContent = formatTime(peer.ts);
    $("#peerStatus").textContent = online ? `En línea · ${timeAgo(peer.ts)}` : `Última señal: ${timeAgo(peer.ts)}`;
  } else {
    $("#peerStatus").textContent = online ? "En línea (sin GPS aún)" : "Desconectada";
  }
  updateDistance();
}

function showRouteRow(route) {
  const row = $("#routeRow");
  row.hidden = false;
  $("#routeKm").textContent = formatDistance(route.distance);
  $("#routeEta").textContent = formatDuration(route.duration);
}

async function refreshRoute() {
  if (!state.selfSample || !state.peer || typeof state.peer.lat !== "number") {
    $("#routeRow").hidden = true;
    mapView.setRoute([]);
    return;
  }
  const now = Date.now();
  if (state.route && now - state.lastRouteAt < CONFIG.routeRefreshMs) return;

  const route = await getRoute(state.selfSample, state.peer);
  if (!route) return;
  state.route = route;
  state.lastRouteAt = Date.now();
  mapView.setRoute(route.coords);
  showRouteRow(route);
}

function updateDistance() {
  const value = $("#distanceValue");
  const hint = $("#distanceHint");
  const self = state.selfSample;
  const peer = state.peer;

  mapView.setStraight(self, peer);

  if (self && peer && typeof peer.lat === "number") {
    const meters = haversine(self, peer);
    value.textContent = formatDistance(meters);
    if (meters < 80) hint.textContent = "¡Están muy cerca! ❤️";
    else if (meters < 1000) hint.textContent = "A pocos pasos.";
    else hint.textContent = "Distancia en línea recta entre ambos.";
    checkProximity(meters);
    refreshRoute();
  } else {
    value.textContent = "—";
    $("#routeRow").hidden = true;
    mapView.setRoute([]);
    hint.textContent = self ? "Esperando la ubicación de tu pareja…" : "Conecten ambos para medir la distancia.";
  }
}

function notifyNear(meters) {
  const title = "¡Están cerca! ❤️";
  const body = `Tu pareja está a ${formatDistance(meters)} de ti.`;
  toast(body, "success", 6000);
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "icons/icon-192.png" });
    }
  } catch {
    /* ignore */
  }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function checkProximity(meters) {
  if (!state.nearAlert || meters == null) return;
  const near = meters <= CONFIG.nearMs;
  if (near && !state.wasNear) {
    state.wasNear = true;
    notifyNear(meters);
  } else if (!near && meters > CONFIG.nearResetMs) {
    state.wasNear = false;
  }
}

function updateNearBtn() {
  const btn = $("#nearBtn");
  btn.classList.toggle("is-on", state.nearAlert);
  btn.textContent = state.nearAlert ? "🔔 Aviso de cercanía: SÍ" : "🔕 Aviso de cercanía: NO";
}

function handlePeerMessage(msg) {
  if (msg.type === "stale") {
    $("#peerStatus").textContent = `Sin señal ${timeAgo(msg.data.ts)}`;
    return;
  }
  if (msg.type !== "peer") return;
  state.peer = msg.data;
  updatePeerUI(msg.data);
  mapView.updatePeer(msg.data);
  saveLastKnown();
}

function startPublishLoop() {
  clearInterval(publishTimer);
  publishTimer = setInterval(() => {
    if (state.selfSample) realtime.publishLocation(state.selfSample);
  }, CONFIG.publishIntervalMs);
}

function handleGeoSample(sample) {
  state.selfSample = sample;
  updateSelfUI(sample);
  mapView.updateSelf(sample);
  updateDistance();
  saveLastKnown();
  if (realtime?.client?.connected) realtime.publishLocation(sample);
}

async function startTracking() {
  realtime = new Realtime();
  realtime.onStatus(({ state: st }) => setNetPill(st));
  realtime.onMessage(handlePeerMessage);
  await realtime.connect({ sala: state.sala, id: state.id, nombre: state.nombre });

  geo = new GeoWatcher();
  geo.on((payload) => {
    if (payload.ok) {
      handleGeoSample(payload.sample);
    } else if (payload.message) {
      $("#selfStatus").textContent = payload.message;
      toast(payload.message, payload.error === "unsupported" ? "error" : "warning");
    }
  });
  geo.start();

  startPublishLoop();

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      acquireWakeLock();
      if (state.selfSample) realtime.publishLocation(state.selfSample);
    } else {
      releaseWakeLock();
    }
  });

  window.addEventListener("pagehide", () => realtime?.disconnect());
  window.addEventListener("online", () => realtime?.client?.connected || realtime?.reconnect());
  window.addEventListener("offline", () => setNetPill("offline"));

  acquireWakeLock();
}

function wireControls() {
  $("#centerSelf").addEventListener("click", () => {
    mapView.setFollow("self");
    state.follow = "self";
    if (state.selfSample) mapView.map.setView([state.selfSample.lat, state.selfSample.lng], 16);
  });

  $("#followPeer").addEventListener("click", () => {
    if (state.peer && typeof state.peer.lat === "number") {
      mapView.setFollow("peer");
      state.follow = "peer";
      mapView.map.setView([state.peer.lat, state.peer.lng], 16);
      toast("Siguiendo a tu pareja", "success", 2000);
    } else {
      toast("Todavía no hay ubicación de tu pareja.", "warning");
    }
  });

  $("#fitBoth").addEventListener("click", () => {
    mapView.setFollow("self");
    state.follow = "self";
    mapView.fitBoth(state.selfSample, state.peer);
  });

  $("#nearBtn").addEventListener("click", async () => {
    state.nearAlert = !state.nearAlert;
    if (state.nearAlert && "Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    updateNearBtn();
    toast(
      state.nearAlert ? "Aviso de cercanía activado 🔔" : "Aviso de cercanía desactivado",
      state.nearAlert ? "success" : "info"
    );
  });

  $("#reconnectBtn").addEventListener("click", () => {
    realtime?.reconnect();
    toast("Reconectando…", "info", 2000);
  });

  $("#shareBtn").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?sala=${encodeURIComponent(state.sala)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Enlace de la sala copiado. Envíalo a tu pareja 💌", "success");
    } catch {
      prompt("Copia este enlace para tu pareja:", url);
    }
  });

  $("#setupBtn").addEventListener("click", () => openSetup());
  $("#genSala").addEventListener("click", () => {
    $("#inpSala").value = `AMOR${uid(4)}`;
  });
}

function openSetup() {
  $("#setupModal").hidden = false;
  $("#inpNombre").value = state.nombre;
  $("#inpSala").value = state.sala;
  $("#inpNombre").focus();
}

function closeSetup() {
  $("#setupModal").hidden = true;
}

function readConfig() {
  const params = new URLSearchParams(location.search);
  state.nombre = localStorage.getItem(LS.nombre) || params.get("nombre") || "";
  state.sala = (params.get("sala") || localStorage.getItem(LS.sala) || "").toUpperCase();
  state.id = localStorage.getItem(LS.id) || `dev-${uid(8)}`;
  localStorage.setItem(LS.id, state.id);
}

function saveConfig() {
  localStorage.setItem(LS.nombre, state.nombre);
  localStorage.setItem(LS.sala, state.sala);
}

function handleSetupSubmit(event) {
  event.preventDefault();
  const nombre = $("#inpNombre").value.trim();
  const sala = $("#inpSala").value.trim().toUpperCase();
  if (nombre.length < 2 || sala.length < 3) {
    toast("Escribe un nombre y un código de sala (mín. 3 letras).", "warning");
    return;
  }

  const cambioSala = sala !== state.sala;
  state.nombre = nombre;
  state.sala = sala;
  saveConfig();
  closeSetup();

  const url = new URL(location.href);
  url.searchParams.set("sala", sala);
  history.replaceState(null, "", url);

  if (!realtime) {
    startTracking();
  } else if (cambioSala) {
    realtime.disconnect();
    mapView.clearTrail();
    state.peer = null;
    state.route = null;
    startTracking();
  } else {
    realtime.me.nombre = nombre;
    realtime.publishPresence(true);
  }

  toast(`Sala "${sala}" activa. Comparte el enlace 💌`, "success");
}

function init() {
  mapView = new MapView("map");
  wireControls();
  readConfig();
  updateNearBtn();

  $("#setupForm").addEventListener("submit", handleSetupSubmit);

  if (state.nombre && state.sala) {
    closeSetup();
    restoreLastKnown();
    startTracking();
  } else {
    if (!state.sala) $("#inpSala").value = `AMOR${uid(4)}`;
    openSetup();
    toast("Configura tu nombre y sala para empezar.", "info", 6000);
  }
}

document.addEventListener("DOMContentLoaded", init);
