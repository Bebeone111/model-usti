import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { roadWidth } from './geom.js';

const NOT_CARRIAGE = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track', 'platform']);
const SNAP_MAX = 16;

function carriageSegs(highways, projector) {
  const segs = [];
  for (const feature of highways?.features || []) {
    if (feature.geometry?.type !== 'LineString') continue;
    const tags = feature.properties || {};
    const key = String(tags.highway || '').replace(/_link$/, '');
    if (!key || NOT_CARRIAGE.has(key)) continue;
    const width = roadWidth(tags.highway);
    if (!(width > 2)) continue;
    const pts = feature.geometry.coordinates.map(([lon, lat]) => projector.toLocal(lon, lat));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.6) continue;
      segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], dx, dz, len, width });
    }
  }
  return segs;
}

function snapToRoad(x, z, segs) {
  let best = null;
  for (const seg of segs) {
    const t = Math.max(0, Math.min(1, ((x - seg.ax) * seg.dx + (z - seg.az) * seg.dz) / (seg.len * seg.len)));
    const px = seg.ax + seg.dx * t;
    const pz = seg.az + seg.dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d > SNAP_MAX) continue;
    if (!best || d < best.d - 0.35 || (Math.abs(d - best.d) < 0.35 && seg.width > best.width)) {
      best = { x: px, z: pz, d, tx: seg.dx / seg.len, tz: seg.dz / seg.len, width: seg.width };
    }
  }
  return best;
}

function unit(x, z, salt) {
  let h = Math.imul((Math.round(x * 10) ^ Math.imul(Math.round(z * 10), 0x9e3779b1) ^ salt) >>> 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h >>> 0) / 4294967296;
}

function inside(projector, x, z) {
  return x > projector.minX + 2 && x < projector.maxX - 2 && z > projector.minZ + 2 && z < projector.maxZ - 2;
}

function instanced(geometry, material, points, place) {
  if (!points.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, points.length);
  const dummy = new THREE.Object3D();
  points.forEach((point, index) => {
    place(dummy, point);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.fullCount = points.length;
  return mesh;
}

function stripeGeometry() {
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    const piece = new THREE.BoxGeometry(0.48, 0.07, 3.4);
    piece.translate((i - 1.5) * 0.95, 0, 0);
    pieces.push(piece);
  }
  return mergeGeometries(pieces, false);
}

export function addStreetFurniture(group, collection, projector, sample, highways = null) {
  const benches = [];
  const lamps = [];
  const stops = [];
  const bins = [];
  const crossings = [];
  const roads = carriageSegs(highways, projector);
  let missedCrossings = 0;
  for (const feature of collection?.features || []) {
    if (feature.geometry?.type !== 'Point') continue;
    const [lon, lat] = feature.geometry.coordinates;
    const [x, z] = projector.toLocal(lon, lat);
    if (!inside(projector, x, z)) continue;
    const tags = feature.properties || {};
    const point = { x, z, y: sample(x, z), rot: unit(x, z, 7) * Math.PI * 2 };
    if (tags.amenity === 'bench') benches.push(point);
    else if (tags.highway === 'street_lamp') lamps.push({ ...point, name: tags.name || '' });
    else if (tags.highway === 'bus_stop') stops.push({ ...point, name: tags.name || '' });
    else if (tags.amenity === 'waste_basket') bins.push(point);
    else if (tags.highway === 'crossing') {
      const hit = snapToRoad(x, z, roads);
      if (hit) {
        // Align local X (stripe spacing) with the road; each bar is long in Z, across the carriageway.
        const yaw = Math.atan2(hit.tx, hit.tz);
        crossings.push({
          x: hit.x,
          z: hit.z,
          y: sample(hit.x, hit.z),
          rot: yaw,
          scaleZ: Math.max(3.2, Math.min(12, hit.width * 0.92)) / 3.4,
        });
      } else {
        missedCrossings += 1;
        crossings.push({ ...point, rot: 0, scaleZ: 1 });
      }
    }
  }
  const square = projector.toLocal(14.040439, 50.660244);
  if (!lamps.some((lamp) => Math.hypot(lamp.x - square[0], lamp.z - square[1]) < 28)) {
    for (const [dx, dz] of [[-12, -8], [10, -9], [12, 8], [-9, 11], [0, -14], [16, 2]]) {
      lamps.push({ x: square[0] + dx, z: square[1] + dz, y: sample(square[0] + dx, square[1] + dz), rot: 0, name: '' });
    }
  }
  const root = new THREE.Group();
  root.name = 'furniture';
  const lampMat = new THREE.MeshLambertMaterial({ color: 0xf4e2a8, emissive: 0xffc56a, emissiveIntensity: 0.35 });
  const benchGeo = new THREE.BoxGeometry(1.8, 0.1, 0.48);
  benchGeo.translate(0, 0.5, 0);
  const backGeo = new THREE.BoxGeometry(1.8, 0.42, 0.08);
  backGeo.translate(0, 0.86, -0.2);
  const stopGeo = new THREE.BoxGeometry(0.16, 3.1, 1.15);
  stopGeo.translate(0, 1.7, 0);
  const stopCap = new THREE.BoxGeometry(1.15, 0.08, 0.7);
  stopCap.translate(0, 3.2, 0.2);
  const meshes = [
    instanced(mergeGeometries([benchGeo, backGeo]), new THREE.MeshLambertMaterial({ color: 0x6d4c34 }), benches, (dummy, point) => {
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, point.rot, 0);
      dummy.scale.set(1, 1, 1);
    }),
    instanced(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 6).translate(0, 2.1, 0), new THREE.MeshLambertMaterial({ color: 0x3c4450 }), lamps, (dummy, point) => {
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    }),
    instanced(new THREE.SphereGeometry(0.22, 8, 6).translate(0, 4.25, 0), lampMat, lamps, (dummy, point) => {
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    }),
    instanced(mergeGeometries([stopGeo, stopCap]), new THREE.MeshLambertMaterial({ color: 0xe2b23a, emissive: 0x6a4a10, emissiveIntensity: 0.25 }), stops, (dummy, point) => {
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, point.rot, 0);
      dummy.scale.set(1, 1, 1);
    }),
    instanced(new THREE.CylinderGeometry(0.22, 0.18, 0.7, 7).translate(0, 0.35, 0), new THREE.MeshLambertMaterial({ color: 0x3e4650 }), bins, (dummy, point) => {
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    }),
    instanced(stripeGeometry(), new THREE.MeshBasicMaterial({ color: 0xf7f4ee }), crossings, (dummy, point) => {
      dummy.position.set(point.x, point.y + 0.34, point.z);
      dummy.rotation.set(0, point.rot, 0);
      dummy.scale.set(1, 1, point.scaleZ || 1);
    }),
  ].filter(Boolean);
  for (const mesh of meshes) {
    mesh.userData.noShadow = true;
    root.add(mesh);
  }
  if (meshes.length) group.add(root);
  return {
    lampMat,
    lamps,
    stops,
    counts: {
      bench: benches.length,
      lamp: lamps.length,
      stop: stops.length,
      bin: bins.length,
      crossing: crossings.length,
      crossingMissed: missedCrossings,
    },
    crossings,
    setDensity(factor) {
      for (const mesh of meshes) mesh.count = Math.max(0, Math.floor(mesh.userData.fullCount * factor));
    },
  };
}

