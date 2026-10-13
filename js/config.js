export const CONFIG = {
  brokerUrl: "wss://broker.emqx.io:8084/mqtt",
  topicBase: "rastreo-live/v1",
  publishIntervalMs: 400,
  staleMs: 12000,
  reachMs: 120000,
  defaultCenter: { lat: -2.170998, lng: -79.922359, zoom: 12 },
  colors: {
    self: "#22d3ee",
    peer: "#f472b6",
  },
  mapStyles: [
    {
      id: "oscuro",
      nombre: "Oscuro",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; OpenStreetMap &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 20,
    },
    {
      id: "satelite",
      nombre: "Satélite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri &mdash; Maxar, Earthstar Geographics",
      maxZoom: 19,
    },
    {
      id: "calles",
      nombre: "Calles",
      url: "https://{s}.basemaps.cartocdn.com/voyager/{z}/{x}/{y}{r}.png",
      attribution: '&copy; OpenStreetMap &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 20,
    },
  ],
};
