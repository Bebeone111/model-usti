import * as THREE from 'three';
import { boxBlocker } from './furniture.js';

function yawOf(outer) {
  let best = 0;
  let len = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > len) {
      len = d;
      best = Math.atan2(b[0] - a[0], b[1] - a[1]);
    }
  }
  return best;
}

function westPoint(outer) {
  let pt = outer[0];
  for (const p of outer) if (p[0] < pt[0]) pt = p;
  return pt;
}

function addBox(group, mat, x, y, z, sx, sy, sz, yaw = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.userData.noShadow = true;
  group.add(mesh);
  return mesh;
}

function church(group, hero, opts) {
  const { x, z, y, outer } = hero;
  const yaw = yawOf(outer);
  const brick = new THREE.MeshLambertMaterial({ color: opts.wall });
  const roof = new THREE.MeshLambertMaterial({ color: opts.roof });
  const stone = new THREE.MeshLambertMaterial({ color: opts.trim });
  const naveW = opts.naveW;
  const naveL = opts.naveL;
  const naveH = opts.naveH;
  addBox(group, brick, x, y + naveH / 2, z, naveW, naveH, naveL, yaw);
  const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(naveW, naveL) * 0.62, opts.roofH, 4), roof);
  roofMesh.rotation.y = yaw + Math.PI / 4;
  roofMesh.position.set(x, y + naveH + opts.roofH / 2, z);
  roofMesh.userData.noShadow = true;
  group.add(roofMesh);
  const apse = new THREE.Mesh(new THREE.CylinderGeometry(naveW * 0.28, naveW * 0.28, naveH * 0.85, 8), brick);
  apse.position.set(x + Math.sin(yaw) * (naveL * 0.48), y + naveH * 0.42, z + Math.cos(yaw) * (naveL * 0.48));
  apse.userData.noShadow = true;
  group.add(apse);
  const [tx, tz] = westPoint(outer);
  const tower = new THREE.Group();
  const shaftH = opts.towerH;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(opts.towerW, shaftH, opts.towerW), brick);
  shaft.position.y = shaftH / 2;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(opts.towerW * 0.72, opts.spire, 4), roof);
  cap.position.y = shaftH + opts.spire / 2;
  cap.rotation.y = Math.PI / 4;
  const band = new THREE.Mesh(new THREE.BoxGeometry(opts.towerW * 1.08, 0.4, opts.towerW * 1.08), stone);
  band.position.y = shaftH * 0.72;
  tower.add(shaft, cap, band);
  tower.position.set(tx, y, opts.lean ? tz + 22 : tz);
  tower.rotation.order = 'XYZ';
  tower.rotation.x = opts.lean || 0;
  tower.userData.noShadow = true;
  group.add(tower);
  if (opts.buttress) {
    for (const side of [-1, 1]) {
      addBox(
        group,
        stone,
        x + Math.cos(yaw) * (naveW * 0.52) * side,
        y + naveH * 0.38,
        z,
        1.1,
        naveH * 0.75,
        2.4,
        yaw,
      );
    }
  }
  return boxBlocker(x, z, naveW * 0.55, naveL * 0.55, y + naveH);
}

function cathedral(group, hero) {
  return church(group, hero, {
    wall: 0xe6d7c4,
    roof: 0x6a4034,
    trim: 0xf2ebe2,
    naveW: 14.5,
    naveL: 28,
    naveH: 11.5,
    roofH: 5.4,
    towerH: 48,
    towerW: 7.2,
    spire: 14,
    lean: -0.22,
    buttress: true,
  });
}

function pavel(group, hero) {
  return church(group, hero, {
    wall: 0x8a342c,
    roof: 0x3c2824,
    trim: 0xd8c4a8,
    naveW: 11,
    naveL: 22,
    naveH: 10.2,
    roofH: 5.8,
    towerH: 22,
    towerW: 5.2,
    spire: 8.4,
    lean: 0,
    buttress: false,
  });
}

function vojtech(group, hero) {
  return church(group, hero, {
    wall: 0xddd0ba,
    roof: 0x7a4332,
    trim: 0xf4eee4,
    naveW: 12.2,
    naveL: 24,
    naveH: 10.8,
    roofH: 5.2,
    towerH: 20,
    towerW: 4.8,
    spire: 7.2,
    lean: 0,
    buttress: true,
  });
}

