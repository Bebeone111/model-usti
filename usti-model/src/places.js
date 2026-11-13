const TOUR_IDS = ['nadrazi', 'forum', 'namesti', 'benes', 'mariansky', 'vetruse', 'pavel', 'namesti'];
const VISIT_KEY = 'usti-visited';

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function loadVisited() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VISIT_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function createPlaces({ pois, labelPoints, addresses = [] }) {
  const byId = new Map(pois.map((poi) => [poi.id, poi]));
  const visited = loadVisited();
  let tour = null;
  let arrived = -1;

  function save() {
    localStorage.setItem(VISIT_KEY, JSON.stringify([...visited]));
  }

  function mark(id) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    save();
  }

  function nearestLabel(x, z) {
    let best = null;
    for (const point of labelPoints) {
      const dist = Math.hypot(point.x - x, point.z - z);
      if (dist > 140) continue;
      if (!best || dist < best.dist) best = { dist, text: point.text };
    }
    for (const poi of pois) {
      const dist = Math.hypot(poi.x - x, poi.z - z);
      if (dist > 90) continue;
      if (!best || dist < best.dist) best = { dist, text: poi.name };
    }
    return best?.text || 'centrum';
  }

  function whereText(x, z) {
    const name = nearestLabel(x, z);
    return name === 'centrum' ? 'centrum' : `${name} · centrum`;
  }

  function nearPoi(x, z, reach = 16) {
    let best = null;
    for (const poi of pois) {
      const dist = Math.hypot(poi.x - x, poi.z - z);
      if (dist > reach) continue;
      if (!best || dist < best.dist) best = { dist, poi };
    }
    return best?.poi || null;
  }

  function search(query) {
    const q = norm(query).trim();
    if (q.length < 1) return [];
    const out = [];
    const seen = new Set();
    for (const poi of pois) {
      if (!norm(poi.name).includes(q)) continue;
      seen.add(norm(poi.name));
      out.push({ name: poi.name, x: poi.x, z: poi.z, poi });
    }
    for (const point of labelPoints) {
      const key = norm(point.text);
      if (seen.has(key) || !key.includes(q)) continue;
      seen.add(key);
      out.push({ name: point.text, x: point.x, z: point.z, poi: null });
      if (out.length >= 12) break;
    }
    for (const addr of addresses) {
      const key = norm(addr.name);
      if (seen.has(key) || !key.includes(q)) continue;
      seen.add(key);
      out.push({ name: addr.name, x: addr.x, z: addr.z, poi: null });
      if (out.length >= 12) break;
    }
    return out.slice(0, 12);
  }

  function startTour() {
    tour = { index: 0 };
    arrived = -1;
    return currentStop();
  }

  function currentStop() {
    if (!tour) return null;
    const id = TOUR_IDS[tour.index];
    const poi = byId.get(id) || null;
    return poi ? { poi, index: tour.index, last: tour.index === TOUR_IDS.length - 1, total: TOUR_IDS.length } : null;
  }

  function noteArrival(x, z) {
    const stop = currentStop();
    if (!stop) return null;
    const dist = Math.hypot(stop.poi.x - x, stop.poi.z - z);
    if (dist > 18) return null;
    if (arrived === tour.index) return null;
    arrived = tour.index;
    mark(stop.poi.id);
    return stop;
  }

  function advance() {
    if (!tour) return null;
    if (tour.index >= TOUR_IDS.length - 1) {
      tour = null;
      arrived = -1;
      return null;
    }
    tour.index += 1;
    arrived = -1;
    return currentStop();
  }

  function cancelTour() {
    tour = null;
    arrived = -1;
  }

  return {
    pois,
    visited,
    mark,
    whereText,
    nearPoi,
    search,
    startTour,
    currentStop,
    noteArrival,
    advance,
    cancelTour,
    total: pois.length,
    visitedCount() {
      return visited.size;
    },
  };
}
