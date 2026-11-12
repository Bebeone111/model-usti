export function makeProjector(bbox) {
  const lon0 = (bbox.west + bbox.east) / 2;
  const lat0 = (bbox.south + bbox.north) / 2;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mLat = 110540;
  const minX = (bbox.west - lon0) * mLon;
  const maxX = (bbox.east - lon0) * mLon;
  const minZ = (bbox.south - lat0) * mLat;
  const maxZ = (bbox.north - lat0) * mLat;
  return {
    lon0,
    lat0,
    mLon,
    mLat,
    minX,
    maxX,
    minZ,
    maxZ,
    toLocal(lon, lat) {
      return [(lon - lon0) * mLon, (lat - lat0) * mLat];
    },
    toLonLat(x, z) {
      return [lon0 + x / mLon, lat0 + z / mLat];
    },
  };
}

export function signedArea(ring) {
  let a = 0;
  const n = ring.length;
  const last = n > 1 && near(ring[0], ring[n - 1]) ? n - 1 : n;
  for (let i = 0; i < last; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % last];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function near(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.05;
}

export function cleanRing(ring) {
  if (!ring) return [];
  const out = [];
  for (const p of ring) {
    if (!out.length || !near(p, out[out.length - 1])) out.push(p);
  }
  if (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return out;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  const n = ring.length;
  const last = n > 1 && near(ring[0], ring[n - 1]) ? n - 1 : n;
  for (let i = 0, j = last - 1; i < last; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    const hit = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function distPointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function intersect(a, b, limit, axis) {
  const i = axis === 'x' ? 0 : 1;
  const o = i === 0 ? 1 : 0;
  const t = (limit - a[i]) / (b[i] - a[i] || 1e-12);
  const p = [0, 0];
  p[i] = limit;
  p[o] = a[o] + (b[o] - a[o]) * t;
  return p;
}

function clipHalfPlane(points, inside, edge) {
  if (!points.length) return [];
  const out = [];
  let prev = points[points.length - 1];
  let prevIn = inside(prev);
  for (const cur of points) {
    const curIn = inside(cur);
    if (curIn) {
      if (!prevIn) out.push(edge(prev, cur));
      out.push(cur);
    } else if (prevIn) out.push(edge(prev, cur));
    prev = cur;
    prevIn = curIn;
  }
  return out;
}

export function clipPolygon(ring, minX, minZ, maxX, maxZ) {
  let pts = cleanRing(ring);
  if (pts.length < 3) return null;
  pts = clipHalfPlane(pts, (p) => p[0] >= minX, (a, b) => intersect(a, b, minX, 'x'));
  pts = clipHalfPlane(pts, (p) => p[0] <= maxX, (a, b) => intersect(a, b, maxX, 'x'));
  pts = clipHalfPlane(pts, (p) => p[1] >= minZ, (a, b) => intersect(a, b, minZ, 'z'));
  pts = clipHalfPlane(pts, (p) => p[1] <= maxZ, (a, b) => intersect(a, b, maxZ, 'z'));
  pts = cleanRing(pts);
  if (pts.length < 3 || Math.abs(signedArea(pts)) < 1.2) return null;
  return pts;
}

const INSIDE = 0;
const LEFT = 1;
const RIGHT = 2;
const BOTTOM = 4;
const TOP = 8;

function code(x, z, minX, minZ, maxX, maxZ) {
  let c = INSIDE;
  if (x < minX) c |= LEFT;
  else if (x > maxX) c |= RIGHT;
  if (z < minZ) c |= BOTTOM;
  else if (z > maxZ) c |= TOP;
  return c;
}

function clipSegment(a, b, minX, minZ, maxX, maxZ) {
  let [x0, z0] = a;
  let [x1, z1] = b;
  let c0 = code(x0, z0, minX, minZ, maxX, maxZ);
  let c1 = code(x1, z1, minX, minZ, maxX, maxZ);
  for (let n = 0; n < 12; n++) {
    if (!(c0 | c1)) return [[x0, z0], [x1, z1]];
    if (c0 & c1) return null;
    const c = c0 || c1;
    let x = 0;
    let z = 0;
    if (c & TOP) {
      x = x0 + ((x1 - x0) * (maxZ - z0)) / (z1 - z0 || 1e-12);
      z = maxZ;
    } else if (c & BOTTOM) {
      x = x0 + ((x1 - x0) * (minZ - z0)) / (z1 - z0 || 1e-12);
      z = minZ;
    } else if (c & RIGHT) {
      z = z0 + ((z1 - z0) * (maxX - x0)) / (x1 - x0 || 1e-12);
      x = maxX;
    } else {
      z = z0 + ((z1 - z0) * (minX - x0)) / (x1 - x0 || 1e-12);
      x = minX;
    }
    if (c === c0) {
      x0 = x;
      z0 = z;
      c0 = code(x0, z0, minX, minZ, maxX, maxZ);
    } else {
      x1 = x;
      z1 = z;
      c1 = code(x1, z1, minX, minZ, maxX, maxZ);
    }
  }
  return null;
}

export function clipPolyline(points, minX, minZ, maxX, maxZ) {
  const parts = [];
  let current = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = clipSegment(points[i], points[i + 1], minX, minZ, maxX, maxZ);
    if (!seg) {
      if (current.length >= 2) parts.push(current);
      current = [];
      continue;
    }
    if (!current.length) current.push(seg[0]);
    else if (Math.hypot(current[current.length - 1][0] - seg[0][0], current[current.length - 1][1] - seg[0][1]) > 0.2) {
      if (current.length >= 2) parts.push(current);
      current = [seg[0]];
    }
    current.push(seg[1]);
  }
  if (current.length >= 2) parts.push(current);
  return parts;
}

export function bufferPolyline(points, half) {
  const pts = [];
  for (const p of points) {
    if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) > 0.4) pts.push(p);
  }
  if (pts.length < 2) return null;
  const dirs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    let dx = pts[i + 1][0] - pts[i][0];
    let dz = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dz) || 1;
    dirs.push([dx / len, dz / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    let nx;
    let nz;
    let scale = 1;
    if (i === 0) {
      nx = -dirs[0][1];
      nz = dirs[0][0];
    } else if (i === pts.length - 1) {
      const d = dirs[dirs.length - 1];
      nx = -d[1];
      nz = d[0];
    } else {
      const d0 = dirs[i - 1];
      const d1 = dirs[i];
      const n0x = -d0[1];
      const n0z = d0[0];
      const n1x = -d1[1];
      const n1z = d1[0];
      nx = n0x + n1x;
      nz = n0z + n1z;
      const l = Math.hypot(nx, nz);
      if (l < 0.25) {
        nx = n1x;
        nz = n1z;
      } else {
        nx /= l;
        nz /= l;
        const dot = Math.max(0.45, n0x * nx + n0z * nz);
        scale = Math.min(1.8, 1 / dot);
      }
    }
    const d = half * scale;
    left.push([pts[i][0] + nx * d, pts[i][1] + nz * d]);
    right.push([pts[i][0] - nx * d, pts[i][1] - nz * d]);
  }
  return left.concat(right.reverse());
}

export function eachPolygon(geometry, visit) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') visit(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) visit(poly);
  }
}

