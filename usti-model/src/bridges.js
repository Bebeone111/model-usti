import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { distPointSeg, pointInRing } from './geom.js';

const MARIAN_FALLBACK = [
  [14.05235, 50.66155],
  [14.05272, 50.66112],
  [14.05320, 50.66055],
  [14.05360, 50.66030],
  [14.05412, 50.65972],
  [14.05455, 50.65918],
];
const BENES_FALLBACK = [
  [14.04628, 50.66042],
  [14.04652, 50.65995],
  [14.04694, 50.65944],
  [14.04728, 50.65898],
  [14.04752, 50.65852],
];
const RAIL_FALLBACK = [
  [14.04222, 50.65586],
  [14.04310, 50.65596],
  [14.04386, 50.65608],
  [14.04470, 50.65622],
  [14.04562, 50.65640],
];

function namedLines(collection, projector, test) {
  const lines = [];
  for (const feature of collection?.features || []) {
    const tags = feature.properties || {};
    if (feature.geometry?.type !== 'LineString') continue;
    if (!test(tags)) continue;
    const pts = feature.geometry.coordinates.map(([lon, lat]) => {
      const [x, z] = projector.toLocal(lon, lat);
      return { x, z };
    });
    if (pts.length >= 2) lines.push({ pts, tags });
  }
  return lines;
}

function lineLen(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return len;
}

function fallbackPts(fallback, projector) {
  return fallback.map(([lon, lat]) => {
    const [x, z] = projector.toLocal(lon, lat);
    return { x, z };
  });
}

function pickLine(lines, fallback, projector, nearLon = null, nearLat = null) {
  let best = null;
  let bestScore = -Infinity;
  const target = nearLon != null ? projector.toLocal(nearLon, nearLat) : null;
  for (const line of lines) {
    const len = lineLen(line.pts);
    if (len < 30) continue;
    let score = len;
    if (target) {
      const mid = line.pts[Math.floor(line.pts.length / 2)];
      const dist = Math.hypot(mid.x - target[0], mid.z - target[1]);
      score = len - dist * 2.4;
    }
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  if (best && lineLen(best.pts) > 40) return best.pts;
  return fallbackPts(fallback, projector);
}

function resample(pts, step = 5) {
  if (pts.length < 2) return pts.slice();
  const out = [{ ...pts[0] }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x;
    const az = pts[i - 1].z;
    const bx = pts[i].x;
    const bz = pts[i].z;
    const len = Math.hypot(bx - ax, bz - az);
    let used = 0;
    while (acc + (len - used) >= step) {
      const remain = step - acc;
      const t = (used + remain) / len;
      out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
      used += remain;
      acc = 0;
    }
    acc += len - used;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].z - last.z) > 0.4) out.push({ ...last });
  return out;
}

function frames(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x, z: p.z, tx: dx / len, tz: dz / len, nx: dz / len, nz: -dx / len };
  });
}

function pathAt(pts, t) {
  const total = lineLen(pts);
  let acc = 0;
  const target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + seg >= target || i === pts.length - 1) {
      const u = seg ? (target - acc) / seg : 0;
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u;
      const z = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * u;
      const dx = pts[i].x - pts[i - 1].x;
      const dz = pts[i].z - pts[i - 1].z;
      const len = Math.hypot(dx, dz) || 1;
      return { x, z, tx: dx / len, tz: dz / len, nx: dz / len, nz: -dx / len, t };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  return { ...frames(pts)[pts.length - 1], t: 1 };
}

function boxGeo(x, y, z, sx, sy, sz, yaw) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  geo.translate(0, sy / 2, 0);
  geo.rotateY(yaw);
  geo.translate(x, y, z);
  return geo;
}

function cylGeo(x, y, z, radius, height, yaw = 0, radial = 8) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, radial);
  geo.translate(0, height / 2, 0);
  geo.rotateY(yaw);
  geo.translate(x, y, z);
  return geo;
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function strut(ax, ay, az, bx, by, bz, radius, radial = 5) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.08) return null;
  const geo = new THREE.CylinderGeometry(radius, radius, len, radial);
  geo.translate(0, len / 2, 0);
  _dir.set(dx, dy, dz).normalize();
  _quat.setFromUnitVectors(_up, _dir);
  geo.applyQuaternion(_quat);
  geo.translate(ax, ay, az);
  return geo;
}

