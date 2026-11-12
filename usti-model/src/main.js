import './style.css';
import * as THREE from 'three';
import area from '../area.config.json';
import { makeProjector } from './geom.js';
import { makeTerrain, terrainFromBin } from './terrain.js';
import { buildCity, cameraDistance, makeNameSprite, walkBlocked } from './city.js';
import { fetchBytes, fileLabel, loadOptionalJson, parseJson } from './load.js';
import { updateLabels } from './labels.js';
import { collectMapGeometry, createOverview } from './overview.js';
import { createPlaces } from './places.js';
import { addBridgeMarks, addStreetFurniture, addTrolleys, addVetruseMark } from './furniture.js';
import { createDaylight, fetchWeather } from './daylight.js';
import { createAmbience } from './ambience.js';

const canvas = document.querySelector('#view');
const titleEl = document.querySelector('#title');
const statusEl = document.querySelector('#status');
const hintEl = document.querySelector('#hint');
const whereEl = document.querySelector('#where');
const clockEl = document.querySelector('#clock');
const actionsEl = document.querySelector('#actions');
titleEl.textContent = area.title || 'Model Ústí — centrum';
document.title = titleEl.textContent;

const coarseQuery = window.matchMedia('(pointer: coarse), (max-width: 900px)');
let coarse = coarseQuery.matches;
coarseQuery.addEventListener('change', () => {
  coarse = coarseQuery.matches;
});

const PRESETS = {
  low: { dpr: 1, shadows: false, labels: 170, trees: 0.45, furniture: 0.55, rain: false },
  medium: { dpr: 1.45, shadows: false, labels: 260, trees: 0.8, furniture: 1, rain: true },
  high: { dpr: 1.75, shadows: true, labels: 360, trees: 1, furniture: 1, rain: true },
};
const weak = (navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4;
let quality = coarseQuery.matches || weak ? 'low' : 'medium';

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality !== 'low',
    powerPreference: quality === 'low' ? 'low-power' : 'high-performance',
    preserveDrawingBuffer: true,
  });
  if (!renderer.getContext()) throw new Error('no-context');
} catch {
  renderer = null;
}