export function boxBlocker(x, z, hx, hz, y = 0) {
  const outer = [
    [x - hx, z - hz],
    [x + hx, z - hz],
    [x + hx, z + hz],
    [x - hx, z + hz],
    [x - hx, z - hz],
  ];
  return {
    outer,
    holes: [],
    minX: x - hx,
    maxX: x + hx,
    minZ: z - hz,
    maxZ: z + hz,
    top: y,
    blocksWalk: true,
    blocksCamera: true,
    kind: 'landmark',
  };
}

function jednoUstiTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384;
  const g = canvas.getContext('2d');
  g.fillStyle = '#1d4a86';
  g.fillRect(0, 0, 512, 384);
  g.fillStyle = '#f3f6fa';
  g.fillRect(18, 18, 476, 348);
  g.fillStyle = '#1d4a86';
  g.fillRect(32, 32, 448, 320);
  g.strokeStyle = '#f3f6fa';
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.arc(168, 108, 26, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(168, 138);
  g.lineTo(168, 214);
  g.moveTo(168, 158);
  g.lineTo(118, 198);
  g.moveTo(168, 158);
  g.lineTo(214, 186);
  g.moveTo(168, 214);
  g.lineTo(128, 278);
  g.moveTo(168, 214);
  g.lineTo(208, 278);
  g.stroke();
  g.fillStyle = '#f3f6fa';
  g.font = '700 54px sans-serif';
  g.textAlign = 'left';
  g.fillText('JednoÚstí', 250, 200);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

function makeLogoWalker() {
  const skin = new THREE.MeshLambertMaterial({ color: 0xc4a07a });
  const hair = new THREE.MeshLambertMaterial({ color: 0x2a2420 });
  const shirt = new THREE.MeshLambertMaterial({ color: 0xf4f4f2 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2c3340 });
  const shoes = new THREE.MeshLambertMaterial({ color: 0x1a1816 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x2a74e0, emissive: 0x1a4aad, emissiveIntensity: 0.45 });
  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const group = new THREE.Group();
  const torso = box(0.36, 0.46, 0.18, shirt);
  torso.position.y = 1.14;
  const head = box(0.2, 0.22, 0.2, skin);
  head.position.y = 1.52;
  const cap = box(0.21, 0.08, 0.21, hair);
  cap.position.y = 1.64;
  const brow = box(0.18, 0.035, 0.06, glass);
  brow.position.set(0, 1.7, -0.1);
  const lensL = box(0.07, 0.04, 0.05, glass);
  lensL.position.set(-0.05, 1.705, -0.12);
  const lensR = box(0.07, 0.04, 0.05, glass);
  lensR.position.set(0.05, 1.705, -0.12);
  group.add(torso, head, cap, brow, lensL, lensR);
  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.09, 0.9, 0);
    const thigh = box(0.12, 0.4, 0.12, pants);
    thigh.position.y = -0.2;
    const shin = box(0.11, 0.4, 0.11, pants);
    shin.position.y = -0.6;
    const foot = box(0.12, 0.06, 0.2, shoes);
    foot.position.set(0, -0.83, -0.05);
    hip.add(thigh, shin, foot);
    hip.rotation.x = side * 0.18;
    return hip;
  }
  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24, 1.32, 0);
    const upperArm = box(0.09, 0.28, 0.09, shirt);
    upperArm.position.y = -0.14;
    const forearm = box(0.08, 0.26, 0.08, skin);
    forearm.position.y = -0.4;
    shoulder.add(upperArm, forearm);
    shoulder.rotation.x = -side * 0.35;
    shoulder.rotation.z = side * 0.12;
    return shoulder;
  }
  group.add(leg(-1), leg(1), arm(-1), arm(1));
  return group;
}

