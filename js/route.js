const OSRM = "https://router.project-osrm.org/route/v1/driving";

let cacheKey = null;
let cacheVal = null;
let inflight = null;

export function formatDuration(seconds) {
  if (seconds == null) return "—";
  const min = Math.round(seconds / 60);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export async function getRoute(a, b) {
  if (!a || !b || typeof b.lat !== "number") return null;

  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  if (key === cacheKey) return cacheVal;
  if (inflight) return inflight;

  const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;

  inflight = fetch(url)
    .then((res) => res.json())
    .then((json) => {
      const route = json?.routes?.[0];
      if (!route) return null;
      const out = {
        coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: route.distance,
        duration: route.duration,
      };
      cacheKey = key;
      cacheVal = out;
      return out;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