const glFail = document.querySelector('#gl-fail');
if (!renderer) {
  glFail.hidden = false;
  document.querySelector('#enter').disabled = true;
  document.querySelector('#tour-start').disabled = true;
  throw new Error('WebGL není k dispozici.');
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PRESETS[quality].dpr));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x8ec4ee, 1);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc5dff2, 980, 4400);
const hemi = new THREE.HemisphereLight(0xfff3dc, 0x7c9a62, 1.28);
scene.add(hemi);
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
      cloud: { value: 0 },
      night: { value: 0 },
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
      uniform float cloud;
      uniform float night;
      void main() {
        float h = normalize(vPos).y;
        float t = smoothstep(-0.05, 0.45, h);
        vec3 day = mix(horizon, top, t);
        float bands = 0.5 + 0.5 * sin(vPos.x * 0.012 + vPos.z * 0.008);
        day = mix(day, vec3(0.75, 0.78, 0.8), cloud * bands * (1.0 - t));
        vec3 dusk = vec3(0.07, 0.11, 0.2);
        gl_FragColor = vec4(mix(day, dusk, night), 1.0);
      }
    `,
  }),
);
sky.scale.x = -1;
view.add(sky);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.18, 9000);
const projector = makeProjector(area.bbox);
const player = { x: 0, y: 0, z: 0, yaw: 0, pitch: -0.4, radius: 0.4 };
const keys = new Set();
let camBack = 8.2;
let thirdPerson = true;
let pointerLocked = false;
let walkSpeed = 3.6;
let stickX = 0;
let stickY = 0;
let sprintHeld = false;
let playing = false;
let photoMode = false;
let clean = false;
let helpOpen = false;
let menuOpen = false;
let poiOpen = false;
let realClock = true;
let hourShift = 0;
const WALK_MIN = 1;
const WALK_MAX = 16;

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
let groundMat = null;
let waterMat = null;
let lampMat = null;
let furniture = null;
let trolleys = null;
let places = null;
let overview = null;
let daylight = null;
let weather = null;
let goalMark = null;
const ambience = createAmbience();
let hudAt = 0;

const api = {
  ready: false,
  getState() {
    const [lon, lat] = projector.toLonLat(player.x, player.z);
    return { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, lon, lat, camBack, pointerLocked };
  },
  setState(next) {
    const x = Number.isFinite(next.x) ? next.x : player.x;
    const z = Number.isFinite(next.z) ? next.z : player.z;
    placeNear(x, z, next.yaw, next.pitch);
    if (Number.isFinite(next.camBack)) camBack = Math.min(22, Math.max(2.6, next.camBack));
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PRESETS[quality].dpr));
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);

function typing(event) {
  const tag = event.target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function overlayBlocks() {
  return helpOpen || menuOpen || overview?.isOpen();
}

window.addEventListener('keydown', (event) => {
  if (typing(event)) return;
  keys.add(event.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
  if (!playing) return;
  if (event.code === 'Escape' && document.pointerLockElement) return;
  if (event.code === 'Escape') {
    if (photoMode) setPhoto(false);
    else if (poiOpen) closePoi();
    else if (menuOpen) closeMenu();
    else if (helpOpen) closeHelp();
    else if (overview?.isOpen()) overview.setOpen(false);
    return;
  }
  if (helpOpen || menuOpen) return;
  if (event.key === '?' || (event.code === 'Tab' && !overview?.isOpen())) {
    event.preventDefault();
    openHelp();
    return;
  }
  if (event.code === 'KeyM') {
    event.preventDefault();
    overview?.toggle();
    if (overview?.isOpen()) document.exitPointerLock();
  } else if (event.code === 'KeyE') openNearbyPoi();
  else if (event.code === 'KeyG') cycleQuality();
  else if (event.code === 'KeyV') setThirdPerson(!thirdPerson);
  else if (event.code === 'KeyH') setClean(!clean);
  else if (event.code === 'KeyP') setPhoto(!photoMode);
  else if (event.code === 'Space') {
    if (overview?.isOpen()) overview.centerOnPlayer();
    else whereEl.classList.add('flash');
  } else if (event.code === 'Slash') {
    overview?.setOpen(true);
    overview?.focusSearch();
    document.exitPointerLock();
  }
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

let lastPointer = 'mouse';
canvas.addEventListener('click', () => {
  if (!playing || lastPointer === 'touch' || overlayBlocks() || photoMode) return;
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (playing) setStatus(pointerLocked);
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw += event.movementX * 0.0022;
  player.pitch -= event.movementY * 0.0018;
  player.pitch = Math.max(-1.05, Math.min(0.85, player.pitch));
});
canvas.addEventListener('wheel', (event) => {
  if (!playing || overview?.isOpen()) return;
  event.preventDefault();
  camBack = Math.min(22, Math.max(2.6, camBack + Math.sign(event.deltaY) * 0.7));
}, { passive: false });

const stickEl = document.querySelector('#stick');
const knobEl = document.querySelector('#stick-knob');
const speedRange = document.querySelector('#speed-range');
const speedValue = document.querySelector('#speed-value');
const STICK_RADIUS = 46;
let stickPointer = null;
let lookPointer = null;
let lookLastX = 0;
let lookLastY = 0;
const touches = new Map();
let pinchDist = 0;

function formatSpeed(value) {
  return `${value.toFixed(1).replace('.', ',')} m/s`;
}

function setWalkSpeed(value) {
  walkSpeed = Math.min(WALK_MAX, Math.max(WALK_MIN, value));
  speedValue.textContent = formatSpeed(walkSpeed);
  speedRange.value = String(walkSpeed);
}

speedRange.addEventListener('input', () => setWalkSpeed(Number(speedRange.value)));

function placeKnob(clientX, clientY) {
  const rect = stickEl.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const len = Math.hypot(dx, dy) || 1;
  const reach = Math.min(STICK_RADIUS, len);
  const nx = (dx / len) * reach;
  const ny = (dy / len) * reach;
  knobEl.style.transform = `translate(${nx}px, ${ny}px)`;
  stickX = nx / STICK_RADIUS;
  stickY = ny / STICK_RADIUS;
}

function releaseStick() {
  stickPointer = null;
  stickX = 0;
  stickY = 0;
  knobEl.style.transform = 'translate(0px, 0px)';
}

stickEl.addEventListener('pointerdown', (event) => {
  lastPointer = event.pointerType;
  stickPointer = event.pointerId;
  try { stickEl.setPointerCapture(event.pointerId); } catch { /* gone */ }
  placeKnob(event.clientX, event.clientY);
  event.preventDefault();
});
stickEl.addEventListener('pointermove', (event) => {
  if (event.pointerId !== stickPointer) return;
  placeKnob(event.clientX, event.clientY);
});
stickEl.addEventListener('pointerup', (event) => {
  if (event.pointerId !== stickPointer) return;
  releaseStick();
});
stickEl.addEventListener('pointercancel', (event) => {
  if (event.pointerId !== stickPointer) return;
  releaseStick();
});

const sprintBtn = document.querySelector('#sprint');
function holdSprint(event) {
  sprintHeld = true;
  event.preventDefault();
}
function dropSprint() {
  sprintHeld = false;
}
sprintBtn.addEventListener('pointerdown', holdSprint);
sprintBtn.addEventListener('pointerup', dropSprint);
sprintBtn.addEventListener('pointercancel', dropSprint);
sprintBtn.addEventListener('pointerleave', dropSprint);

canvas.addEventListener('pointerdown', (event) => {
  lastPointer = event.pointerType;
  if (event.pointerType === 'mouse' || event.target !== canvas) return;
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touches.size >= 2) {
    const [a, b] = [...touches.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    lookPointer = null;
    return;
  }
  lookPointer = event.pointerId;
  lookLastX = event.clientX;
  lookLastY = event.clientY;
  try { canvas.setPointerCapture(event.pointerId); } catch { /* gone */ }
});
canvas.addEventListener('pointermove', (event) => {
  if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    camBack = Math.min(22, Math.max(2.6, camBack * (pinchDist / dist)));
    pinchDist = dist;
    return;
  }
  if (event.pointerId !== lookPointer) return;
  const dx = event.clientX - lookLastX;
  const dy = event.clientY - lookLastY;
  lookLastX = event.clientX;
  lookLastY = event.clientY;
  player.yaw += dx * 0.0022;
  player.pitch -= dy * 0.0018;
  player.pitch = Math.max(-1.05, Math.min(0.85, player.pitch));
});
function endLook(event) {
  touches.delete(event.pointerId);
  if (event.pointerId !== lookPointer) return;
  lookPointer = null;
}
canvas.addEventListener('pointerup', endLook);
canvas.addEventListener('pointercancel', endLook);
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  playing = false;
  glFail.hidden = false;
  document.body.classList.remove('playing');
});

function setStatus(locked) {
  if (!playing) return;
  statusEl.textContent = coarse || locked ? '' : 'Klikněte do obrazu pro rozhlížení myší.';
}

function placeNear(x, z, yaw, pitch) {
  if (!collision) return false;
  let nx = null;
  let nz = null;
  if (!walkBlocked(collision, x, z, player.radius)) {
    nx = x;
    nz = z;
  } else {
    for (let ring = 1.6; ring <= 36 && nx == null; ring += 1.6) {
      for (let a = 0; a < 18; a++) {
        const px = x + Math.cos((a / 18) * Math.PI * 2) * ring;
        const pz = z + Math.sin((a / 18) * Math.PI * 2) * ring;
        if (!walkBlocked(collision, px, pz, player.radius)) {
          nx = px;
          nz = pz;
          break;
        }
      }
    }
  }
  if (nx == null) return false;
  player.x = nx;
  player.z = nz;
  player.y = terrain.sample(player.x, player.z);
  if (Number.isFinite(yaw)) player.yaw = yaw;
  if (Number.isFinite(pitch)) player.pitch = Math.max(-1.05, Math.min(0.85, pitch));
  return true;
}

function goHome() {
  if (!api.start) return;
  placeNear(api.start.x, api.start.z, api.start.yaw, -0.4);
  overview?.centerOnPlayer();
}

function climbLookout(poi) {
  let best = null;
  for (let dx = -40; dx <= 28; dx += 4) {
    for (let dz = -12; dz <= 36; dz += 4) {
      const x = poi.x + dx;
      const z = poi.z + dz;
      const h = terrain.sample(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
  }
  if (best) placeNear(best.x, best.z, Math.PI, -0.28);
  closePoi();
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

const solePoint = new THREE.Vector3();
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
  let forward = 0;
  let strafe = 0;
  if (keys.has('KeyW')) forward += 1;
  if (keys.has('KeyS')) forward -= 1;
  if (keys.has('KeyD')) strafe += 1;
  if (keys.has('KeyA')) strafe -= 1;
  forward += -stickY;
  strafe += stickX;
  const mag = Math.hypot(forward, strafe);
  const moving = mag > 0.08;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') || sprintHeld;
  if (moving) {
    const scale = mag > 1 ? 1 / mag : 1;
    const mx = forward * scale * forwardX + strafe * scale * rightX;
    const mz = forward * scale * forwardZ + strafe * scale * rightZ;
    const len = Math.hypot(mx, mz) || 1;
    const pace = photoMode ? 0.45 : 1;
    const speed = walkSpeed * (fast ? 4 : 1) * pace * Math.min(1, mag);
    tryMove((mx / len) * speed * dt, (mz / len) * speed * dt);
    bob += dt * (fast ? 9 : 7.2);
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
  blob.visible = thirdPerson;
  sky.position.set(player.x, player.y, player.z);
  ambience.step(moving, fast);
}

function updateCamera() {
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  const sin = Math.sin(player.pitch);
  const cos = Math.max(0.35, Math.cos(player.pitch));
  const back = thirdPerson ? camBack : 0.42;
  let camX = player.x - fx * back * cos;
  let camZ = player.z - fz * back * cos;
  let camY = player.y + 1.7 + back * 0.16 - sin * back * 0.45;
  if (collision) {
    const allowed = cameraDistance(collision, player.x, player.z, camX, camZ);
    const keep = Math.max(0.35, allowed - 0.35);
    const full = Math.hypot(camX - player.x, camZ - player.z) || 1;
    if (keep < full) {
      const scale = keep / full;
      camX = player.x + (camX - player.x) * scale;
      camZ = player.z + (camZ - player.z) * scale;
      camY = player.y + 1.7 + (camY - player.y - 1.7) * scale;
    }
    person.visible = thirdPerson && keep > 1.55;
  } else person.visible = thirdPerson;
  if (!thirdPerson) person.visible = false;
  let floor = terrain.sample(camX, camZ);
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    floor = Math.max(floor, terrain.sample(player.x + (camX - player.x) * t, player.z + (camZ - player.z) * t));
  }
  camY = Math.max(player.y + 1.7, floor + 2.05, camY);
  if (!thirdPerson) camY = player.y + 1.62;
  camera.position.set(-camX, camY, camZ);
  const lookY = Math.max(player.y + 1.15, terrain.sample(player.x + fx * 9, player.z + fz * 9) + 1.2);
  camera.lookAt(-(player.x + fx * 9), lookY + sin * 2.2, player.z + fz * 9);
}

function applyQuality(level) {
  quality = PRESETS[level] ? level : quality;
  const preset = PRESETS[quality];
  renderer.shadowMap.enabled = preset.shadows;
  sun.castShadow = preset.shadows;
  if (preset.shadows) {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.001;
    const shadowCam = sun.shadow.camera;
    shadowCam.left = -70;
    shadowCam.right = 70;
    shadowCam.top = 70;
    shadowCam.bottom = -70;
    shadowCam.near = 4;
    shadowCam.far = 220;
    shadowCam.updateProjectionMatrix();
  }
  view.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = preset.shadows && !obj.isInstancedMesh && !obj.userData.noShadow && obj.name !== 'ground';
    obj.receiveShadow = preset.shadows && !obj.userData.noShadow;
  });
  if (api.trees?.trunks) api.trees.trunks.count = Math.max(0, Math.floor(api.trees.trunks.userData.fullCount * preset.trees));
  if (api.trees?.canopy) api.trees.canopy.count = Math.max(0, Math.floor(api.trees.canopy.userData.fullCount * preset.trees));
  furniture?.setDensity(preset.furniture);
  const select = document.querySelector('#quality');
  if (select) select.value = quality;
  resize();
}

function cycleQuality() {
  const order = ['low', 'medium', 'high'];
  applyQuality(order[(order.indexOf(quality) + 1) % order.length]);
  statusEl.textContent = `Kvalita: ${{ low: 'nízká', medium: 'střední', high: 'vysoká' }[quality]}`;
}

function setThirdPerson(next) {
  thirdPerson = next;
  document.querySelector('#view-btn').textContent = thirdPerson ? 'První osoba' : 'Třetí osoba';
}

function setClean(next) {
  clean = next;
  document.body.classList.toggle('clean', clean);
  document.querySelector('#restore').hidden = !clean;
  document.querySelector('#hud-btn').textContent = clean ? 'Zobrazit HUD a popisky' : 'Skrýt HUD a popisky';
}

function setPhoto(next) {
  photoMode = next;
  document.body.classList.toggle('photo', photoMode);
  document.querySelector('#photo-bar').hidden = !photoMode;
  if (photoMode) {
    document.exitPointerLock();
    closeMenu();
  }
}

function openHelp() {
  helpOpen = true;
  document.querySelector('#help').hidden = false;
  document.exitPointerLock();
}
function closeHelp() {
  helpOpen = false;
  document.querySelector('#help').hidden = true;
  localStorage.setItem('usti-help-seen', '1');
}
function openMenu() {
  menuOpen = true;
  document.querySelector('#menu').hidden = false;
  document.exitPointerLock();
  refreshVisited();
}
function closeMenu() {
  menuOpen = false;
  document.querySelector('#menu').hidden = true;
}

function openPoi(poi, fromTour = false) {
  if (!poi) return;
  poiOpen = true;
  document.querySelector('#poi').hidden = false;
  document.querySelector('#poi-name').textContent = poi.name;
  document.querySelector('#poi-text').textContent = poi.text || '';
  const link = document.querySelector('#poi-link');
  if (poi.osm) {
    link.hidden = false;
    link.href = poi.osm;
  } else link.hidden = true;
  document.querySelector('#poi-lookout').hidden = poi.id !== 'vetruse';
  const touring = Boolean(places?.currentStop());
  document.querySelector('#poi-next').hidden = !(fromTour || touring);
  document.querySelector('#poi-cancel').hidden = !touring;
  places?.mark(poi.id);
  refreshVisited();
  document.exitPointerLock();
}
function closePoi() {
  poiOpen = false;
  document.querySelector('#poi').hidden = true;
}
function openNearbyPoi() {
  const poi = places?.nearPoi(player.x, player.z);
  if (poi) openPoi(poi);
}

function refreshVisited() {
  if (!places) return;
  const text = `Navštíveno ${places.visitedCount()} / ${places.total}`;
  document.querySelector('#menu-visited').textContent = text;
  overview?.setVisited(text);
}

function refreshWalkHud(now) {
  if (!places || now - hudAt < 180) return;
  hudAt = now;
  whereEl.textContent = places.whereText(player.x, player.z);
  const near = places.nearPoi(player.x, player.z);
  actionsEl.textContent = coarse
    ? near
      ? 'Žluté tlačítko otevře místo'
      : 'Páčka chodí · tah po obrazu se rozhlíží'
    : ['Chůze WASD', 'Rychle Shift', 'Mapa M', near ? 'Památka E' : 'Nápověda Tab'].join(' · ');
  const arrived = places.noteArrival(player.x, player.z);
  if (arrived) openPoi(arrived.poi, true);
  const goal = places.currentStop();
  if (goalMark) {
    goalMark.visible = Boolean(goal);
    if (goal) {
      const y = terrain.sample(goal.poi.x, goal.poi.z) + 6 + Math.sin(now / 280) * 0.25;
      goalMark.position.set(goal.poi.x, y, goal.poi.z);
    }
  }
  const [lon, lat] = projector.toLonLat(player.x, player.z);
  const hash = `#${lon.toFixed(5)},${lat.toFixed(5)},${player.yaw.toFixed(2)},${player.pitch.toFixed(2)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  const parts = decodeURIComponent(location.hash.replace(/^#/, '')).split(',').map(Number);
  if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) return null;
  if (Math.abs(parts[0]) > 180 || Math.abs(parts[1]) > 90) return null;
  return parts;
}