export function addJednoUstiMark(group, projector, sample, buildings) {
  const hint = projector.toLocal(14.03711, 50.660869);
  let ring = null;
  for (const feature of buildings?.features || []) {
    const tags = feature.properties || {};
    if (String(tags.osmId) !== '95518293') continue;
    const geom = feature.geometry;
    if (geom?.type === 'Polygon') ring = geom.coordinates[0].map(([lon, lat]) => projector.toLocal(lon, lat));
    else if (geom?.type === 'MultiPolygon') ring = geom.coordinates[0][0].map(([lon, lat]) => projector.toLocal(lon, lat));
    break;
  }
  if (!ring || ring.length < 3) return null;
  if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.4) ring = ring.slice(0, -1);
  let edge = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((hint[0] - a[0]) * dx + (hint[1] - a[1]) * dz) / (len * len)));
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.hypot(hint[0] - px, hint[1] - pz);
    if (!edge || d < edge.d) edge = { a, b, dx, dz, len, d, px, pz };
  }
  const tx = edge.dx / edge.len;
  const tz = edge.dz / edge.len;
  let nx = tz;
  let nz = -tx;
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mx = (edge.a[0] + edge.b[0]) / 2;
  const mz = (edge.a[1] + edge.b[1]) / 2;
  if ((mx - cx) * nx + (mz - cz) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const along = 5.4;
  const sx = mx + tx * along + nx * 0.16;
  const sz = mz + tz * along + nz * 0.16;
  const y = sample(sx, sz);
  const yaw = Math.atan2(nx, nz);
  const root = new THREE.Group();
  root.name = 'jednousti';
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(1.72, 1.18),
    new THREE.MeshLambertMaterial({
      map: typeof document === 'undefined' ? null : jednoUstiTexture(),
      color: 0xffffff,
      side: THREE.DoubleSide,
    }),
  );
  board.position.set(sx, y + 2.35, sz);
  board.rotation.y = yaw + Math.PI;
  const walker = makeLogoWalker();
  walker.position.set(mx + tx * along + nx * 1.85, y, mz + tz * along + nz * 1.85);
  walker.rotation.y = yaw;
  board.userData.noShadow = true;
  walker.userData.noShadow = true;
  root.add(board, walker);
  group.add(root);
  root.userData.shot = { x: mx + tx * along + nx * 5.6, z: mz + tz * along + nz * 5.6, lookX: sx, lookZ: sz, y };
  return root;
}

export function addVetruseMark(group, projector, sample) {
  const [x, z] = projector.toLocal(14.039608, 50.655013);
  if (!inside(projector, x, z)) return false;
  const y = sample(x, z);
  const wall = new THREE.MeshLambertMaterial({ color: 0xd9c3a2 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x7a3e32 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(11, 5.4, 7.5), wall);
  body.position.set(x, y + 2.7, z);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(12, 0.8, 8.4), roofMat);
  roof.position.set(x, y + 5.8, z);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.4, 0.28, 12), new THREE.MeshLambertMaterial({ color: 0xe7d7bf }));
  deck.position.set(x, y + 6.4, z);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(6.05, 0.1, 6, 16), new THREE.MeshLambertMaterial({ color: 0x8d5a3a }));
  rail.rotation.x = Math.PI / 2;
  rail.position.set(x, y + 7.05, z);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 4.2, 6), new THREE.MeshLambertMaterial({ color: 0x6e5438 }));
  mast.position.set(x, y + 8.4, z);
  for (const mesh of [body, roof, deck, rail, mast]) mesh.userData.noShadow = true;
  group.add(body, roof, deck, rail, mast);
  return boxBlocker(x, z, 6.4, 4.6, y + 6);
}

