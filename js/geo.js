export class GeoWatcher {
  constructor() {
    this.watchId = null;
    this.last = null;
    this.handlers = new Set();
  }

  on(handler) {
    this.handlers.add(handler);
  }

  emit(payload) {
    this.handlers.forEach((handler) => handler(payload));
  }

  get supported() {
    return "geolocation" in navigator;
  }

  start() {
    if (!this.supported) {
      this.emit({ error: "unsupported", message: "Este navegador no soporta geolocalización." });
      return;
    }
    if (this.watchId != null) return;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.last = {
          lat: c.latitude,
          lng: c.longitude,
          acc: c.accuracy,
          speed: c.speed,
          heading: c.heading,
          ts: pos.timestamp,
        };
        this.emit({ ok: true, sample: this.last });
      },
      (err) => {
        const messages = {
          1: "Permiso de ubicación denegado. Actívalo en el navegador.",
          2: "No se pudo obtener la ubicación (señal GPS débil).",
          3: "Se agotó el tiempo de espera del GPS.",
        };
        this.emit({ error: err.code, message: messages[err.code] || err.message });
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  stop() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