function merge(list, material) {
  const geos = list.filter(Boolean).map((geo) => {
    const copy = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(copy.attributes)) {
      if (name !== 'position' && name !== 'normal') copy.deleteAttribute(name);
    }
    if (!copy.attributes.normal) copy.computeVertexNormals();
    return copy;
  });
  if (!geos.length) return null;
  const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (geos.length > 1) geos.forEach((geo) => geo.dispose?.());
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.noShadow = true;
  mesh.castShadow = false;
  return mesh;
}

function deckOutline(fr, half) {
  const left = fr.map((p) => [p.x + p.nx * half, p.z + p.nz * half]);
  const right = fr.map((p) => [p.x - p.nx * half, p.z - p.nz * half]).reverse();
  return left.concat(right, [left[0]]);
}

function closestOnLines(lines, x, z, maxDist) {
  let best = null;
  for (const line of lines || []) {
    const pts = line.pts;
    if (!pts || pts.length < 2) continue;
    const n = pts.length;
    const spans = line.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + dx * t;
      const pz = a[1] + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d > maxDist) continue;
      if (best && d >= best.d) continue;
      const len = Math.sqrt(len2) || 1;
      const half = line.half?.[Math.min(i, Math.max(0, (line.half.length || 1) - 1))] ?? 3.4;
      best = { x: px, z: pz, d, half, tx: dx / len, tz: dz / len };
    }
  }
  return best;
}

function onDeckCenter(pts, half, x, z) {
  for (let i = 0; i < pts.length - 1; i++) {
    if (distPointSeg(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z) < half * 0.55) return true;
  }
  return false;
}

function addRamps(pts, deckY, sample, half, centerlines) {
  const extra = [];
  for (const end of [0, pts.length - 1]) {
    const dir = end === 0 ? -1 : 1;
    const p = pts[end];
    const q = pts[end + dir] || p;
    const dx = p.x - q.x;
    const dz = p.z - q.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len;
    const tz = dz / len;
    const nx = tz;
    const nz = -tx;
    const probes = [
      [p.x + tx * 8, p.z + tz * 8],
      [p.x + tx * 18, p.z + tz * 18],
      [p.x + tx * 32, p.z + tz * 32],
      [p.x + nx * 12, p.z + nz * 12],
      [p.x - nx * 12, p.z - nz * 12],
      [p.x + tx * 10 + nx * 10, p.z + tz * 10 + nz * 10],
      [p.x + tx * 10 - nx * 10, p.z + tz * 10 - nz * 10],
      [p.x, p.z],
    ];
    let hit = null;
    for (const [sx, sz] of probes) {
      const cand = closestOnLines(centerlines, sx, sz, 48);
      if (!cand || onDeckCenter(pts, half, cand.x, cand.z)) continue;
      if (!hit || cand.d < hit.d) hit = cand;
    }
    const ramp = [{ x: p.x, z: p.z, y: deckY }];
    let rh = half;
    if (hit && Math.hypot(hit.x - p.x, hit.z - p.z) > 0.45) {
      const span = Math.hypot(hit.x - p.x, hit.z - p.z);
      const steps = Math.max(2, Math.ceil(span / 3.2));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = p.x + (hit.x - p.x) * t;
        const z = p.z + (hit.z - p.z) * t;
        const gy = sample(x, z) + 0.28;
        ramp.push({ x, z, y: deckY + (gy - deckY) * t });
      }
      ramp[ramp.length - 1].y = sample(hit.x, hit.z) + 0.28;
      rh = Math.max(half * 0.7, hit.half);
    } else {
      let x = p.x;
      let z = p.z;
      for (let i = 0; i < 18; i++) {
        x += tx * 4;
        z += tz * 4;
        const gy = sample(x, z);
        const t = (i + 1) / 18;
        const y = deckY + (Math.max(gy, deckY - 8) - deckY) * Math.min(1, t * t * 1.4);
        ramp.push({ x, z, y });
        if (gy >= deckY - 0.35) break;
      }
    }
    extra.push({ ramp, nx, nz, half: rh });
  }
  return extra;
}

