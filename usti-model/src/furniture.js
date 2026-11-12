import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    const piece = new THREE.BoxGeometry(0.48, 0.04, 3.4);
    piece.translate((i - 1.5) * 0.95, 0, 0);
    pieces.push(piece);
  }
  return mergeGeometries(pieces, false);
}

export function addStreetFurniture(group, collection, projector, sample) {
  const benches = [];
  const lamps = [];
  const stops = [];
  const bins = [];
  const crossings = [];
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
    else if (tags.highway === 'crossing') crossings.push(point);
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
    instanced(mergeGeometries([stopGeo, stopCap]), new THREE.MeshLambertMaterial({ color: 0x2f5f86 }), stops, (dummy, point) => {
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
      dummy.position.set(point.x, point.y + 0.18, point.z);
      dummy.rotation.set(0, point.rot, 0);
      dummy.scale.set(1.15, 1, 1.15);
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
    counts: { bench: benches.length, lamp: lamps.length, stop: stops.length, bin: bins.length, crossing: crossings.length },
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
  return {
    setEnabled(on) {
      fleet.visible = on;
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
