import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointInRing } from './geom.js';

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

function pickLine(lines, fallback, projector) {
  let best = null;
  let bestLen = 0;
  for (const line of lines) {
    const len = lineLen(line.pts);
    if (len > bestLen) {
      best = line;
      bestLen = len;
    }
  }
  if (best && bestLen > 40) return best.pts;
  return fallback.map(([lon, lat]) => {
    const [x, z] = projector.toLocal(lon, lat);
    return { x, z };
  });
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

function addRamps(pts, deckY, sample, half) {
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
    let x = p.x;
    let z = p.z;
    const ramp = [{ x, z, y: deckY }];
    for (let i = 0; i < 18; i++) {
      x += tx * 4;
      z += tz * 4;
      const gy = sample(x, z);
      const t = (i + 1) / 18;
      const y = deckY + (Math.max(gy, deckY - 8) - deckY) * Math.min(1, t * t * 1.4);
      ramp.push({ x, z, y });
      if (gy >= deckY - 0.35) break;
    }
    extra.push({ ramp, nx: tz, nz: -tx, half });
  }
  return extra;
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
  return {
    outer,
    holes: [],
    minX,
    maxX,
    minZ,
    maxZ,
    y,
    walk,
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

function northEndT(pts) {
  const a = pathAt(pts, 0.08);
  const b = pathAt(pts, 0.92);
  return a.z >= b.z ? 0.08 : 0.92;
}

function buildMarian(pts, waterY, sample, detail) {
  const deckY = waterY + 8.6;
  const fr = frames(resample(pts, 6));
  const half = 8.4;
  const steel = new THREE.MeshLambertMaterial({ color: 0xcfd6dc, emissive: 0x6a7884, emissiveIntensity: 0.08 });
  const pale = new THREE.MeshLambertMaterial({ color: 0xe8eef2, emissive: 0x8aa0b0, emissiveIntensity: 0.12 });
  const road = new THREE.MeshLambertMaterial({ color: 0x4a5158 });
  const walk = new THREE.MeshLambertMaterial({ color: 0xd9d2c6 });
  const cablePts = [];
  const deckGeo = deckMesh(fr, deckY, half);
  const walkGeo = deckMesh(fr, deckY + 1.15, 1.7);
  const pylonGeos = [];
  const tPylon = northEndT(pts);
  const base = pathAt(pts, tPylon);
  const toward = tPylon < 0.5 ? 1 : -1;
  const pylons = [];
  for (const side of [-1, 1]) {
    const x = base.x + base.nx * 5.4 * side - base.tx * toward * 6;
    const z = base.z + base.nz * 5.4 * side - base.tz * toward * 6;
    const y = sample(x, z);
    const h = 73;
    const lean = 0.09 * toward;
    const shaft = new THREE.BoxGeometry(2.4, h, 3.1);
    shaft.translate(0, h / 2, 0);
    shaft.rotateZ(side * 0.04);
    shaft.rotateX(lean);
    shaft.rotateY(Math.atan2(base.tx, base.tz));
    shaft.translate(x, y, z);
    pylonGeos.push(shaft);
    const top = new THREE.Vector3(x + base.tx * toward * 6.4, y + h * 0.96, z + base.tz * toward * 6.4);
    pylons.push({ x, z, y, top, side });
  }
  const spanStart = tPylon < 0.5 ? 0.16 : 0.18;
  const spanEnd = tPylon < 0.5 ? 0.92 : 0.84;
  const n = detail ? 15 : 9;
  for (const pylon of pylons) {
    for (let i = 0; i < n; i++) {
      const t = spanStart + (spanEnd - spanStart) * ((i + 0.5) / n);
      const at = pathAt(pts, t);
      const deck = new THREE.Vector3(at.x + at.nx * 3.2 * pylon.side, deckY + 1.2, at.z + at.nz * 3.2 * pylon.side);
      cablePts.push(pylon.top.clone(), deck);
    }
  }
  const ramps = addRamps(fr, deckY, sample, half);
  const group = new THREE.Group();
  group.name = 'mariansky';
  const roadMesh = merge([deckGeo], road);
  const walkMesh = merge([walkGeo], walk);
  const pylonMesh = merge(pylonGeos, pale);
  const extra = merge(rampGeos(ramps), steel);
  if (roadMesh) group.add(roadMesh);
  if (walkMesh) group.add(walkMesh);
  if (pylonMesh) group.add(pylonMesh);
  if (extra) group.add(extra);
  if (cablePts.length) {
    const cableGeo = new THREE.BufferGeometry().setFromPoints(cablePts);
    const cables = new THREE.LineSegments(cableGeo, new THREE.LineBasicMaterial({ color: 0xe7eef4, transparent: true, opacity: 0.92 }));
    cables.userData.noShadow = true;
    group.add(cables);
  }
  const rails = [];
  for (let i = 0; i < fr.length; i += detail ? 1 : 2) {
    const p = fr[i];
    for (const side of [-1, 1]) {
      rails.push(boxGeo(p.x + p.nx * half * side, deckY, p.z + p.nz * half * side, 0.08, 1.15, 0.08, Math.atan2(p.tx, p.tz)));
    }
  }
  const railMesh = merge(rails, steel);
  if (railMesh) group.add(railMesh);
  return {
    group,
    decks: [deckRecord(fr, deckY + 0.04, half)],
    rails: railBlockers(fr, half, deckY),
    lights: pylons.map((p) => ({ x: p.x, y: p.y + 8, z: p.z })),
  };
}

function buildBenes(pts, waterY, sample, detail) {
  const deckY = waterY + 7.8;
  const camber = 3.4;
  const fr = frames(resample(pts, 5.15));
  const half = 8.88;
  const steel = new THREE.MeshLambertMaterial({ color: 0x8e8a82, emissive: 0x3a342c, emissiveIntensity: 0.06 });
  const rust = new THREE.MeshLambertMaterial({ color: 0x6e675c });
  const road = new THREE.MeshLambertMaterial({ color: 0x42484f });
  const geos = [deckMesh(fr, deckY, half, camber)];
  const hangers = [];
  const n = detail ? 21 : 11;
  const total = Math.max(1, fr.length - 1);
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const at = pathAt(pts, 0.08 + 0.84 * t);
      const yDeck = deckY + camber * Math.sin(t * Math.PI);
      const arch = 22 * Math.sin(t * Math.PI);
      hangers.push(cylGeo(at.x + at.nx * 7.1 * side, yDeck, at.z + at.nz * 7.1 * side, 0.12, arch, 0, 5));
    }
    for (let i = 0; i < fr.length; i++) {
      const t = i / total;
      const p = fr[i];
      const yDeck = deckY + camber * Math.sin(t * Math.PI);
      const arch = 22 * Math.sin(t * Math.PI);
      const x = p.x + p.nx * 7.1 * side;
      const z = p.z + p.nz * 7.1 * side;
      const next = fr[Math.min(fr.length - 1, i + 1)];
      const span = Math.max(2.2, Math.hypot(next.x - p.x, next.z - p.z) * 1.05);
      geos.push(boxGeo(x, yDeck + arch - 0.25, z, 0.48, 0.48, span, Math.atan2(p.tx, p.tz)));
    }
  }
  for (let i = 0; i < fr.length; i += Math.max(1, Math.round(fr.length / 9))) {
    const t = i / total;
    const p = fr[i];
    const yDeck = deckY + camber * Math.sin(t * Math.PI);
    const arch = 22 * Math.sin(t * Math.PI);
    geos.push(boxGeo(p.x, yDeck + arch, p.z, 14.4, 0.45, 0.45, Math.atan2(p.nx, p.nz)));
  }
  const pierA = pathAt(pts, 0.28);
  const pierB = pathAt(pts, 0.72);
  for (const p of [pierA, pierB]) {
    geos.push(boxGeo(p.x, waterY - 2, p.z, 5.4, deckY - waterY + 3.2, 3.4, Math.atan2(p.tx, p.tz)));
  }
  const ramps = addRamps(fr, deckY, sample, half);
  const group = new THREE.Group();
  group.name = 'benes';
  const roadMesh = merge([geos[0], ...rampGeos(ramps)], road);
  const steelMesh = merge(geos.slice(1), steel);
  const hangerMesh = merge(hangers, rust);
  if (roadMesh) group.add(roadMesh);
  if (steelMesh) group.add(steelMesh);
  if (hangerMesh) group.add(hangerMesh);
  const rails = [];
  for (let i = 0; i < fr.length; i += detail ? 1 : 2) {
    const p = fr[i];
    const y = deckY + camber * Math.sin((i / total) * Math.PI);
    for (const side of [-1, 1]) rails.push(boxGeo(p.x + p.nx * half * side, y, p.z + p.nz * half * side, 0.08, 1.1, 0.08, Math.atan2(p.tx, p.tz)));
  }
  const railMesh = merge(rails, steel);
  if (railMesh) group.add(railMesh);
  return {
    group,
    decks: [deckRecord(fr, deckY + 0.05, half)],
    rails: railBlockers(fr, half, deckY),
    lights: [pierA, pierB].map((p) => ({ x: p.x, y: deckY + 4.2, z: p.z })),
  };
}

