import { CONFIG } from "./config.js";
import { $, uid, formatTime, timeAgo } from "./utils.js";
import { Realtime } from "./realtime.js";
import { GeoWatcher } from "./geo.js";
import { MapView } from "./map.js";
import { History } from "./history.js";

const LS = {
  nombre: "rastreo.nombre",
  sala: "rastreo.sala",
  id: "rastreo.id",
};

const state = {
  nombre: "",
  sala: "",
  id: "",
  selfSample: null,
  watcher: null,
  sending: false,
  lastPublishTs: 0,
  received: 0,
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

function setNetPill(st) {
  const pill = $("#netPill");
  pill.classList.remove("is-ok", "is-bad", "is-wait");
  if (st === "connected") pill.classList.add("is-ok");
  else if (st === "offline" || st === "error") pill.classList.add("is-bad");
  else pill.classList.add("is-wait");

  const labels = {
    connected: "En vivo",
    connecting: "Conectando…",
    reconnecting: "Reconectando…",
    offline: "Sin red",
    error: "Error de red",
  };
  $("#netText").textContent = labels[st] || "…";
  $("#gSala").textContent = state.sala ? `Sala ${state.sala}` : "";
  updateDiag();
}

function diagText() {
  const rt = realtime;
  const cif = rt?.key ? "🔐 cifrado encendido" : "cifrado apagado";
  return `v${CONFIG.version} · ${cif} · recibe ${state.received}`;
}

function updateDiag() {
  const el = $("#gDiag");
  if (el && realtime) el.textContent = diagText();
}

function renderStatus() {
  const on = state.sending;
  $("#gStatusText").textContent = on ? "ENVIANDO UBICACIÓN 📡" : "ENVÍO DETENIDO";
  $("#gDot").classList.toggle("is-on", on);
  $("#toggleBtn").textContent = on ? "⏸ Detener envío" : "📡 Empezar a enviar";
  $("#toggleBtn").classList.toggle("is-off", !on);
}

function renderMetrics() {
  const s = state.selfSample;
  if (!s) return;
  $("#gAcc").textContent = `±${Math.round(s.acc || 0)} m`;
  $("#gSpeed").textContent = s.speed == null || s.speed < 0 ? "—" : `${(s.speed * 3.6).toFixed(1)} km/h`;
  $("#gMine").textContent = state.lastPublishTs ? timeAgo(state.lastPublishTs) : "—";
}

function renderWatcher() {
  const w = state.watcher;
  if (!w) {
    $("#gWatcher").textContent = state.sending ? "👀 Enviando… esperando que alguien te vea." : "👀 Aún nadie te ve…";
    return;
  }
  const online = w.online !== false;
  $("#gWatcher").textContent = online ? `👀 Te está viendo: ${w.nombre || "tu monitor"}` : `👀 ${w.nombre || "Tu monitor"} ya no te ve`;
}

function startPublishLoop() {
  clearInterval(publishTimer);
  publishTimer = setInterval(() => {
    if (state.sending && state.selfSample && realtime?.client?.connected) {
      realtime.publishLocation(state.selfSample);
      state.lastPublishTs = Date.now();
      $("#gLast").textContent = timeAgo(state.lastPublishTs);
    }
  }, CONFIG.publishIntervalMs);
}

function stopPublishLoop() {
  clearInterval(publishTimer);
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* ignore */
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function setSending(on) {
  state.sending = on;
  if (on) {
    geo.start();
    startPublishLoop();
    acquireWakeLock();
    realtime?.publishPresence(true);
  } else {
    geo.stop();
    stopPublishLoop();
    releaseWakeLock();
    realtime?.publishPresence(false);
  }
  renderStatus();
  renderMetrics();
}

function handleGeoSample(sample) {
  state.selfSample = sample;
  renderMetrics();
  mapView.updateSelf(sample);
  History.maybeSave(sample);
  if (state.sending && realtime?.client?.connected) {
    realtime.publishLocation(sample);
    state.lastPublishTs = Date.now();
    $("#gLast").textContent = timeAgo(state.lastPublishTs);
  }
}

function handlePeerMessage(msg) {
  if (msg.type !== "peer") return;
  state.received += 1;
  const data = msg.data;
  if (data.role === "guest") return;
  state.watcher = data;
  renderWatcher();
  updateDiag();
}

async function startTracking() {
  realtime = new Realtime();
  realtime.onStatus(({ state: st }) => setNetPill(st));
  realtime.onMessage(handlePeerMessage);
  await realtime.connect({ sala: state.sala, id: state.id, nombre: state.nombre, role: "guest" });
  $("#gBrandName").textContent = state.nombre ? `Enviando · ${state.nombre}` : "Enviar ubicación";
  History.setContext({
    topicHash: realtime.topicHash,
    key: realtime.key,
    selfId: state.id,
    selfName: state.nombre,
    saveSelf: true,
  });

  geo = new GeoWatcher();
  geo.on((payload) => {
    if (payload.ok) {
      handleGeoSample(payload.sample);
    } else if (payload.message) {
      toast(payload.message, payload.error === "unsupported" ? "error" : "warning");
    }
  });

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.sending) acquireWakeLock();
    else if (!state.sending) releaseWakeLock();
  });
  window.addEventListener("pagehide", () => {
    stopPublishLoop();
    releaseWakeLock();
    realtime?.disconnect();
  });
  window.addEventListener("online", () => {
    if (realtime?.client?.connected) return;
    realtime?.reconnect();
    if (state.sending) geo.start();
  });
  window.addEventListener("offline", () => setNetPill("offline"));

  setSending(true);
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

function openSetup() {
  $("#gSetupModal").hidden = false;
  $("#gInpNombre").value = state.nombre;
  $("#gInpSala").value = state.sala;
  $("#gInpNombre").focus();
}

function closeSetup() {
  $("#gSetupModal").hidden = true;
}

function handleSetupSubmit(event) {
  event.preventDefault();
  const sala = $("#gInpSala").value.trim().toUpperCase();
  if (sala.length < 3) {
    toast("Escribe el código de sala (mín. 3 letras).", "warning");
    return;
  }
  const cambioSala = sala !== state.sala;
  state.nombre = $("#gInpNombre").value.trim();
  state.sala = sala;
  saveConfig();
  closeSetup();

  const url = new URL(location.href);
  url.searchParams.set("sala", sala);
  history.replaceState(null, "", url);

  if (!realtime) {
    startTracking();
  } else if (cambioSala) {
    setSending(false);
    realtime.disconnect();
    mapView.clearTrail();
    startTracking();
  } else {
    realtime.me.nombre = state.nombre;
    realtime.publishPresence(true);
    $("#gBrandName").textContent = state.nombre ? `Enviando · ${state.nombre}` : "Enviar ubicación";
  }
  toast(`Listo. Tu ubicación se envía a la sala "${sala}".`, "success");
}

function init() {
  mapView = new MapView("map");
  mapView.setFollow("self");
  readConfig();

  $("#toggleBtn").addEventListener("click", () => setSending(!state.sending));
  $("#gSetupBtn").addEventListener("click", openSetup);
  $("#gSetupForm").addEventListener("submit", handleSetupSubmit);

  if (state.sala) {
    closeSetup();
    startTracking();
  } else {
    $("#gInpSala").placeholder = "Pega el código de la sala";
    openSetup();
    toast("Pide a quien te invita el código de sala y pégalo.", "info", 7000);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            toast("🆕 Nueva versión lista — recarga para actualizar", "info", 10000);
          }
        });
      });
    });
  }
}

document.addEventListener("DOMContentLoaded", init);