function setProgress(ratio, step) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  for (const id of ['load-bar', 'start-bar']) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${pct}%`;
  }
  const pctEl = document.getElementById('load-pct');
  if (pctEl) pctEl.textContent = `${pct} %`;
  for (const id of ['load-step', 'start-step']) {
    const el = document.getElementById(id);
    if (el) el.textContent = step;
  }
  document.getElementById('start-progress').hidden = false;
  statusEl.textContent = step;
}

function addGround(texture, grid) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy() || 1;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
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
  groundMat = new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, groundMat);
  mesh.name = 'ground';
  mesh.userData.noShadow = true;
  view.add(mesh);
}

async function loadTexture(file, onProgress) {
  try {
    const bytes = await fetchBytes(file, onProgress);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const texture = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, resolve, undefined, reject);
    });
    URL.revokeObjectURL(url);
    return texture;
  } catch (error) {
    if (file !== 'ortho.jpg') return loadTexture('ortho.jpg', onProgress);
    throw error;
  }
}

let wantPlay = false;
let wantTour = false;
let built = false;

function beginPlay(tour) {
  wantPlay = true;
  wantTour = tour || wantTour;
  if (!built) {
    document.querySelector('#loading').hidden = false;
    document.body.classList.add('is-loading');
    return;
  }
  reveal();
}

function reveal() {
  document.querySelector('#loading').hidden = true;
  document.body.classList.remove('is-loading');
  document.body.classList.add('playing');
  playing = true;
  setStatus(false);
  resize();
  if (!localStorage.getItem('usti-help-seen')) openHelp();
  if (wantTour) {
    places?.startTour();
    const stop = places?.currentStop();
    if (stop) placeNear(stop.poi.x, stop.poi.z);
    wantTour = false;
  }
}

document.querySelector('#enter').addEventListener('click', () => beginPlay(false));
document.querySelector('#tour-start').addEventListener('click', () => beginPlay(true));
document.querySelector('#about-btn').addEventListener('click', () => {
  const about = document.querySelector('#about');
  about.hidden = !about.hidden;
});
document.querySelector('#help-close').addEventListener('click', closeHelp);
document.querySelector('#open-help').addEventListener('click', openHelp);
document.querySelector('#open-menu').addEventListener('click', openMenu);
document.querySelector('#menu-btn').addEventListener('click', openMenu);
document.querySelector('#menu-close').addEventListener('click', closeMenu);
document.querySelector('#open-map').addEventListener('click', () => overview?.toggle());
document.querySelector('#map-btn').addEventListener('click', () => overview?.toggle());
document.querySelector('#poi-btn').addEventListener('click', openNearbyPoi);
document.querySelector('#poi-close').addEventListener('click', closePoi);
document.querySelector('#poi-lookout').addEventListener('click', () => {
  const poi = places?.pois.find((item) => item.id === 'vetruse');
  if (poi) climbLookout(poi);
});
document.querySelector('#poi-next').addEventListener('click', () => {
  const stop = places?.advance();
  closePoi();
  if (stop) placeNear(stop.poi.x, stop.poi.z);
});
document.querySelector('#poi-cancel').addEventListener('click', () => {
  places?.cancelTour();
  closePoi();
});
document.querySelector('#home-btn').addEventListener('click', () => {
  goHome();
  closeMenu();
});
document.querySelector('#tour-btn').addEventListener('click', () => {
  places?.startTour();
  const stop = places?.currentStop();
  if (stop) placeNear(stop.poi.x, stop.poi.z);
  closeMenu();
});
document.querySelector('#hud-btn').addEventListener('click', () => setClean(!clean));
document.querySelector('#restore').addEventListener('click', () => setClean(false));
document.querySelector('#photo-btn').addEventListener('click', () => setPhoto(true));
document.querySelector('#photo-exit').addEventListener('click', () => setPhoto(false));
document.querySelector('#photo-save').addEventListener('click', () => {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  link.href = renderer.domElement.toDataURL('image/png');
  link.download = 'usti-pohled.png';
  link.click();
});
document.querySelector('#view-btn').addEventListener('click', () => setThirdPerson(!thirdPerson));
document.querySelector('#sound-btn').addEventListener('click', async () => {
  const on = await ambience.toggle();
  document.querySelector('#sound-btn').textContent = on ? 'Vypnout zvuk okolí' : 'Zapnout zvuk okolí';
});
document.querySelector('#quality').addEventListener('change', (event) => applyQuality(event.target.value));
const realTimeEl = document.querySelector('#real-time');
const hourShiftEl = document.querySelector('#hour-shift');
realTimeEl.addEventListener('change', () => {
  realClock = realTimeEl.checked;
  hourShiftEl.disabled = realClock;
});
hourShiftEl.addEventListener('input', () => {
  hourShift = Number(hourShiftEl.value);
});

function timeNow() {
  return new Date(Date.now() + (realClock ? 0 : hourShift) * 3600000);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  if (playing && !overlayBlocks()) updatePlayer(dt);
  updateCamera();
  if (daylight) {
    const skyState = daylight.update(player, { when: timeNow(), weather, allowRain: PRESETS[quality].rain });
    if (playing) {
      clockEl.textContent = skyState.clock;
      document.querySelector('#menu-clock').textContent = skyState.clock;
      if (groundMat) groundMat.color.setScalar(1 - skyState.night * 0.22);
      if (waterMat) {
        waterMat.opacity = skyState.wet ? 0.84 : 0.72;
        waterMat.color.set(skyState.wet ? 0x123f52 : 0x1a6d88);
      }
      if (lampMat) lampMat.emissiveIntensity = skyState.night > 0.62 ? 1.2 : 0.05;
    }
  }
  if (trolleys && playing) trolleys.update(dt);
  if (playing) updateLabels(labels, camera, { maxDist: PRESETS[quality].labels, hide: clean || photoMode });
  if (overview && playing) {
    overview.drawMini();
    if (overview.isOpen()) overview.drawMap();
  }
  if (playing) refreshWalkHud(now || performance.now());
  renderer.render(scene, camera);
}

async function boot() {
  const jobs = [
    ['meta.json', true],
    ['buildings.geojson', true],
    ['highways.geojson', true],
    ['landuse.geojson', true],
    ['water.geojson', true],
    ['trees.geojson', true],
    ['pois.json', true],
    ['furniture.geojson', false],
    ['routes.geojson', false],
  ];
  const got = new Map();
  let received = 0;
  const onProgress = (file, amount) => {
    const prev = got.get(file) || 0;
    received += Math.max(0, amount - prev);
    got.set(file, amount);
    setProgress(Math.min(0.7, received / 5200000), `${(received / 1e6).toFixed(1)} MB · ${fileLabel(file)}`);
  };
  const loaded = {};
  await Promise.all(jobs.map(async ([file, required]) => {
    const key = file.replace(/\.(geojson|json)$/, '');
    loaded[key] = required ? parseJson(await fetchBytes(file, onProgress)) : await loadOptionalJson(file, onProgress);
  }));
  let terrainGrid;
  try {
    const bytes = await fetchBytes('terrain.bin', onProgress);
    terrainGrid = terrainFromBin(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch {
    terrainGrid = parseJson(await fetchBytes('terrain.json', onProgress));
  }
  const texture = await loadTexture(quality === 'low' ? 'ortho-mobile.jpg' : 'ortho.jpg', onProgress);
  const meta = loaded.meta;
  const sameBox = meta && ['west', 'south', 'east', 'north'].every((key) => Math.abs(area.bbox[key] - meta.bbox[key]) < 1e-6);
  if (!sameBox) {
    const extra = import.meta.env.DEV ? ' Ve složce aplikace spusťte npm run download.' : '';
    hintEl.textContent = `Ohraničení modelu nesedí s daty.${extra}`;
  }
  terrain = makeTerrain(terrainGrid, projector);
  addGround(texture, terrain);
  setProgress(0.78, 'Sestavuji budovy…');
  const city = await buildCity(
    {
      buildings: loaded.buildings,
      highways: loaded.highways,
      landuse: loaded.landuse,
      water: loaded.water,
      trees: loaded.trees,
      startHint: area.startHint,
      terrain,
    },
    projector,
    {
      onSlice: ({ phase, done, total }) => {
        const ratio = total ? done / Math.max(total, 1) : 0.4;
        const label = phase === 'buildings' ? `Sestavuji budovy… ${done}` : 'Skládám město…';
        setProgress(0.78 + ratio * 0.18, label);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
  );
  view.add(city.group);
  collision = city.collision;
  labels = city.labels;
  waterMat = city.waterMaterial;
  api.trees = city.trees;
  player.x = city.start.x;
  player.z = city.start.z;
  player.y = terrain.sample(player.x, player.z);
  player.yaw = city.start.yaw;
  api.start = city.start;
  const pois = (loaded.pois?.features || []).map((poi) => {
    const [x, z] = projector.toLocal(poi.lon, poi.lat);
    return { ...poi, x, z };
  });
  const poiGroup = new THREE.Group();
  poiGroup.name = 'pois';
  for (const poi of pois) {
    const y = terrain.sample(poi.x, poi.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.8, 6), new THREE.MeshLambertMaterial({ color: 0xd7a441 }));
    pole.position.set(poi.x, y + 1.4, poi.z);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0xf0d78c, emissive: 0x8a6a20, emissiveIntensity: 0.35 }),
    );
    ball.position.set(poi.x, y + 2.9, poi.z);
    pole.userData.noShadow = true;
    ball.userData.noShadow = true;
    poiGroup.add(pole, ball);
    const named = city.labelPoints.some((point) => point.text === poi.name && Math.hypot(point.x - poi.x, point.z - poi.z) < 45);
    if (!named) {
      const sprite = makeNameSprite(poi.name);
      sprite.position.set(poi.x, y + 4.4, poi.z);
      poiGroup.add(sprite);
      labels.push(sprite);
    }
  }
  view.add(poiGroup);
  goalMark = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 1.3, 8),
    new THREE.MeshLambertMaterial({ color: 0xf0c14e, emissive: 0x8a6420, emissiveIntensity: 0.45 }),
  );
  goalMark.visible = false;
  goalMark.userData.noShadow = true;
  view.add(goalMark);
  furniture = addStreetFurniture(view, loaded.furniture, projector, terrain.sample.bind(terrain));
  lampMat = furniture.lampMat;
  addBridgeMarks(view, loaded.highways, projector, terrain.sample.bind(terrain));
  addVetruseMark(view, projector, terrain.sample.bind(terrain));
  trolleys = addTrolleys(view, loaded.routes, projector, terrain.sample.bind(terrain));
  places = createPlaces({ pois, labelPoints: city.labelPoints });
  const bounds = { minX: projector.minX, maxX: projector.maxX, minZ: projector.minZ, maxZ: projector.maxZ };
  overview = createOverview({
    mini: document.querySelector('#mini'),
    canvas: document.querySelector('#map-canvas'),
    panel: document.querySelector('#map'),
    geometry: collectMapGeometry(loaded.highways, loaded.water, projector),
    bounds,
    getPlayer: () => ({ x: player.x, z: player.z, yaw: player.yaw }),
    getWhere: () => places.whereText(player.x, player.z),
    getPois: () => places.pois.map((poi) => ({ ...poi, visited: places.visited.has(poi.id) })),
    search: (query) => places.search(query),
    onTeleport: (x, z) => {
      placeNear(x, z);
      overview.drawMap();
    },
    onPoi: (poi) => {
      placeNear(poi.x, poi.z);
      overview.setOpen(false);
      openPoi(poi);
    },
    onHome: () => goHome(),
    onTour: () => {
      places.startTour();
      const stop = places.currentStop();
      if (stop) placeNear(stop.poi.x, stop.poi.z);
      overview.setOpen(false);
    },
  });
  daylight = createDaylight({ hemi, sun, sky, fog: scene.fog, scene, camera });
  const hashed = readHash();
  if (hashed) {
    const [x, z] = projector.toLocal(hashed[0], hashed[1]);
    placeNear(x, z, hashed[2], hashed[3]);
  }
  applyQuality(quality);
  api.labels = city.labelPoints;
  api.ready = true;
  built = true;
  setProgress(1, 'Hotovo');
  if (!wantPlay) document.getElementById('start-progress').hidden = true;
  refreshVisited();
  if (wantPlay) reveal();
  fetchWeather()
    .then((current) => {
      weather = current;
      document.querySelector('#weather-credit').hidden = false;
      clockEl.title = 'Weather data by Open-Meteo.com (CC BY 4.0)';
    })
    .catch(() => {
      weather = null;
    });
}

boot().catch((error) => {
  console.error(error);
  const message = error.message || 'Model se nepodařilo načíst. Zkuste stránku obnovit.';
  document.body.classList.remove('is-loading');
  document.querySelector('#loading').hidden = true;
  document.getElementById('start-progress').hidden = false;
  document.getElementById('start-step').textContent = message;
  statusEl.textContent = message;
});

requestAnimationFrame(frame);
