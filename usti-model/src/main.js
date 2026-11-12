import './style.css';
import * as THREE from 'three';
import area from '../area.config.json';
import { makeProjector } from './geom.js';
import { makeTerrain } from './terrain.js';
import { buildCity, cameraDistance, walkBlocked } from './city.js';

const canvas = document.querySelector('#view');
const titleEl = document.querySelector('#title');
const statusEl = document.querySelector('#status');
const hintEl = document.querySelector('#hint');
titleEl.textContent = area.title || 'Model Ústí — centrum';
document.title = titleEl.textContent;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x8ec4ee, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc5dff2, 980, 4400);
scene.add(new THREE.HemisphereLight(0xfff3dc, 0x7c9a62, 1.28));
// ENU stays +X east, +Z north. A camera looking toward +Z otherwise draws
// east on the left of the picture, so the whole city reads as a mirror.
// This group reflects X once; Three.js then keeps front faces correct.
const view = new THREE.Group();
view.name = 'view';
view.scale.x = -1;
scene.add(view);
const sun = new THREE.DirectionalLight(0xfff0cc, 1.55);
sun.position.set(460, 780, 240);
view.add(sun);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(5200, 28, 18),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3d9adf) },
      horizon: { value: new THREE.Color(0xf3d3a8) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 top;
      uniform vec3 horizon;
      void main() {
        float h = normalize(vPos).y;
        float t = smoothstep(-0.02, 0.55, h);
        gl_FragColor = vec4(mix(horizon, top, t), 1.0);
      }
    `,
  }),
);
sky.scale.x = -1;
view.add(sky);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.18, 9000);
const projector = makeProjector(area.bbox);

const player = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: -0.4,
  radius: 0.4,
};
const keys = new Set();
let camBack = 8.2;
let pointerLocked = false;

const person = makePerson();
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(0.38, 14),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
);
blob.rotation.x = -Math.PI / 2;
person.scale.x = -1;
view.add(person, blob);

const clock = new THREE.Clock();
let collision = null;
let terrain = { sample: () => 0, elevMin: 0, elevMax: 0, width: 2, height: 2 };
let labels = [];
let bob = 0;
let gait = 0;
let ready = false;

const api = {
  ready: false,
  getState() {
    const [lon, lat] = projector.toLonLat(player.x, player.z);
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      lon,
      lat,
      camBack,
      pointerLocked,
    };
  },
  setState(next) {
    if (Number.isFinite(next.x)) player.x = next.x;
    if (Number.isFinite(next.z)) player.z = next.z;
    if (Number.isFinite(next.yaw)) player.yaw = next.yaw;
    if (Number.isFinite(next.pitch)) player.pitch = next.pitch;
    if (Number.isFinite(next.camBack)) camBack = next.camBack;
    player.y = terrain.sample(player.x, player.z);
  },
  blocked(x, z, radius = player.radius) {
    return collision ? walkBlocked(collision, x, z, radius) : false;
  },
  sample(x, z) {
    return terrain.sample(x, z);
  },
  pose() {
    return { phase: bob, gait, moving: gait > 0.45 };
  },
};
window.__usti = api;

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);

window.addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (ready) setStatus(pointerLocked);
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw += event.movementX * 0.0022;
  player.pitch -= event.movementY * 0.0018;
  player.pitch = Math.max(-1.05, Math.min(0.85, player.pitch));
});

function setStatus(locked) {
  const place = api.start?.label || 'centrum';
  statusEl.textContent = locked ? place : `${place}. Klikněte do obrazu pro rozhlížení myší.`;
}

function tryMove(dx, dz) {
  if (!collision) return;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.32));
  for (let i = 0; i < steps; i++) {
    const sx = dx / steps;
    const sz = dz / steps;
    const nx = player.x + sx;
    const nz = player.z + sz;
    if (!walkBlocked(collision, nx, nz, player.radius)) {
      player.x = nx;
      player.z = nz;
      continue;
    }
    if (!walkBlocked(collision, nx, player.z, player.radius)) player.x = nx;
    else if (!walkBlocked(collision, player.x, nz, player.radius)) player.z = nz;
  }
  player.y = terrain.sample(player.x, player.z);
}

const solePoint = new THREE.Vector3();

function limbBox(width, height, depth, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
}

function makePerson() {
  const skin = new THREE.MeshLambertMaterial({ color: 0xd2a679 });
  const hair = new THREE.MeshLambertMaterial({ color: 0x3a2c24 });
  const shirt = new THREE.MeshLambertMaterial({ color: 0x3c6eae });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2a3644 });
  const shoes = new THREE.MeshLambertMaterial({ color: 0x241c18 });
  const group = new THREE.Group();
  group.name = 'person';

  const torso = limbBox(0.36, 0.46, 0.18, shirt);
  torso.position.y = 1.14;
  const head = limbBox(0.2, 0.22, 0.2, skin);
  head.position.y = 1.52;
  const cap = limbBox(0.21, 0.08, 0.21, hair);
  cap.position.y = 1.64;
  group.add(torso, head, cap);

  const hipY = 0.9;
  const upper = 0.4;
  const lower = 0.4;

  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.09, hipY, 0);
    const thigh = limbBox(0.12, upper, 0.12, pants);
    thigh.position.y = -upper / 2;
    const knee = new THREE.Group();
    knee.position.y = -upper;
    const shin = limbBox(0.11, lower, 0.11, pants);
    shin.position.y = -lower / 2;
    const foot = limbBox(0.12, 0.06, 0.2, shoes);
    foot.position.set(0, -lower - 0.01, -0.05);
    knee.add(shin, foot);
    hip.add(thigh, knee);
    return { hip, knee, foot };
  }

  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24, 1.32, 0);
    const upperArm = limbBox(0.09, 0.28, 0.09, shirt);
    upperArm.position.y = -0.14;
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    const forearm = limbBox(0.08, 0.26, 0.08, skin);
    forearm.position.y = -0.13;
    elbow.add(forearm);
    shoulder.add(upperArm, elbow);
    return { shoulder, elbow };
  }

  const left = leg(-1);
  const right = leg(1);
  const leftArm = arm(-1);
  const rightArm = arm(1);
  group.add(left.hip, right.hip, leftArm.shoulder, rightArm.shoulder);
  group.userData.rig = {
    leftLeg: left.hip,
    rightLeg: right.hip,
    leftKnee: left.knee,
    rightKnee: right.knee,
    leftFoot: left.foot,
    rightFoot: right.foot,
    leftArm: leftArm.shoulder,
    rightArm: rightArm.shoulder,
    leftElbow: leftArm.elbow,
    rightElbow: rightArm.elbow,
  };
  return group;
}

function posePerson(swing) {
  const rig = person.userData.rig;
  rig.leftLeg.rotation.x = swing * 0.7;
  rig.rightLeg.rotation.x = -swing * 0.7;
  rig.leftKnee.rotation.x = Math.max(0, swing) * 1.15;
  rig.rightKnee.rotation.x = Math.max(0, -swing) * 1.15;
  rig.leftArm.rotation.x = -swing * 0.62;
  rig.rightArm.rotation.x = swing * 0.62;
  rig.leftElbow.rotation.x = 0.18 + Math.max(0, -swing) * 0.4;
  rig.rightElbow.rotation.x = 0.18 + Math.max(0, swing) * 0.4;
}

function lowestSole() {
  const rig = person.userData.rig;
  rig.leftFoot.getWorldPosition(solePoint);
  let low = solePoint.y - 0.03;
  rig.rightFoot.getWorldPosition(solePoint);
  low = Math.min(low, solePoint.y - 0.03);
  return low;
}

function updatePlayer(dt) {
  let turn = 0;
  if (keys.has('ArrowLeft')) turn -= 1.6 * dt;
  if (keys.has('ArrowRight')) turn += 1.6 * dt;
  player.yaw += turn;
  if (keys.has('ArrowUp')) player.pitch = Math.min(0.85, player.pitch + dt);
  if (keys.has('ArrowDown')) player.pitch = Math.max(-1.05, player.pitch - dt);

  const forwardX = -Math.sin(player.yaw);
  const forwardZ = -Math.cos(player.yaw);
  const rightX = -Math.cos(player.yaw);
  const rightZ = Math.sin(player.yaw);
  let mx = 0;
  let mz = 0;
  if (keys.has('KeyW')) {
    mx += forwardX;
    mz += forwardZ;
  }
  if (keys.has('KeyS')) {
    mx -= forwardX;
    mz -= forwardZ;
  }
  if (keys.has('KeyD')) {
    mx += rightX;
    mz += rightZ;
  }
  if (keys.has('KeyA')) {
    mx -= rightX;
    mz -= rightZ;
  }
  const moving = mx !== 0 || mz !== 0;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (moving) {
    const len = Math.hypot(mx, mz) || 1;
    const speed = fast ? 280 : 3.6;
    tryMove((mx / len) * speed * dt, (mz / len) * speed * dt);
    bob += dt * (fast ? 12 : 7.2);
    gait = Math.min(1, gait + dt * 8);
  } else {
    gait = Math.max(0, gait - dt * 6);
  }
  posePerson(Math.sin(bob) * gait);
  person.rotation.y = player.yaw;
  person.position.set(player.x, player.y, player.z);
  person.updateMatrixWorld(true);
  const sole = lowestSole();
  person.position.y += player.y - sole;
  blob.position.set(player.x, player.y + 0.08, player.z);
  sky.position.set(player.x, player.y, player.z);
}

function updateCamera() {
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  const sin = Math.sin(player.pitch);
  const cos = Math.max(0.35, Math.cos(player.pitch));
  let camX = player.x - fx * camBack * cos;
  let camZ = player.z - fz * camBack * cos;
  let camY = player.y + 1.7 + camBack * 0.16 - sin * camBack * 0.45;
  if (collision) {
    const allowed = cameraDistance(collision, player.x, player.z, camX, camZ);
    const keep = Math.max(0.6, allowed - 0.35);
    const full = Math.hypot(camX - player.x, camZ - player.z) || 1;
    if (keep < full) {
      const scale = keep / full;
      camX = player.x + (camX - player.x) * scale;
      camZ = player.z + (camZ - player.z) * scale;
      camY = player.y + 1.7 + (camY - player.y - 1.7) * scale;
    }
    person.visible = keep > 1.55;
  }
  let floor = terrain.sample(camX, camZ);
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    floor = Math.max(floor, terrain.sample(player.x + (camX - player.x) * t, player.z + (camZ - player.z) * t));
  }
  camY = Math.max(player.y + 1.7, floor + 2.05, camY);
  camera.position.set(-camX, camY, camZ);
  const lookY = Math.max(player.y + 1.15, terrain.sample(player.x + fx * 9, player.z + fz * 9) + 1.2);
  camera.lookAt(-(player.x + fx * 9), lookY + sin * 2.2, player.z + fz * 9);
}

const labelWorld = new THREE.Vector3();

function updateLabels() {
  view.updateMatrixWorld(true);
  for (const sprite of labels) {
    sprite.getWorldPosition(labelWorld);
    const d = camera.position.distanceTo(labelWorld);
    const h = Math.min(26, Math.max(3.1, d * 0.046));
    sprite.scale.set(-h * sprite.userData.aspect, h, 1);
  }
}

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  if (ready) updatePlayer(dt);
  updateCamera();
  if (ready) updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} (${response.status}). Ve složce aplikace spusťte npm run download.`);
  return response.json();
}