function busGeometry() {
  const body = new THREE.BoxGeometry(2.3, 1.15, 5.2);
  body.translate(0, 1.15, 0);
  return body;
}

export function addTrolleys(group, routes, projector, sample) {
  const lines = [];
  for (const feature of routes?.features || []) {
    if (feature.geometry?.type !== 'LineString') continue;
    const pts = [];
    for (const [lon, lat] of feature.geometry.coordinates) {
      const [x, z] = projector.toLocal(lon, lat);
      if (!inside(projector, x, z)) continue;
      if (!pts.length || Math.hypot(x - pts[pts.length - 1].x, z - pts[pts.length - 1].z) > 3) pts.push({ x, z });
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (len > 120 && pts.length > 8) lines.push({ pts, len });
  }
  lines.sort((a, b) => b.len - a.len);
  const chosen = lines.slice(0, 3);
  if (!chosen.length) return null;
  const path = [];
  for (const line of chosen) {
    for (let i = 1; i < line.pts.length; i++) {
      const a = line.pts[i - 1];
      const b = line.pts[i];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.round(seg / 6));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        path.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
  }
  if (path.length < 8) return null;
  const count = 4;
  const body = new THREE.InstancedMesh(busGeometry(), new THREE.MeshLambertMaterial({ color: 0x9a3030 }), count);
  const roof = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.1, 0.28, 4.6).translate(0, 1.8, 0),
    new THREE.MeshLambertMaterial({ color: 0xf3efe4 }),
    count,
  );
  body.userData.noShadow = true;
  roof.userData.noShadow = true;
  const fleet = new THREE.Group();
  fleet.name = 'trolleys';
  fleet.add(body, roof);
  const wireMat = new THREE.LineBasicMaterial({ color: 0xc5ced6 });
  for (const line of chosen) {
    const pts = line.pts.map((point) => new THREE.Vector3(point.x, sample(point.x, point.z) + 5.6, point.z));
    if (pts.length < 2) continue;
    const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat);
    wire.userData.noShadow = true;
    fleet.add(wire);
  }
  group.add(fleet);
  const dummy = new THREE.Object3D();
  let cursor = 0;
  let riding = false;
  let rideAt = 0;
  return {
    path,
    setEnabled(on) {
      fleet.visible = on;
    },
    near(x, z) {
      if (!fleet.visible) return false;
      let best = Infinity;
      for (let i = 0; i < count; i++) {
        const at = (cursor / 6 + (i * path.length) / count) % path.length;
        const index = Math.floor(at);
        const prev = path[index];
        best = Math.min(best, Math.hypot(prev.x - x, prev.z - z));
      }
      return best < 7;
    },
    startRide(x, z) {
      if (!fleet.visible) return false;
      riding = true;
      let best = 0;
      let dist = Infinity;
      path.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      rideAt = best;
      return true;
    },
    riding() {
      return riding;
    },
    stopRide() {
      riding = false;
    },
    stepRide(dt) {
      if (!riding) return null;
      rideAt = (rideAt + dt * 4.2) % path.length;
      const index = Math.floor(rideAt);
      const next = path[(index + 1) % path.length];
      const prev = path[index];
      const t = rideAt - index;
      const x = prev.x + (next.x - prev.x) * t;
      const z = prev.z + (next.z - prev.z) * t;
      return { x, z, yaw: Math.atan2(next.x - prev.x, next.z - prev.z) };
    },
    update(dt) {
      if (!fleet.visible) return;
      cursor = (cursor + dt * 7) % (path.length * 6);
      for (let i = 0; i < count; i++) {
        const at = (cursor / 6 + (i * path.length) / count) % path.length;
        const index = Math.floor(at);
        const next = path[(index + 1) % path.length];
        const prev = path[index];
        const t = at - index;
        const x = prev.x + (next.x - prev.x) * t;
        const z = prev.z + (next.z - prev.z) * t;
        dummy.position.set(x, sample(x, z), z);
        dummy.lookAt(next.x, dummy.position.y, next.z);
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);
        roof.setMatrixAt(i, dummy.matrix);
      }
      body.instanceMatrix.needsUpdate = true;
      roof.instanceMatrix.needsUpdate = true;
    },
  };
}