function rampDeckRecords(ramps) {
  const decks = [];
  for (const { ramp, nx, nz, half } of ramps) {
    for (let i = 1; i < ramp.length; i++) {
      const a = ramp[i - 1];
      const b = ramp[i];
      const fr = frames([
        { x: a.x, z: a.z },
        { x: b.x, z: b.z },
      ]).map((p) => ({ ...p, nx, nz }));
      decks.push(Object.assign(deckRecord(fr, (a.y + b.y) / 2 + 0.04, half), { name: 'ramp' }));
    }
  }
  return decks;
}

function rampGeos(ramps) {
  const geos = [];
  for (const { ramp, nx, nz, half } of ramps) {
    for (let i = 1; i < ramp.length; i++) {
      const a = ramp[i - 1];
      const b = ramp[i];
      const geo = new THREE.BufferGeometry();
      const ax0 = a.x + nx * half;
      const az0 = a.z + nz * half;
      const ax1 = a.x - nx * half;
      const az1 = a.z - nz * half;
      const bx0 = b.x + nx * half;
      const bz0 = b.z + nz * half;
      const bx1 = b.x - nx * half;
      const bz1 = b.z - nz * half;
      geo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([
          ax0, a.y, az0, bx0, b.y, bz0, bx1, b.y, bz1,
          ax0, a.y, az0, bx1, b.y, bz1, ax1, a.y, az1,
        ], 3),
      );
      geo.computeVertexNormals();
      geos.push(geo);
    }
  }
  return geos;
}

function railBlockers(fr, half, y) {
  const strips = [];
  for (const side of [1, -1]) {
    const ring = [];
    for (const p of fr) {
      const ox = p.nx * (half - 0.18) * side;
      const oz = p.nz * (half - 0.18) * side;
      ring.push([p.x + ox + p.nx * 0.22 * side, p.z + oz + p.nz * 0.22 * side]);
    }
    for (const p of [...fr].reverse()) {
      const ox = p.nx * (half + 0.22) * side;
      const oz = p.nz * (half + 0.22) * side;
      ring.push([p.x + ox, p.z + oz]);
    }
    ring.push(ring[0]);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    strips.push({
      outer: ring,
      holes: [],
      minX,
      maxX,
      minZ,
      maxZ,
      y,
      blocksWalk: true,
      blocksCamera: false,
      kind: 'rail',
    });
  }
  return strips;
}

function deckRecord(fr, y, half, walk = true) {
  const outer = deckOutline(fr, half);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of outer) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const mid = fr[Math.floor(fr.length / 2)] || fr[0];
  const a = fr[0];
  const b = fr[fr.length - 1];
  return {
    outer,
    holes: [],
    minX,
    maxX,
    minZ,
    maxZ,
    y,
    walk,
    half,
    tx: mid?.tx || 0,
    tz: mid?.tz || 0,
    ends: a && b
      ? [
          { x: a.x, z: a.z, tx: -(a.tx || 0), tz: -(a.tz || 0), nx: a.nx || 0, nz: a.nz || 0, half, y },
          { x: b.x, z: b.z, tx: b.tx || 0, tz: b.tz || 0, nx: b.nx || 0, nz: b.nz || 0, half, y },
        ]
      : [],
    blocksWalk: false,
    blocksCamera: false,
    kind: 'deck',
  };
}