function addGround(texture, grid) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  const { minX, maxX, minZ, maxZ } = projector;
  const cols = grid.width;
  const rows = grid.height;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  let p = 0;
  let u = 0;
  for (let r = 0; r < rows; r++) {
    const zn = 1 - r / (rows - 1);
    const z = minZ + zn * (maxZ - minZ);
    for (let c = 0; c < cols; c++) {
      const xn = c / (cols - 1);
      const x = minX + xn * (maxX - minX);
      positions[p++] = x;
      positions[p++] = grid.sample(x, z);
      positions[p++] = z;
      uvs[u++] = xn;
      uvs[u++] = zn;
    }
  }
  const indices = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i = r * cols + c;
      indices.push(i, i + cols, i + 1, i + 1, i + cols, i + cols + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal.array;
  let up = 0;
  for (let i = 1; i < normals.length; i += 3) up += normals[i];
  if (up < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  }
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff, side: THREE.DoubleSide }),
  );
  mesh.name = 'ground';
  view.add(mesh);
}

const DATA = '/data';

async function boot() {
  const [buildings, highways, landuse, water, meta, terrainJson, texture] = await Promise.all([
    loadJson(`${DATA}/buildings.geojson`),
    loadJson(`${DATA}/highways.geojson`),
    loadJson(`${DATA}/landuse.geojson`),
    loadJson(`${DATA}/water.geojson`),
    loadJson(`${DATA}/meta.json`),
    loadJson(`${DATA}/terrain.json`),
    new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(`${DATA}/ortho.jpg`, resolve, undefined, () => reject(new Error('Ortofoto se nepodařilo načíst.')));
    }),
  ]);
  const sameBox = ['west', 'south', 'east', 'north'].every((key) => Math.abs(area.bbox[key] - meta.bbox[key]) < 1e-8);
  if (!sameBox) {
    hintEl.textContent = 'BBox v area.config.json nesedí s public/data/meta.json. Spusťte npm run download.';
  }
  terrain = makeTerrain(terrainJson, projector);
  addGround(texture, terrain);
  statusEl.textContent = 'Sestavuji budovy…';
  await new Promise((resolve) => setTimeout(resolve, 40));
  const city = buildCity({ buildings, highways, landuse, water, startHint: area.startHint, terrain }, projector);
  view.add(city.group);
  collision = city.collision;
  labels = city.labels;
  player.x = city.start.x;
  player.z = city.start.z;
  player.y = terrain.sample(player.x, player.z);
  player.yaw = city.start.yaw;
  api.start = city.start;
  api.labels = city.labelPoints;
  api.terrain = {
    elevMin: terrain.elevMin,
    elevMax: terrain.elevMax,
    source: terrainJson.source,
    width: terrain.width,
    height: terrain.height,
  };
  api.stats = { ...city.stats, landuse: (landuse.features || []).length, highways: (highways.features || []).length };
  api.ready = true;
  ready = true;
  setStatus(false);
  console.log('USTI_READY', JSON.stringify({ start: city.start, stats: api.stats, bbox: area.bbox }));
}

boot().catch((error) => {
  console.error(error);
  statusEl.textContent = error.message || 'Model se nepodařilo načíst.';
});

requestAnimationFrame(frame);
