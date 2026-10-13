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
import { History } from "./history.js";

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
  History.maybeSave(sample);
  if (realtime?.client?.connected) realtime.publishLocation(sample);
}

async function startTracking() {
  realtime = new Realtime();
  realtime.onStatus(({ state: st }) => setNetPill(st));
  realtime.onMessage(handlePeerMessage);
  await realtime.connect({ sala: state.sala, id: state.id, nombre: state.nombre });
  History.setContext({
    topicHash: realtime.topicHash,
    key: realtime.key,
    selfId: state.id,
    selfName: state.nombre,
  });

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

  $("#testFb").addEventListener("click", async () => {
    History.setFirebaseUrl($("#inpFirebase").value);
    if (!History.enabled()) {
      toast("Primero pega la URL de tu Realtime Database.", "warning");
      return;
    }
    const result = await History.testConnection();
    toast(result.message, result.ok ? "success" : "error", 6000);
  });
}

function openSetup() {
  $("#setupModal").hidden = false;
  $("#inpNombre").value = state.nombre;
  $("#inpSala").value = state.sala;
  $("#inpFirebase").value = History.firebaseUrl();
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
  History.setFirebaseUrl($("#inpFirebase").value);
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

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function groupLabel(id, points) {
  if (id === state.id) return state.nombre || "Tú";
  const nombre = points.find((p) => p.nombre)?.nombre;
  return nombre || "Pareja";
}

function renderHistory(groups) {
  const list = $("#histList");
  const stats = $("#histStats");
  list.innerHTML = "";

  const wantMine = $("#histMine").checked;
  const wantPeer = $("#histPeer").checked;
  const series = [];
  let totalPoints = 0;

  Object.entries(groups).forEach(([id, points]) => {
    const mine = id === state.id;
    if (mine && !wantMine) return;
    if (!mine && !wantPeer) return;
    if (!points.length) return;

    const isSelf = mine;
    const color = isSelf ? CONFIG.colors.self : CONFIG.colors.peer;
    const name = groupLabel(id, points);
    series.push({ name, color, points: points.map((p) => [p.lat, p.lng]) });

    const st = History.groupStats(points);
    totalPoints += st.count;
    const item = document.createElement("div");
    item.className = "hist-item";
    item.innerHTML =
      `<b><i style="--c:${color}"></i>${name}</b>` +
      `<span>${st.count} puntos · ${formatDistance(st.meters)}</span>` +
      `<span class="muted">${formatTime(st.first)} → ${formatTime(st.last)}</span>`;
    list.appendChild(item);
  });

  mapView.showHistory(series);

  if (!series.length) {
    stats.textContent = "No hay recorridos para ese día (o están desmarcados).";
  } else {
    stats.textContent = `Día ${$("#histDate").value} · ${series.length} recorrido(s) · ${totalPoints} puntos.`;
  }
}

async function viewHistory() {
  if (!History.enabled()) {
    toast("Configura primero tu Firebase para guardar historial.", "warning");
    return;
  }
  const date = $("#histDate").value || todayStr();
  $("#histStats").textContent = "Cargando…";
  $("#histList").innerHTML = "";
  try {
    const groups = await History.loadDay(date);
    renderHistory(groups);
  } catch (err) {
    $("#histStats").textContent = `Error al leer Firebase (${err.message}).`;
  }
}

function openHistory() {
  if (!History.enabled()) {
    toast("Aún no hay historial. Configura tu Firebase en ⚙️.", "warning", 6000);
    openSetup();
    return;
  }
  if (!$("#histDate").value) $("#histDate").value = todayStr();
  $("#histHint").textContent =
    "Los datos se guardan cifrados: en la consola de Firebase se ven opacos, pero aquí se leen con tu sala.";
  $("#historyModal").hidden = false;
  viewHistory();
}

function wireHistory() {
  $("#historyBtn").addEventListener("click", openHistory);
  $("#histView").addEventListener("click", viewHistory);
  $("#histToday").addEventListener("click", () => {
    $("#histDate").value = todayStr();
    viewHistory();
  });
  $("#histMine").addEventListener("change", viewHistory);
  $("#histPeer").addEventListener("change", viewHistory);
  $("#histDelete").addEventListener("click", async () => {
    const date = $("#histDate").value;
    if (!date) return;
    if (!confirm(`¿Borrar el recorrido del ${date}? Esta acción no se puede deshacer.`)) return;
    try {
      await History.removeDay(date);
      toast(`Día ${date} borrado.`, "success");
      viewHistory();
    } catch (err) {
      toast(`No se pudo borrar (${err.message}).`, "error");
    }
  });
  $("#histClose").addEventListener("click", () => {
    $("#historyModal").hidden = true;
    mapView.clearHistory();
  });
  $("#histDate").addEventListener("change", viewHistory);
}

function init() {
  mapView = new MapView("map");
  wireControls();
  wireHistory();
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
