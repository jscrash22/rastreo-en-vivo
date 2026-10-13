export const CONFIG = {
  brokerUrl: "wss://broker.emqx.io:8084/mqtt",
  topicBase: "rastreo-live/v1",
  publishIntervalMs: 1000,
  staleMs: 15000,
  nearMs: 150,
  nearResetMs: 300,
  routeRefreshMs: 8000,
  defaultCenter: { lat: -2.170998, lng: -79.922359, zoom: 12 },
  colors: {
    self: "#22d3ee",
    peer: "#f472b6",
  },
};
