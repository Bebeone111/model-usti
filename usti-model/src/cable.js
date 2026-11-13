import * as THREE from 'three';

const FALLBACK = [
  [14.04135, 50.65692],
  [14.03980, 50.65518],
];

function lineFrom(features, projector) {
  let best = null;
  let bestLen = 0;
  for (const feature of features || []) {
    const tags = feature.properties || {};
    if (!tags.aerialway && tags.route !== 'aerialway') continue;
    if (tags.aerialway === 'station') continue;
    const coords = feature.geometry?.type === 'LineString' ? feature.geometry.coordinates : null;
    if (!coords || coords.length < 2) continue;
    const pts = coords.map(([lon, lat]) => {
      const [x, z] = projector.toLocal(lon, lat);
      return { x, z };
    });
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (len > bestLen) {
      best = pts;
      bestLen = len;
    }
  }
  return bestLen > 40 ? best : null;
}

function at(pts, t) {
  const total = pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
  let acc = 0;
  const target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + seg >= target || i === pts.length - 1) {
      const u = seg ? (target - acc) / seg : 0;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * u,
      };
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

export function addCableCar(group, { aerialways, projector, sample, low }) {
  const pts = lineFrom(aerialways?.features, projector) || FALLBACK.map(([lon, lat]) => {
    const [x, z] = projector.toLocal(lon, lat);
    return { x, z };
  });
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (Math.hypot(a.x - b.x, a.z - b.z) < 40) return null;
  const root = new THREE.Group();
  root.name = 'cable';
  const steel = new THREE.LineBasicMaterial({ color: 0xc5ced6 });
  const ropePts = pts.map((p) => new THREE.Vector3(p.x, sample(p.x, p.z) + 18, p.z));
  root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ropePts), steel));
  const house = new THREE.MeshLambertMaterial({ color: 0xd8c6aa });
  const roof = new THREE.MeshLambertMaterial({ color: 0x6a4034 });
  for (const p of [a, b]) {
    const y = sample(p.x, p.z);
    const box = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.4, 4.2), house);
    box.position.set(p.x, y + 1.7, p.z);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.35, 4.6), roof);
    cap.position.set(p.x, y + 3.55, p.z);
    box.userData.noShadow = true;
    cap.userData.noShadow = true;
    root.add(box, cap);
  }
  const cabins = [];
  if (!low) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xc45a3a });
    for (let i = 0; i < 2; i++) {
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.5, 1.3), mat);
      cabin.userData.noShadow = true;
      root.add(cabin);
      cabins.push({ mesh: cabin, phase: i * 0.5 });
    }
  }
  group.add(root);
  let riding = false;
  let rideT = 0;
  let rideDir = 1;
  return {
    lower: a,
    upper: b,
    visible: true,
    update(dt, sampleAt) {
      if (low) return;
      for (const cabin of cabins) {
        cabin.phase = (cabin.phase + dt * 0.035) % 1;
        const t = cabin.phase < 0.5 ? cabin.phase * 2 : 2 - cabin.phase * 2;
        const p = at(pts, t);
        cabin.mesh.position.set(p.x, sampleAt(p.x, p.z) + 16.4, p.z);
      }
    },
    nearStation(x, z) {
      if (Math.hypot(x - a.x, z - a.z) < 8) return 'up';
      if (Math.hypot(x - b.x, z - b.z) < 8) return 'down';
      return null;
    },
    startRide(dir) {
      riding = true;
      rideDir = dir === 'down' ? -1 : 1;
      rideT = dir === 'down' ? 1 : 0;
    },
    riding() {
      return riding;
    },
    stepRide(dt, sampleAt) {
      if (!riding) return null;
      rideT += rideDir * dt * 0.12;
      if (rideT >= 1 || rideT <= 0) {
        riding = false;
        rideT = Math.max(0, Math.min(1, rideT));
        const p = at(pts, rideT);
        return { done: true, x: p.x, z: p.z, y: sampleAt(p.x, p.z), yaw: rideDir > 0 ? 3.2 : 0.2 };
      }
      const p = at(pts, rideT);
      return { done: false, x: p.x, z: p.z, y: sampleAt(p.x, p.z) + 16.2, yaw: null };
    },
  };
}
