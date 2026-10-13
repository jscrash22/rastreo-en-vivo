import { CONFIG } from "./config.js";
import {
  $,
  $$,
  uid,
  bus,
  haversine,
  formatDistance,
  formatTime,
  timeAgo,
} from "./utils.js";
import { Realtime } from "./realtime.js";
import { GeoWatcher } from "./geo.js";
import { MapView } from "./map.js";

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
  peer: null,
  peerOnline: false,
  follow: "self",
};

let realtime;
let geo;
let mapView;
let publishTimer;

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

function setNetPill(kind, text) {
  const pill = $("#netPill");
  pill.classList.remove("is-ok", "is-bad", "is-wait");
  pill.classList.add(kind);
  $("#netText").textContent = text;
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
  state.peerOnline = online;
  $("#peerName").textContent = peer.nombre || "Tu pareja";
  $("#peerAvatar").textContent = online ? "❤️" : "💤";

  if (typeof peer.lat === "number") {
    $("#peerCoords").textContent = `${peer.lat.toFixed(5)}, ${peer.lng.toFixed(5)}`;
    $("#peerAcc").textContent = `±${Math.round(peer.acc || 0)} m`;
    $("#peerUpdated").textContent = formatTime(peer.ts);
    $("#peerStatus").textContent = online
      ? `En línea · ${timeAgo(peer.ts)}`
      : `Última señal: ${timeAgo(peer.ts)}`;
  } else {
    $("#peerStatus").textContent = online ? "En línea (sin GPS aún)" : "Desconectada";
  }
  updateDistance();
}

function updateDistance() {
  const value = $("#distanceValue");
  const hint = $("#distanceHint");
  const self = state.selfSample;
  const peer = state.peer;

  if (self && peer && typeof peer.lat === "number") {
    const meters = haversine(self, peer);
    value.textContent = formatDistance(meters);
    if (meters < 80) hint.textContent = "¡Están muy cerca! ❤️";
    else if (meters < 1000) hint.textContent = "A pocos pasos.";
    else hint.textContent = "Distancia en línea recta entre ambos.";
  } else {
    value.textContent = "—";
    hint.textContent = self ? "Esperando la ubicación de tu pareja…" : "Conecten ambos para medir la distancia.";
  }
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
  if (realtime?.client?.connected) realtime.publishLocation(sample);
}

function startTracking() {
  realtime = new Realtime();
  realtime.onStatus(({ connected }) => {
    if (connected) setNetPill("is-ok", "En vivo");
    else setNetPill("is-wait", "Conectando…");
  });
  realtime.onMessage(handlePeerMessage);
  realtime.connect({ sala: state.sala, id: state.id, nombre: state.nombre });
  realtime.client.on("error", () => setNetPill("is-bad", "Sin red"));

  geo = new GeoWatcher();
  geo.on((payload) => {
    if (payload.ok) {
      handleGeoSample(payload.sample);
    } else if (payload.message) {
      if (payload.error === "unsupported") {
        toast(payload.message, "error");
      } else {
        $("#selfStatus").textContent = payload.message;
        toast(payload.message, "warning");
      }
    }
  });
  geo.start();

  startPublishLoop();

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.selfSample) {
      realtime.publishLocation(state.selfSample);
    }
  });

  window.addEventListener("pagehide", () => {
    realtime?.disconnect();
  });
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

  $("#shareBtn").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?sala=${encodeURIComponent(state.sala)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Enlace de la sala copiado. Envíalo a tu pareja 💌", "success");
    } catch {
      prompt("Copia este enlace para tu pareja:", url);
    }
  });

  $("#setupBtn").addEventListener("click", () => openSetup({ reset: false }));
  $("#genSala").addEventListener("click", () => {
    $("#inpSala").value = `AMOR${uid(4)}`;
  });
}

function openSetup({ reset } = { reset: true }) {
  $("#setupModal").hidden = false;
  $("#inpNombre").value = reset ? state.nombre : state.nombre;
  $("#inpSala").value = reset ? state.sala : state.sala;
  $("#inpNombre").focus();
}

function closeSetup() {
  $("#setupModal").hidden = true;
}

function readConfig() {
  const params = new URLSearchParams(location.search);
  const urlSala = params.get("sala");
  state.nombre = localStorage.getItem(LS.nombre) || params.get("nombre") || "";
  state.sala = (urlSala || localStorage.getItem(LS.sala) || "").toUpperCase();
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

  $("#setupForm").addEventListener("submit", handleSetupSubmit);

  if (state.nombre && state.sala) {
    closeSetup();
    startTracking();
  } else {
    if (!state.sala) $("#inpSala").value = `AMOR${uid(4)}`;
    openSetup({ reset: false });
    toast("Configura tu nombre y sala para empezar.", "info", 6000);
  }
}

document.addEventListener("DOMContentLoaded", init);