function buildRail(pts, waterY, sample, detail) {
  const deckY = waterY + 7.4;
  const fr = frames(resample(pts, 8));
  const half = 6.1;
  const steel = new THREE.MeshLambertMaterial({ color: 0x6d7176, emissive: 0x222428, emissiveIntensity: 0.05 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x3c4046 });
  const walk = new THREE.MeshLambertMaterial({ color: 0xb7b1a6 });
  const geos = [];
  const walkGeos = [deckMesh(fr, deckY - 5.4, 1.35)];
  const tracks = [];
  for (const side of [-1, 1]) {
    const shift = 2.7 * side;
    const local = fr.map((p) => ({ ...p, x: p.x + p.nx * shift, z: p.z + p.nz * shift }));
    geos.push(deckMesh(local, deckY, 2.55));
    const nBay = detail ? 16 : 9;
    for (let i = 0; i < local.length - 1; i++) {
      const a = local[i];
      const b = local[i + 1];
      const yaw = Math.atan2(a.tx, a.tz);
      geos.push(boxGeo(a.x, deckY - 5.2, a.z, 0.22, 5.2, 0.22, yaw));
      if (i % Math.max(1, Math.round(local.length / nBay)) === 0) {
        geos.push(boxGeo(a.x, deckY - 5.2, a.z, 5.1, 0.22, 0.22, yaw));
        geos.push(boxGeo((a.x + b.x) / 2, deckY - 2.6, (a.z + b.z) / 2, 0.16, 0.16, Math.hypot(b.x - a.x, b.z - a.z), yaw));
      }
    }
    tracks.push(deckRecord(local, deckY + 0.2, 2.4, false));
  }
  for (const t of [0.2, 0.5, 0.8]) {
    const p = pathAt(pts, t);
    geos.push(boxGeo(p.x, waterY - 1.6, p.z, 7.4, deckY - waterY + 2.2, 3.6, Math.atan2(p.tx, p.tz)));
  }
  const ramps = addRamps(fr.map((p) => ({ x: p.x + p.nx * -5.2, z: p.z + p.nz * -5.2 })), deckY - 5.4, sample, 1.35);
  const group = new THREE.Group();
  group.name = 'zeleznice';
  const steelMesh = merge(geos, steel);
  const walkMesh = merge([...walkGeos, ...rampGeos(ramps)], walk);
  const trackMesh = merge(
    fr.flatMap((p) => [
      boxGeo(p.x + p.nx * 1.6, deckY, p.z + p.nz * 1.6, 0.18, 0.18, 1.2, Math.atan2(p.tx, p.tz)),
      boxGeo(p.x - p.nx * 1.6, deckY, p.z - p.nz * 1.6, 0.18, 0.18, 1.2, Math.atan2(p.tx, p.tz)),
    ]),
    dark,
  );
  if (steelMesh) group.add(steelMesh);
  if (walkMesh) group.add(walkMesh);
  if (trackMesh) group.add(trackMesh);
  const walkFr = fr.map((p) => ({ ...p, x: p.x + p.nx * -5.2, z: p.z + p.nz * -5.2 }));
  return {
    group,
    decks: [deckRecord(walkFr, deckY - 5.35, 1.4), ...tracks],
    rails: [
      ...railBlockers(walkFr, 1.4, deckY - 5.4),
      ...tracks.map((track) => ({ ...track, blocksWalk: true, kind: 'track' })),
    ],
    lights: [{ x: pathAt(pts, 0.5).x, y: deckY + 2, z: pathAt(pts, 0.5).z }],
  };
}

export function addSignatureBridges(group, { highways, railways, projector, sample, waterY = 1.1, detail = true }) {
  const marianPts = pickLine(
    namedLines(highways, projector, (tags) => /Mariánský most/i.test(tags.name || '')),
    MARIAN_FALLBACK,
    projector,
  );
  const benesPts = pickLine(
    namedLines(highways, projector, (tags) => /Beneše/i.test(tags.name || '') && tags.bridge === 'yes'),
    BENES_FALLBACK,
    projector,
  );
  const railPts = pickLine(
    namedLines(railways, projector, (tags) => tags.railway === 'rail' && tags.bridge === 'yes')
      .concat(namedLines(highways, projector, (tags) => tags.railway === 'rail' && tags.bridge === 'yes')),
    RAIL_FALLBACK,
    projector,
  );
  const parts = [
    buildMarian(marianPts, waterY, sample, detail),
    buildBenes(benesPts, waterY, sample, detail),
    buildRail(railPts, waterY, sample, detail),
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