function vetruse(group, hero) {
  const x = hero.x;
  const z = hero.z + 10;
  const y = hero.y;
  const cream = new THREE.MeshLambertMaterial({ color: 0xf2e6d2 });
  const roof = new THREE.MeshLambertMaterial({ color: 0x8a3228 });
  const wood = new THREE.MeshLambertMaterial({ color: 0x6e5438 });
  const glass = new THREE.MeshLambertMaterial({
    color: 0x6a90a8,
    emissive: 0x243848,
    emissiveIntensity: 0.12,
    transparent: true,
    opacity: 0.7,
  });
  const trim = new THREE.MeshLambertMaterial({ color: 0xe8dcc8 });
  addBox(group, cream, x, y + 4.6, z, 22, 9.2, 16, 0.12);
  addBox(group, roof, x, y + 9.6, z, 23.6, 1.4, 17.4, 0.12);
  const wing = addBox(group, cream, x - 9.2, y + 3.4, z + 2.2, 10, 6.8, 11, 0.12);
  wing.rotation.y = 0.16;
  addBox(group, roof, x - 9.2, y + 7.2, z + 2.2, 10.8, 0.9, 11.8, 0.12);
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 12.4, 12), cream);
  turret.position.set(x + 8.4, y + 6.6, z + 1.2);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(4.1, 5.6, 12), roof);
  cap.position.set(x + 8.4, y + 15.4, z + 1.2);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(18, 0.28, 10.5), wood);
  deck.position.set(x - 1.0, y + 9.35, z + 12.2);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(18, 1.15, 0.16), trim);
  rail.position.set(x - 1.0, y + 9.95, z + 17.3);
  const window = new THREE.Mesh(new THREE.BoxGeometry(16.4, 3.4, 0.16), glass);
  window.position.set(x - 0.6, y + 5.6, z + 8.1);
  const northGlass = new THREE.Mesh(new THREE.BoxGeometry(15.8, 3.2, 0.18), glass);
  northGlass.position.set(x - 0.4, y + 5.5, z + 8.08);
  const posts = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6), wood);
  for (const mesh of [turret, cap, deck, rail, window, northGlass]) {
    mesh.userData.noShadow = true;
    group.add(mesh);
  }
  for (const dx of [-6, -2, 2, 6]) {
    const post = posts.clone();
    post.position.set(x - 1.0 + dx, y + 10.6, z + 17.2);
    post.userData.noShadow = true;
    group.add(post);
  }
  return boxBlocker(x, z, 13, 12, y + 10);
}

function forum(group, hero) {
  const { x, z, y, top } = hero;
  const glass = new THREE.MeshLambertMaterial({
    color: 0x6f8ea4,
    emissive: 0x1a3040,
    emissiveIntensity: 0.18,
    transparent: true,
    opacity: 0.82,
  });
  const frame = new THREE.MeshLambertMaterial({ color: 0xd8dde2 });
  const h = Math.max(14, top);
  addBox(group, glass, x, y + h / 2, z, 38, h, 22, 0.04);
  addBox(group, frame, x, y + h + 0.4, z, 39, 0.8, 23, 0.04);
  addBox(group, frame, x, y + 0.4, z + 11.4, 8.4, 0.8, 4.2, 0);
  return boxBlocker(x, z, 20, 12, y + h);
}

function nadrazi(group, hero) {
  const { x, z, y } = hero;
  const wall = new THREE.MeshLambertMaterial({ color: 0xe8d9c4 });
  const roof = new THREE.MeshLambertMaterial({ color: 0x5a4036 });
  const canopy = new THREE.MeshLambertMaterial({ color: 0xc9b79a });
  addBox(group, wall, x, y + 5.4, z, 42, 10.8, 16, 0.08);
  addBox(group, roof, x, y + 11.2, z, 44, 1.1, 18, 0.08);
  addBox(group, canopy, x, y + 5.2, z + 10.4, 36, 0.35, 7.2, 0.08);
  const clock = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.2, 16), new THREE.MeshLambertMaterial({ color: 0xf4efe6 }));
  clock.rotation.x = Math.PI / 2;
  clock.position.set(x, y + 9.4, z + 8.2);
  clock.userData.noShadow = true;
  group.add(clock);
  return boxBlocker(x, z, 22, 10, y + 11);
}

function divadlo(group, hero) {
  const { x, z, y, top } = hero;
  const wall = new THREE.MeshLambertMaterial({ color: 0xd8c4a4 });
  const roof = new THREE.MeshLambertMaterial({ color: 0x5c4036 });
  const h = Math.max(9, top);
  addBox(group, wall, x, y + h / 2, z, 22, h, 14, 0.3);
  addBox(group, roof, x, y + h + 0.5, z, 23.4, 1, 15.2, 0.3);
  addBox(group, new THREE.MeshLambertMaterial({ color: 0x2a2420 }), x, y + 3.2, z + 7.4, 8, 6.2, 0.4, 0.3);
  return boxBlocker(x, z, 12, 8, y + h);
}

const BUILDERS = { cathedral, pavel, vojtech, vetruse, forum, nadrazi, divadlo };

export function addHeroBuildings(group, heroes, detail = true) {
  const blockers = [];
  const root = new THREE.Group();
  root.name = 'heroes';
  for (const hero of heroes || []) {
    const build = BUILDERS[hero.key];
    if (!build) continue;
    if (!detail) {
      const sil = new THREE.Mesh(
        new THREE.BoxGeometry(12, Math.max(8, hero.top), 10),
        new THREE.MeshLambertMaterial({ color: 0xc8b49a }),
      );
      sil.position.set(hero.x, hero.y + Math.max(8, hero.top) / 2, hero.z);
      sil.userData.noShadow = true;
      root.add(sil);
      blockers.push(boxBlocker(hero.x, hero.z, 8, 6, hero.y + hero.top));
      continue;
    }
    const hit = build(root, hero);
    if (hit) blockers.push(hit);
  }
  group.add(root);
  return blockers;
}
