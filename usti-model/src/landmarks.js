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

function northWestPoint(outer) {
  let pt = outer[0];
  let best = Infinity;
  for (const p of outer) {
    const score = p[0] - p[1];
    if (score < best) {
      best = score;
      pt = p;
    }
  }
  return pt;
}

function addGableRoof(group, mat, x, y, z, w, h, d, yaw = 0) {
  const hw = w / 2;
  const hd = d / 2;
  const pos = [
    -hw, 0, -hd, hw, 0, -hd, 0, h, -hd,
    -hw, 0, hd, 0, h, hd, hw, 0, hd,
    -hw, 0, -hd, -hw, 0, hd, 0, h, hd, -hw, 0, -hd, 0, h, hd, 0, h, -hd,
    hw, 0, -hd, 0, h, -hd, 0, h, hd, hw, 0, -hd, 0, h, hd, hw, 0, hd,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
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
  const [tx, tz] = opts.lean ? northWestPoint(outer) : westPoint(outer);
  const tower = new THREE.Group();
  const shaftH = opts.towerH;
  const w = opts.towerW;
  const plaster = new THREE.MeshLambertMaterial({ color: opts.wall });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(w, shaftH, w), plaster);
  shaft.position.y = shaftH / 2;
  tower.add(shaft);
  for (const t of [0.28, 0.52, 0.72]) {
    const course = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, 0.38, w * 1.08), stone);
    course.position.y = shaftH * t;
    tower.add(course);
  }
  if (opts.gallery) {
    const gh = 5.6;
    const gallery = new THREE.Mesh(new THREE.BoxGeometry(w * 1.22, gh, w * 1.22), plaster);
    gallery.position.y = shaftH + gh / 2;
    tower.add(gallery);
    const voidMat = new THREE.MeshLambertMaterial({ color: 0x1a1614 });
    for (const side of [0, 1, 2, 3]) {
      const hole = new THREE.Mesh(new THREE.BoxGeometry(w * 0.28, 3.4, 0.2), voidMat);
      const ang = (side * Math.PI) / 2;
      hole.position.set(Math.sin(ang) * w * 0.62, shaftH + gh * 0.52, Math.cos(ang) * w * 0.62);
      hole.rotation.y = ang;
      tower.add(hole);
    }
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(w * 1.34, 0.42, w * 1.34), stone);
    cornice.position.y = shaftH + gh + 0.1;
    tower.add(cornice);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.78, opts.spire, 4), roof);
    cap.position.y = shaftH + gh + opts.spire / 2;
    cap.rotation.y = Math.PI / 4;
    tower.add(cap);
  } else {
    const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.72, opts.spire, 4), roof);
    cap.position.y = shaftH + opts.spire / 2;
    cap.rotation.y = Math.PI / 4;
    tower.add(cap);
  }
  tower.position.set(tx, y, tz);
  tower.rotation.order = 'XYZ';
  tower.rotation.x = opts.lean || 0;
  tower.rotation.z = opts.lean ? Math.abs(opts.lean) : 0;
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
    naveH: 10.2,
    roofH: 5.4,
    towerH: 36,
    towerW: 7.6,
    spire: 13,
    lean: -0.087,
    gallery: true,
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
  const z = hero.z + 4;
  const y = hero.y;
  const yaw = 0.12;
  const plaster = new THREE.MeshLambertMaterial({ color: 0xf3ead8 });
  const roof = new THREE.MeshLambertMaterial({ color: 0x8a3a2c });
  const wood = new THREE.MeshLambertMaterial({ color: 0x6a5138 });
  const trim = new THREE.MeshLambertMaterial({ color: 0xefe6d6 });
  const glass = new THREE.MeshLambertMaterial({
    color: 0x6d8aa0,
    emissive: 0x3a2410,
    emissiveIntensity: 0.18,
    transparent: true,
    opacity: 0.78,
  });
  addBox(group, plaster, x, y + 5.6, z, 28, 11.2, 16, yaw);
  addGableRoof(group, roof, x, y + 11.2, z, 29.6, 6.8, 17.2, yaw);
  const risX = x + Math.cos(yaw) * 10.2;
  const risZ = z + Math.sin(yaw) * 10.2;
  addBox(group, plaster, risX, y + 8.4, risZ, 7.2, 16.8, 7.2, yaw);
  addGableRoof(group, roof, risX, y + 16.8, risZ, 8.2, 5.4, 8.2, yaw + Math.PI / 2);
  const pane = new THREE.MeshLambertMaterial({ color: 0x5c6570, emissive: 0x3a2410, emissiveIntensity: 0.12 });
  for (const side of [-1, 1]) {
    for (let col = -4; col <= 4; col++) {
      for (const row of [3.2, 6.4, 9.4]) {
        addBox(
          group,
          pane,
          x + Math.cos(yaw) * col * 2.6 + Math.sin(yaw) * 8.05 * side,
          y + row,
          z + Math.sin(yaw) * col * 2.6 + Math.cos(yaw) * 8.05 * side,
          1.5,
          1.7,
          0.12,
          yaw,
        );
      }
    }
  }
  const tx = x + 9.4;
  const tz = z + 1.4;
  addBox(group, wood, tx, y + 4.55, tz, 12.2, 0.22, 8.8, yaw);
  addBox(group, trim, tx + 4.1, y + 5.15, tz, 12.2, 1.1, 0.14, yaw);
  for (const side of [-3.8, 0, 3.8]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 6), wood);
    post.position.set(tx + Math.sin(yaw) * side + 4.0, y + 5.2, tz + Math.cos(yaw) * side);
    post.userData.noShadow = true;
    group.add(post);
  }
  addBox(group, glass, x + Math.sin(yaw) * 6.4, y + 5.0, z + Math.cos(yaw) * 6.4, 13.2, 2.8, 0.14, yaw);
  addBox(group, glass, x - Math.sin(yaw) * 6.4, y + 5.0, z - Math.cos(yaw) * 6.4, 11.4, 2.5, 0.14, yaw);
  return boxBlocker(x, z, 15, 12, y + 14);
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