function deckMesh(fr, y, half, camber = 0) {
  const positions = [];
  const total = Math.max(1, fr.length - 1);
  for (let i = 0; i < fr.length - 1; i++) {
    const a = fr[i];
    const b = fr[i + 1];
    const ya = y + camber * Math.sin((i / total) * Math.PI);
    const yb = y + camber * Math.sin(((i + 1) / total) * Math.PI);
    const a0x = a.x + a.nx * half;
    const a0z = a.z + a.nz * half;
    const a1x = a.x - a.nx * half;
    const a1z = a.z - a.nz * half;
    const b0x = b.x + b.nx * half;
    const b0z = b.z + b.nz * half;
    const b1x = b.x - b.nx * half;
    const b1z = b.z - b.nz * half;
    positions.push(a0x, ya, a0z, b0x, yb, b0z, b1x, yb, b1z, a0x, ya, a0z, b1x, yb, b1z, a1x, ya, a1z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function deckSlab(fr, y, half, camber = 0, thick = 0.62) {
  const positions = [];
  const total = Math.max(1, fr.length - 1);
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };
  for (let i = 0; i < fr.length - 1; i++) {
    const a = fr[i];
    const b = fr[i + 1];
    const ya = y + camber * Math.sin((i / total) * Math.PI);
    const yb = y + camber * Math.sin(((i + 1) / total) * Math.PI);
    const a0x = a.x + a.nx * half;
    const a0z = a.z + a.nz * half;
    const a1x = a.x - a.nx * half;
    const a1z = a.z - a.nz * half;
    const b0x = b.x + b.nx * half;
    const b0z = b.z + b.nz * half;
    const b1x = b.x - b.nx * half;
    const b1z = b.z - b.nz * half;
    push(a0x, ya, a0z, b0x, yb, b0z, b1x, yb, b1z);
    push(a0x, ya, a0z, b1x, yb, b1z, a1x, ya, a1z);
    push(a0x, ya - thick, a0z, b1x, yb - thick, b1z, b0x, yb - thick, b0z);
    push(a0x, ya - thick, a0z, a1x, ya - thick, a1z, b1x, yb - thick, b1z);
    push(a0x, ya, a0z, b0x, yb, b0z, b0x, yb - thick, b0z);
    push(a0x, ya, a0z, b0x, yb - thick, b0z, a0x, ya - thick, a0z);
    push(a1x, ya, a1z, b1x, yb - thick, b1z, b1x, yb, b1z);
    push(a1x, ya, a1z, a1x, ya - thick, a1z, b1x, yb - thick, b1z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function northEndT(pts) {
  const a = pathAt(pts, 0.08);
  const b = pathAt(pts, 0.92);
  return a.z >= b.z ? 0.08 : 0.92;
}

function buildMarian(pts, waterY, sample, detail, centerlines) {
  const deckY = waterY + 9.15;
  const fr = frames(resample(pts, 4.2));
  const half = 8.55;
  const steel = new THREE.MeshLambertMaterial({ color: 0xcfd6dc, emissive: 0x6a7884, emissiveIntensity: 0.08 });
  const pale = new THREE.MeshLambertMaterial({ color: 0xf4f8fb, emissive: 0xc5d4e0, emissiveIntensity: 0.42 });
  const road = new THREE.MeshLambertMaterial({ color: 0x4a5158 });
  const walk = new THREE.MeshLambertMaterial({ color: 0xd9d2c6 });
  const cableGeos = [];
  const pylonGeos = [];
  const tPylon = northEndT(pts);
  const abut = pathAt(pts, tPylon);
  const intoSpan = tPylon < 0.5 ? 1 : -1;
  const h = 74;
  const baseY = deckY - 3.2;
  const pylons = [];
  for (const side of [-1, 1]) {
    const x = abut.x + abut.nx * 9.6 * side + abut.tx * intoSpan * 14;
    const z = abut.z + abut.nz * 9.6 * side + abut.tz * intoSpan * 14;
    const yaw = Math.atan2(abut.tx, abut.tz);
    const lean = intoSpan * 0.045;
    const shaft = new THREE.BoxGeometry(3.6, h, 5.4);
    shaft.translate(0, h / 2, 0);
    shaft.rotateX(lean);
    shaft.rotateY(yaw);
    shaft.translate(x, baseY, z);
    pylonGeos.push(shaft);
    const cap = new THREE.BoxGeometry(4.6, 2.2, 6.2);
    cap.translate(0, h + 0.5, 0);
    cap.rotateX(lean);
    cap.rotateY(yaw);
    cap.translate(x, baseY, z);
    pylonGeos.push(cap);
    const top = new THREE.Vector3(
      x + abut.tx * intoSpan * 3.4,
      baseY + h * 0.98,
      z + abut.tz * intoSpan * 3.4,
    );
    pylons.push({ x, z, y: baseY, top, side });
  }
  pylonGeos.push(strut(pylons[0].top.x, pylons[0].top.y, pylons[0].top.z, pylons[1].top.x, pylons[1].top.y, pylons[1].top.z, 0.55, 6));
  const spanStart = tPylon < 0.5 ? 0.18 : 0.12;
  const spanEnd = tPylon < 0.5 ? 0.96 : 0.82;
  const n = 15;
  for (const pylon of pylons) {
    for (let i = 0; i < n; i++) {
      const t = spanStart + (spanEnd - spanStart) * ((i + 0.08) / (n - 0.2));
      const at = pathAt(pts, t);
      const deck = {
        x: at.x + at.nx * 1.15 * pylon.side,
        y: deckY + 1.32,
        z: at.z + at.nz * 1.15 * pylon.side,
      };
      cableGeos.push(strut(pylon.top.x, pylon.top.y, pylon.top.z, deck.x, deck.y, deck.z, 0.11, 4));
    }
  }
  const ramps = addRamps(fr, deckY, sample, half, centerlines);
  const group = new THREE.Group();
  group.name = 'mariansky';
  const roadMesh = merge([deckSlab(fr, deckY, half, 0, 0.85), ...rampGeos(ramps)], road);
  if (roadMesh) {
    roadMesh.renderOrder = 2;
    roadMesh.material.polygonOffset = true;
    roadMesh.material.polygonOffsetFactor = -8;
    roadMesh.material.polygonOffsetUnits = -8;
    roadMesh.material.depthWrite = true;
  }
  const walkMesh = merge([deckSlab(fr, deckY + 1.22, 1.9, 0, 0.28)], walk);
  const pylonMesh = merge(pylonGeos.filter(Boolean), pale);
  const cableMesh = merge(cableGeos.filter(Boolean), pale);
  if (roadMesh) group.add(roadMesh);
  if (walkMesh) group.add(walkMesh);
  if (pylonMesh) group.add(pylonMesh);
  if (cableMesh) group.add(cableMesh);
  const rails = [];
  for (let i = 0; i < fr.length; i += detail ? 1 : 2) {
    const p = fr[i];
    for (const side of [-1, 1]) {
      rails.push(boxGeo(p.x + p.nx * half * side, deckY, p.z + p.nz * half * side, 0.08, 1.15, 0.08, Math.atan2(p.tx, p.tz)));
    }
    rails.push(boxGeo(p.x, deckY + 1.18, p.z, 0.08, 1.05, 0.08, Math.atan2(p.tx, p.tz)));
  }
  const railMesh = merge(rails, steel);
  if (railMesh) group.add(railMesh);
  return {
    group,
    decks: [
      Object.assign(deckRecord(fr, deckY + 0.06, half + 0.15), { name: 'marian' }),
      ...rampDeckRecords(ramps),
    ],
    rails: railBlockers(fr, half, deckY),
    lights: pylons.map((p) => ({ x: p.x, y: p.y + 12, z: p.z })),
  };
}

function buildBenes(pts, waterY, sample, detail, centerlines) {
  const deckY = waterY + 7.8;
  const camber = 3.4;
  const rise = 22;
  const fr = frames(resample(pts, 4.2));
  const half = 8.88;
  const steel = new THREE.MeshLambertMaterial({ color: 0x8e8a82, emissive: 0x3a342c, emissiveIntensity: 0.08 });
  const rust = new THREE.MeshLambertMaterial({ color: 0x7a7368, emissive: 0x2a241c, emissiveIntensity: 0.05 });
  const road = new THREE.MeshLambertMaterial({ color: 0x42484f });
  const walk = new THREE.MeshLambertMaterial({ color: 0xcfc6b8 });
  const archGeos = [];
  const hangers = [];
  const t0 = 0.07;
  const t1 = 0.93;
  const hangerN = 21;
  const archSamples = 36;
  const archAt = (t, side) => {
    const u = (t - t0) / (t1 - t0);
    const at = pathAt(pts, t);
    const yDeck = deckY + camber * Math.sin(Math.max(0, Math.min(1, u)) * Math.PI);
    const arch = rise * Math.sin(Math.max(0, Math.min(1, u)) * Math.PI);
    return {
      x: at.x + at.nx * 7.35 * side,
      y: yDeck + arch,
      z: at.z + at.nz * 7.35 * side,
      yDeck,
      at,
    };
  };
  for (const side of [-1, 1]) {
    let prev = null;
    for (let i = 0; i <= archSamples; i++) {
      const t = t0 + (t1 - t0) * (i / archSamples);
      const p = archAt(t, side);
      if (prev) archGeos.push(strut(prev.x, prev.y, prev.z, p.x, p.y, p.z, 0.42, 6));
      prev = p;
    }
    for (let i = 0; i < hangerN; i++) {
      const t = t0 + (t1 - t0) * ((i + 0.5) / hangerN);
      const p = archAt(t, side);
      hangers.push(strut(p.x, p.yDeck + 0.15, p.z, p.x, p.y - 0.2, p.z, 0.09, 5));
    }
  }
  for (let i = 0; i <= 8; i++) {
    const t = t0 + (t1 - t0) * (i / 8);
    const a = archAt(t, -1);
    const b = archAt(t, 1);
    archGeos.push(strut(a.x, a.y, a.z, b.x, b.y, b.z, 0.28, 5));
  }
  const pierA = pathAt(pts, 0.28);
  const pierB = pathAt(pts, 0.72);
  for (const p of [pierA, pierB]) {
    archGeos.push(boxGeo(p.x, waterY - 2.4, p.z, 6.2, deckY - waterY + 4.2, 4.2, Math.atan2(p.tx, p.tz)));
  }
  const ramps = addRamps(fr, deckY, sample, half, centerlines);
  const group = new THREE.Group();
  group.name = 'benes';
  const roadMesh = merge([deckMesh(fr, deckY, half - 2.1, camber), ...rampGeos(ramps)], road);
  const walkL = deckMesh(fr.map((p) => ({ ...p, x: p.x + p.nx * (half - 1.05), z: p.z + p.nz * (half - 1.05) })), deckY + 0.12, 1.15, camber);
  const walkR = deckMesh(fr.map((p) => ({ ...p, x: p.x - p.nx * (half - 1.05), z: p.z - p.nz * (half - 1.05) })), deckY + 0.12, 1.15, camber);
  const walkMesh = merge([walkL, walkR], walk);
  const steelMesh = merge(archGeos.filter(Boolean), steel);
  const hangerMesh = merge(hangers.filter(Boolean), rust);
  if (roadMesh) group.add(roadMesh);
  if (walkMesh) group.add(walkMesh);
  if (steelMesh) group.add(steelMesh);
  if (hangerMesh) group.add(hangerMesh);
  const rails = [];
  const total = Math.max(1, fr.length - 1);
  for (let i = 0; i < fr.length; i += detail ? 1 : 2) {
    const p = fr[i];
    const y = deckY + camber * Math.sin((i / total) * Math.PI);
    for (const side of [-1, 1]) rails.push(boxGeo(p.x + p.nx * half * side, y, p.z + p.nz * half * side, 0.08, 1.1, 0.08, Math.atan2(p.tx, p.tz)));
  }
  const railMesh = merge(rails, steel);
  if (railMesh) group.add(railMesh);
  return {
    group,
    decks: [Object.assign(deckRecord(fr, deckY + 0.05, half), { name: 'benes' }), ...rampDeckRecords(ramps)],
    rails: railBlockers(fr, half, deckY),
    lights: [pierA, pierB].map((p) => ({ x: p.x, y: deckY + 4.2, z: p.z })),
  };
}

function buildRail(pts, waterY, sample, detail, centerlines) {
  const topY = waterY + 12.4;
  const botY = waterY + 6.2;
  const fr = frames(resample(pts, detail ? 6.5 : 9));
  const steel = new THREE.MeshLambertMaterial({ color: 0x6a6e74, emissive: 0x1c1e22, emissiveIntensity: 0.08 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x3a3e44 });
  const walk = new THREE.MeshLambertMaterial({ color: 0xc2bbb0 });
  const geos = [];
  const sleepers = [];
  const tracks = [];
  const trussHalf = 5.4;
  const walkShift = -trussHalf - 2.45;
  for (const side of [-1, 1]) {
    const chord = fr.map((p) => ({
      x: p.x + p.nx * trussHalf * side,
      z: p.z + p.nz * trussHalf * side,
      tx: p.tx,
      tz: p.tz,
    }));
    for (let i = 1; i < chord.length; i++) {
      const a = chord[i - 1];
      const b = chord[i];
      geos.push(strut(a.x, botY, a.z, b.x, botY, b.z, 0.22, 5));
      geos.push(strut(a.x, topY, a.z, b.x, topY, b.z, 0.22, 5));
    }
    for (let i = 0; i < chord.length; i++) {
      const a = chord[i];
      geos.push(strut(a.x, botY, a.z, a.x, topY, a.z, 0.16, 5));
      if (i + 1 < chord.length) {
        const b = chord[i + 1];
        if (i % 2 === 0) geos.push(strut(a.x, botY, a.z, b.x, topY, b.z, 0.12, 4));
        else geos.push(strut(a.x, topY, a.z, b.x, botY, b.z, 0.12, 4));
      }
    }
    tracks.push(deckRecord(
      fr.map((p) => ({ ...p, x: p.x + p.nx * 2.4 * side, z: p.z + p.nz * 2.4 * side })),
      topY + 0.25,
      2.2,
      false,
    ));
  }
  for (let i = 0; i < fr.length; i++) {
    const p = fr[i];
    geos.push(strut(
      p.x + p.nx * trussHalf,
      topY,
      p.z + p.nz * trussHalf,
      p.x - p.nx * trussHalf,
      topY,
      p.z - p.nz * trussHalf,
      0.14,
      4,
    ));
    geos.push(strut(
      p.x + p.nx * trussHalf,
      botY,
      p.z + p.nz * trussHalf,
      p.x - p.nx * trussHalf,
      botY,
      p.z - p.nz * trussHalf,
      0.14,
      4,
    ));
    sleepers.push(boxGeo(p.x, topY, p.z, trussHalf * 2 - 0.4, 0.16, 0.28, Math.atan2(p.nx, p.nz)));
  }
  for (const t of [1 / 6, 0.5, 5 / 6]) {
    const p = pathAt(pts, t);
    geos.push(boxGeo(p.x, waterY - 1.8, p.z, trussHalf * 2 + 1.6, botY - waterY + 2.4, 3.8, Math.atan2(p.tx, p.tz)));
  }
  const walkFr = fr.map((p) => ({ ...p, x: p.x + p.nx * walkShift, z: p.z + p.nz * walkShift }));
  const walkGeos = [deckSlab(walkFr, botY + 0.12, 1.2, 0, 0.28)];
  const ramps = addRamps(walkFr, botY + 0.08, sample, 1.25, centerlines);
  const group = new THREE.Group();
  group.name = 'zeleznice';
  const steelMesh = merge(geos.filter(Boolean), steel);
  const walkMesh = merge([...walkGeos, ...rampGeos(ramps)], walk);
  const trackMesh = merge(
    [
      ...sleepers,
      ...fr.flatMap((p) => [
        boxGeo(p.x + p.nx * 0.95, topY + 0.16, p.z + p.nz * 0.95, 0.16, 0.14, 1.3, Math.atan2(p.tx, p.tz)),
        boxGeo(p.x - p.nx * 0.95, topY + 0.16, p.z - p.nz * 0.95, 0.16, 0.14, 1.3, Math.atan2(p.tx, p.tz)),
        boxGeo(p.x + p.nx * 2.55, topY + 0.16, p.z + p.nz * 2.55, 0.16, 0.14, 1.3, Math.atan2(p.tx, p.tz)),
        boxGeo(p.x - p.nx * 2.55, topY + 0.16, p.z - p.nz * 2.55, 0.16, 0.14, 1.3, Math.atan2(p.tx, p.tz)),
      ]),
    ],
    dark,
  );
  if (steelMesh) group.add(steelMesh);
  if (walkMesh) group.add(walkMesh);
  if (trackMesh) group.add(trackMesh);
  return {
    group,
    decks: [deckRecord(walkFr, botY + 0.12, 1.35), ...tracks],
    rails: [
      ...railBlockers(walkFr, 1.35, botY),
      ...tracks.map((track) => ({ ...track, blocksWalk: true, kind: 'track' })),
    ],
    lights: [{ x: pathAt(pts, 0.5).x, y: topY + 1.2, z: pathAt(pts, 0.5).z }],
  };
}

export function addSignatureBridges(group, { highways, railways, projector, sample, waterY = 1.1, detail = true, centerlines }) {
  const marianPts = pickLine(
    namedLines(highways, projector, (tags) => /Mariánský most/i.test(tags.name || '')),
    MARIAN_FALLBACK,
    projector,
    14.0536,
    50.6603,
  );
  const benesPts = pickLine(
    namedLines(highways, projector, (tags) => /Beneše/i.test(tags.name || '') && tags.bridge === 'yes'),
    BENES_FALLBACK,
    projector,
    14.04694,
    50.65944,
  );
  const railPts = pickLine(
    namedLines(railways, projector, (tags) => tags.railway === 'rail' && (tags.bridge === 'yes' || tags.bridge === 'viaduct'))
      .concat(namedLines(highways, projector, (tags) => tags.railway === 'rail')),
    RAIL_FALLBACK,
    projector,
    14.04386,
    50.65608,
  );
  const parts = [
    buildMarian(marianPts, waterY, sample, detail, centerlines),
    buildBenes(benesPts, waterY, sample, detail, centerlines),
    buildRail(railPts, waterY, sample, detail, centerlines),
  ];
  const decks = [];
  const rails = [];
  const lights = [];
  const root = new THREE.Group();
  root.name = 'bridges';
  for (const part of parts) {
    root.add(part.group);
    decks.push(...part.decks);
    rails.push(...part.rails);
    lights.push(...part.lights);
  }
  group.add(root);
  return { decks, rails, lights, waterY };
}

export function onDeck(decks, x, z, radius = 0.45) {
  for (const deck of decks || []) {
    if (!deck.walk) continue;
    if (x + radius < deck.minX || x - radius > deck.maxX || z + radius < deck.minZ || z - radius > deck.maxZ) continue;
    if (pointInRing(x, z, deck.outer)) return deck;
  }
  return null;
}

export function deckHeight(decks, x, z, fallback) {
  const hit = onDeck(decks, x, z);
  return hit ? hit.y : fallback;
}

export function nearestWalkDeck(decks, x, z, maxDist = 48) {
  let best = null;
  for (const deck of decks || []) {
    if (!deck.walk) continue;
    const cx = (deck.minX + deck.maxX) / 2;
    const cz = (deck.minZ + deck.maxZ) / 2;
    const dist = Math.hypot(x - cx, z - cz);
    if (dist > maxDist) continue;
    if (!best || dist < best.dist) best = { deck, dist, cx, cz };
  }
  return best;
}

export function seatRoadsToDecks(geometry, decks) {
  if (!geometry?.attributes?.position || !decks?.length) return;
  const pos = geometry.attributes.position;
  const abutments = [];
  for (const deck of decks) {
    if (!deck.walk || deck.name === 'ramp' || deck.kind === 'track') continue;
    if (!(deck.half > 3.2) || !deck.ends?.length) continue;
    for (const end of deck.ends) abutments.push(end);
  }
  if (!abutments.length) return;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let nearest = null;
    for (const end of abutments) {
      const dist = Math.hypot(x - end.x, z - end.z);
      if (dist > 22) continue;
      const across = Math.abs((x - end.x) * end.nx + (z - end.z) * end.nz);
      if (across > end.half + 6.5) continue;
      if (Math.abs(y - end.y) > 10) continue;
      if (!nearest || dist < nearest.dist) nearest = { dist, end };
    }
    if (!nearest) continue;
    const t = Math.min(1, nearest.dist / 20);
    const ease = (1 - t) * (1 - t);
    pos.setY(i, nearest.end.y * ease + y * (1 - ease));
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

export function punchWaterUnderDecks(geometry, decks, waterY) {
  if (!geometry?.attributes?.position || !decks?.length) return;
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const hide = [];
  const triCount = index ? index.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const x = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
    const y = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
    const z = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
    if (Math.abs(y - waterY) > 2.4) continue;
    for (const deck of decks) {
      if (x < deck.minX - 0.4 || x > deck.maxX + 0.4 || z < deck.minZ - 0.4 || z > deck.maxZ + 0.4) continue;
      if (pointInRing(x, z, deck.outer)) {
        hide.push(t);
        break;
      }
    }
  }
  if (!hide.length) return;
  const drop = new Set(hide);
  if (index) {
    const next = [];
    for (let t = 0; t < triCount; t++) {
      if (drop.has(t)) continue;
      next.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
    }
    geometry.setIndex(next);
  } else {
    const next = [];
    for (let t = 0; t < triCount; t++) {
      if (drop.has(t)) continue;
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        next.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(next, 3));
  }
  geometry.computeVertexNormals();
}
