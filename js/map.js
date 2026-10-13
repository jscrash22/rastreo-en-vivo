import { CONFIG } from "./config.js";
import { haversine } from "./utils.js";

function pinIcon(color, emoji) {
  return L.divIcon({
    className: "map-pin",
    html: `<span class="map-pin-dot" style="--pin:${color}"><span class="map-pin-emoji">${emoji}</span></span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

export class MapView {
  constructor(element) {
    this.map = L.map(element, { zoomControl: false }).setView(
      [CONFIG.defaultCenter.lat, CONFIG.defaultCenter.lng],
      CONFIG.defaultCenter.zoom
    );

    L.control.zoom({ position: "bottomright" }).addTo(this.map);

    const layers = {};
    CONFIG.mapStyles.forEach((style, index) => {
      const layer = L.tileLayer(style.url, {
        maxZoom: style.maxZoom,
        attribution: style.attribution,
        detectRetina: true,
      });
      layers[style.nombre] = layer;
      if (index === 0) layer.addTo(this.map);
    });

    L.control
      .layers(layers, null, { position: "topright", collapsed: true })
      .addTo(this.map);

    this.map.on("zoomstart", () => this.map.getContainer().classList.add("is-zooming"));
    this.map.on("zoomend", () => this.map.getContainer().classList.remove("is-zooming"));

    this.selfMarker = null;
    this.peerMarker = null;
    this.selfAcc = null;
    this.peerAcc = null;
    this.peerTrail = L.polyline([], {
      color: CONFIG.colors.peer,
      weight: 4,
      opacity: 0.55,
      dashArray: "2 8",
    }).addTo(this.map);
    this.trailPoints = [];
    this.follow = "self";
    this.hasCentered = false;
  }

  setFollow(mode) {
    this.follow = mode;
  }

  updateSelf(sample) {
    const latlng = [sample.lat, sample.lng];
    if (!this.selfMarker) {
      this.selfMarker = L.marker(latlng, { icon: pinIcon(CONFIG.colors.self, "🧑") }).addTo(this.map);
    } else {
      this.selfMarker.setLatLng(latlng);
    }
    if (!this.selfAcc) {
      this.selfAcc = L.circle(latlng, {
        radius: sample.acc || 0,
        color: CONFIG.colors.self,
        weight: 1,
        fillColor: CONFIG.colors.self,
        fillOpacity: 0.12,
      }).addTo(this.map);
    } else {
      this.selfAcc.setLatLng(latlng).setRadius(sample.acc || 0);
    }
    if (!this.hasCentered) {
      this.map.setView(latlng, 16);
      this.hasCentered = true;
    } else if (this.follow === "self") {
      this.map.panTo(latlng, { animate: true });
    }
  }

  updatePeer(peer) {
    if (!peer || typeof peer.lat !== "number") return;
    const latlng = [peer.lat, peer.lng];
    const emoji = peer.online === false ? "💤" : "❤️";
    if (!this.peerMarker) {
      this.peerMarker = L.marker(latlng, { icon: pinIcon(CONFIG.colors.peer, emoji) }).addTo(this.map);
    } else {
      this.peerMarker.setLatLng(latlng).setIcon(pinIcon(CONFIG.colors.peer, emoji));
    }
    if (!this.peerAcc) {
      this.peerAcc = L.circle(latlng, {
        radius: peer.acc || 0,
        color: CONFIG.colors.peer,
        weight: 1,
        fillColor: CONFIG.colors.peer,
        fillOpacity: 0.1,
      }).addTo(this.map);
    } else {
      this.peerAcc.setLatLng(latlng).setRadius(peer.acc || 0);
    }

    const last = this.trailPoints[this.trailPoints.length - 1];
    if (!last || haversine({ lat: last[0], lng: last[1] }, { lat: peer.lat, lng: peer.lng }) > 8) {
      this.trailPoints.push(latlng);
      if (this.trailPoints.length > 600) this.trailPoints.shift();
      this.peerTrail.setLatLngs(this.trailPoints);
    }

    if (this.follow === "peer") this.map.panTo(latlng, { animate: true });
  }

  clearTrail() {
    this.trailPoints = [];
    this.peerTrail.setLatLngs([]);
  }

  fitBoth(selfSample, peer) {
    const points = [];
    if (selfSample) points.push([selfSample.lat, selfSample.lng]);
    if (peer && typeof peer.lat === "number") points.push([peer.lat, peer.lng]);
    if (points.length === 2) {
      this.map.fitBounds(L.latLngBounds(points).pad(0.3));
    } else if (points.length === 1) {
      this.map.setView(points[0], 16);
    }
  }
}