export function parseMeters(value) {
  if (value == null) return null;
  const match = String(value).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

const SMALL = new Set(['garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'cabin', 'kiosk', 'toilets', 'service']);

export function buildingHeight(tags) {
  const h = parseMeters(tags.height);
  if (h && h > 1.4 && h < 160) return h;
  const levels = parseMeters(tags['building:levels']);
  if (levels && levels > 0 && levels < 50) return levels * 3;
  if (SMALL.has(tags.building)) return 3.2;
  return 9;
}

export function windowRows(tags, top, base) {
  if (SMALL.has(tags.building)) return 0;
  const levels = parseMeters(tags['building:levels']);
  if (levels && levels >= 1 && levels < 50) return Math.max(1, Math.round(levels));
  const height = Math.max(0, (top || 0) - (base || 0));
  if (!(height > 0)) return 3;
  return Math.max(1, Math.round(height / 3));
}

export function buildingBase(tags, top) {
  let base = parseMeters(tags.min_height) || 0;
  const minLevel = parseMeters(tags['building:min_level']);
  if (minLevel && minLevel > 0) base = Math.max(base, minLevel * 3);
  if (!(base > 0) || base >= top - 1) return 0;
  return base;
}

export function roadWidth(highway) {
  if (!highway) return null;
  const key = String(highway).replace(/_link$/, '');
  const widths = {
    motorway: 14,
    trunk: 12,
    primary: 11,
    secondary: 8.5,
    tertiary: 7,
    unclassified: 6,
    residential: 5.5,
    living_street: 4.5,
    service: 3.2,
    pedestrian: 6,
    track: 3,
    road: 6,
    busway: 7,
  };
  return widths[key] ?? null;
}

const START_PREF = {
  pedestrian: 0,
  living_street: 1,
  footway: 2,
  residential: 3,
  unclassified: 4,
  service: 5,
  tertiary: 6,
  secondary: 7,
  primary: 8,
};

export function startPreference(highway) {
  return START_PREF[String(highway || '').replace(/_link$/, '')] ?? 12;
}
