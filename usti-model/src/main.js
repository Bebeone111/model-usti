import './style.css';
import * as THREE from 'three';
import area from '../area.config.json';
import { makeProjector } from './geom.js';
import { makeTerrain, terrainDetailFromBin, terrainFromBin } from './terrain.js';
import { addBlocker, buildCity, cameraDistance, makeNameSprite, nightGlow, sinkGround, walkBlocked, walkHeight, wrapBankSample } from './city.js';
import { fetchBytes, fileLabel, loadOptionalJson, parseJson } from './load.js';
import { hudRects, updateLabels } from './labels.js';
import { collectMapGeometry, createOverview } from './overview.js';
import { createPlaces } from './places.js';
import { addStreetFurniture, addTrolleys } from './furniture.js';
import { addSignatureBridges, nearestWalkDeck, punchWaterUnderDecks } from './bridges.js';
import { addHeroBuildings } from './landmarks.js';
import { addCableCar } from './cable.js';
import { createDaylight, fetchAirQuality, fetchWeather } from './daylight.js';
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
  low: { dpr: 1, shadows: false, labels: 170, trees: 0.45, furniture: 0.55, rain: false, lamps: false },
  medium: { dpr: 1.45, shadows: false, labels: 260, trees: 0.8, furniture: 1, rain: false, lamps: true },
  high: { dpr: 1.75, shadows: true, labels: 360, trees: 1, furniture: 1, rain: true, lamps: true },
};
const weak = (navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4;
const shotParams = new URLSearchParams(location.search);
let quality = shotParams.get('q') || (coarseQuery.matches || weak ? 'low' : 'medium');
const shotMode = shotParams.has('shot');
const forceNight = shotParams.has('night');
if (shotMode) localStorage.setItem('usti-help-seen', '1');

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
      season: { value: 0 },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vPos;
      uniform vec3 top;
      uniform vec3 horizon;
      uniform float cloud;
      uniform float night;
      uniform float season;
      float ign(vec2 p) {
        return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
      }
      void main() {
        vec3 n = normalize(vPos);
        float h = n.y;
        float t = smoothstep(-0.05, 0.45, h);
        vec3 day = mix(horizon, top, t);
        float veil = 0.78 + 0.08 * n.y;
        vec3 overcast = vec3(0.70, 0.74, 0.78) * veil;
        day = mix(day, overcast, cloud * (1.0 - t * 0.35));
        vec3 dusk = mix(vec3(0.07, 0.11, 0.2), vec3(0.18, 0.08, 0.05), season);
        vec3 color = mix(day, dusk, night);
        float star = step(0.992, ign(n.xz * 80.0)) * night * (1.0 - cloud);
        color += vec3(0.85, 0.9, 1.0) * star * 0.35;
        color += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(color, 1.0);
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
let poiMarks = [];
let lampLights = [];
let waterPoints = [];
let intro = 0;
let furniture = null;
let trolleys = null;
let cable = null;
let places = null;
let overview = null;
let daylight = null;
let weather = null;
let airQuality = null;
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
    let x = Number.isFinite(next.x) ? next.x : player.x;
    let z = Number.isFinite(next.z) ? next.z : player.z;
    if (Number.isFinite(next.lon) && Number.isFinite(next.lat)) {
      const local = projector.toLocal(next.lon, next.lat);
      x = local[0];
      z = local[1];
    }
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
if (import.meta.env.DEV) window.__usti = api;

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
  } else if (event.code === 'KeyE') {
    if (overview?.isOpen()) overview.setOpen(false);
    openNearbyPoi();
  }
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
  if (photoMode) {
    camera.fov = Math.min(78, Math.max(32, camera.fov + Math.sign(event.deltaY) * 1.6));
    camera.updateProjectionMatrix();
    return;
  }
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
    const snap = nearestWalkDeck(collision.decks, x, z, 42);
    if (snap) {
      for (let ring = 0; ring <= 12 && nx == null; ring += 1.4) {
        for (let a = 0; a < 16; a++) {
          const px = snap.cx + Math.cos((a / 16) * Math.PI * 2) * ring;
          const pz = snap.cz + Math.sin((a / 16) * Math.PI * 2) * ring;
          if (!walkBlocked(collision, px, pz, player.radius)) {
            nx = px;
            nz = pz;
            break;
          }
        }
      }
    }
    for (let ring = 1.6; ring <= 72 && nx == null; ring += 1.6) {
      for (let a = 0; a < 22; a++) {
        const px = x + Math.cos((a / 22) * Math.PI * 2) * ring;
        const pz = z + Math.sin((a / 22) * Math.PI * 2) * ring;
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
  player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
  if (Number.isFinite(yaw)) player.yaw = yaw;
  if (Number.isFinite(pitch)) player.pitch = Math.max(-1.05, Math.min(0.85, pitch));
  return true;
}

function yawAlongDeck(deck, towardNorth = true) {
  let tx = deck.tx || 0;
  let tz = deck.tz || 0;
  if (Math.hypot(tx, tz) < 0.05) {
    const dx = deck.maxX - deck.minX;
    const dz = deck.maxZ - deck.minZ;
    tx = dx >= dz ? 1 : 0;
    tz = dx >= dz ? 0 : 1;
  }
  if (towardNorth && tz < 0) {
    tx = -tx;
    tz = -tz;
  }
  return Math.atan2(-tx, -tz);
}

function faceMarianDeck() {
  const named = (collision.decks || []).find((deck) => deck.name === 'marian' && deck.walk);
  const deck = named || nearestWalkDeck(collision.decks, player.x, player.z, 160)?.deck;
  if (!deck) return;
  let north = null;
  let south = null;
  for (const p of deck.outer || []) {
    if (!north || p[1] > north[1]) north = p;
    if (!south || p[1] < south[1]) south = p;
  }
  const cx = (deck.minX + deck.maxX) / 2;
  const cz = (deck.minZ + deck.maxZ) / 2;
  if (north && south) {
    player.x = north[0] * 0.42 + south[0] * 0.58;
    player.z = north[1] * 0.42 + south[1] * 0.58;
  } else {
    player.x = cx;
    player.z = cz;
  }
  player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
  if (north) player.yaw = Math.atan2(-(north[0] - player.x), -(north[1] - player.z));
  else player.yaw = yawAlongDeck(deck, true);
  player.pitch = -0.1;
  shotLook = 'marian';
}

function goHome() {
  if (!api.start) return;
  placeNear(api.start.x, api.start.z, api.start.yaw, -0.4);
  overview?.centerOnPlayer();
}

function climbLookout() {
  const [x, z] = projector.toLocal(14.03980, 50.65540);
  placeNear(x, z, 3.20, -0.15);
  camBack = 6.2;
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
  player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
}

function limbBox(width, height, depth, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
}

function makePerson() {
  const skin = new THREE.MeshLambertMaterial({ color: 0x8a684c });
  const hair = new THREE.MeshLambertMaterial({ color: 0x1a1410 });
  const shirt = new THREE.MeshLambertMaterial({ color: 0x121820 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x0a0c0e });
  const shoes = new THREE.MeshLambertMaterial({ color: 0x161311 });
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
    person.visible = thirdPerson && keep > 1.55 && !photoMode;
  } else person.visible = thirdPerson && !photoMode;
  if (!thirdPerson || photoMode) person.visible = false;
  let floor = walkHeight(collision, camX, camZ, terrain.sample(camX, camZ));
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    floor = Math.max(floor, terrain.sample(player.x + (camX - player.x) * t, player.z + (camZ - player.z) * t));
  }
  camY = Math.max(player.y + 1.7, floor + 2.05, camY);
  if (!thirdPerson) camY = player.y + 1.62;
  camera.position.set(-camX, camY, camZ);
  if (shotMode && shotLook === 'marian') {
    camera.lookAt(-(player.x + fx * 36), player.y + 1.55 + sin * 8, player.z + fz * 36);
    return;
  }
  if (shotMode) {
    camera.lookAt(-(player.x + fx * 18), player.y + 1.4 + sin * 10, player.z + fz * 18);
    return;
  }
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
  trolleys?.setEnabled(quality !== 'low');
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
  if (!photoMode) document.querySelector('#thirds').hidden = true;
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

function formatOpeningHours(value) {
  if (!value || typeof value !== 'string') return '';
  if (/oh|https?:|<|>|javascript/i.test(value)) return '';
  if (value.length > 120 || value.length < 3) return '';
  return value;
}

function spawnAtPoi(poi) {
  if (!poi) return false;
  const lon = Number.isFinite(poi.spawnLon) ? poi.spawnLon : poi.lon;
  const lat = Number.isFinite(poi.spawnLat) ? poi.spawnLat : poi.lat;
  const [x, z] = projector.toLocal(lon, lat);
  const yaw = Number.isFinite(poi.spawnYaw) ? poi.spawnYaw : undefined;
  const pitch = Number.isFinite(poi.spawnPitch) ? poi.spawnPitch : -0.18;
  return placeNear(x, z, yaw, pitch);
}

function openPoi(poi, fromTour = false) {
  if (!poi) return;
  if (overview?.isOpen()) overview.setOpen(false);
  poiOpen = true;
  document.querySelector('#poi').hidden = false;
  document.querySelector('#poi-name').textContent = poi.name;
  document.querySelector('#poi-text').textContent = poi.text || '';
  const hours = document.querySelector('#poi-hours');
  if (hours) {
    const shown = formatOpeningHours(poi.opening_hours);
    hours.hidden = !shown;
    hours.textContent = shown ? `Otevírací doba: ${shown}` : '';
  }
  const photo = document.querySelector('#poi-photo');
  if (photo) {
    if (poi.photo) {
      photo.hidden = false;
      photo.querySelector('img').src = poi.photo;
      photo.querySelector('figcaption').textContent = poi.photoCredit || '';
    } else photo.hidden = true;
  }
  const link = document.querySelector('#poi-link');
  if (poi.osm || poi.wikidata) {
    link.hidden = false;
    link.href = poi.osm || poi.wikidata;
    link.textContent = poi.osm ? 'Otevřít na mapě OSM' : 'Wikidata';
  } else link.hidden = true;
  document.querySelector('#poi-lookout').hidden = poi.id !== 'vetruse';
  const touring = Boolean(places?.currentStop());
  const hunting = Boolean(places?.currentHunt());
  document.querySelector('#poi-next').hidden = !(fromTour || touring || hunting);
  document.querySelector('#poi-cancel').hidden = !(touring || hunting);
  if (hunting) document.querySelector('#poi-next').textContent = 'Další zastávka honu';
  else document.querySelector('#poi-next').textContent = 'Další zastávka';
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
  const byWater = waterPoints.some((point) => Math.hypot(point.x - player.x, point.z - player.z) < 42);
  const onHill = player.y > 28;
  ambience.presence(byWater, onHill);
  const near = places.nearPoi(player.x, player.z);
  actionsEl.textContent = coarse
    ? near
      ? 'Žluté tlačítko otevře místo'
      : 'Páčka chodí · tah po obrazu se rozhlíží'
    : ['Chůze WASD', 'Rychle Shift', 'Mapa M', near ? 'Památka E' : 'Nápověda Tab'].join(' · ');
  const arrived = places.noteArrival(player.x, player.z);
  if (arrived) openPoi(arrived.poi, true);
  const hunted = places.noteHunt(player.x, player.z);
  if (hunted) {
    statusEl.textContent = hunted.say;
    openPoi(hunted.poi, false);
  }
  const goal = places.currentHunt()?.poi || places.currentStop();
  if (goalMark) {
    goalMark.visible = Boolean(goal);
    if (goal) {
      const y = terrain.sample(goal.poi.x, goal.poi.z) + 3.1 + Math.sin(now / 280) * 0.15;
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

function addGround(texture, grid, pavingTex) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const anisotropy = renderer.capabilities.getMaxAnisotropy() || 8;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  const pave = pavingTex || new THREE.DataTexture(new Uint8Array([190, 184, 174, 255]), 1, 1);
  pave.colorSpace = THREE.SRGBColorSpace;
  pave.wrapS = THREE.RepeatWrapping;
  pave.wrapT = THREE.RepeatWrapping;
  pave.anisotropy = anisotropy;
  pave.generateMipmaps = true;
  pave.needsUpdate = true;
  const { minX, maxX, minZ, maxZ } = projector;
  const cols = grid.width;
  const rows = grid.height;
  const cellCols = cols - 1;
  const cellRows = rows - 1;
  const refined = new Uint8Array(cellCols * cellRows);
  const at = (c, r) => {
    const xn = c / cellCols;
    const zn = 1 - r / cellRows;
    return [minX + xn * (maxX - minX), minZ + zn * (maxZ - minZ), xn, zn];
  };
  for (let r = 0; r < cellRows; r++) {
    for (let c = 0; c < cellCols; c++) {
      let hot = grid.weight(at(c + 0.5, r + 0.5)[0], at(c + 0.5, r + 0.5)[1]) > 0.35;
      if (!hot) {
        for (const [cc, rr] of [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]]) {
          const [x, z] = at(cc, rr);
          if (grid.weight(x, z) > 0.35) hot = true;
        }
      }
      if (hot) refined[r * cellCols + c] = 1;
    }
  }
  const on = (r, c) => r >= 0 && c >= 0 && r < cellRows && c < cellCols && refined[r * cellCols + c] === 1;
  const positions = [];
  const uvs = [];
  const indices = [];
  const indexOf = new Map();
  const vert = (key, x, z, xn, zn) => {
    let index = indexOf.get(key);
    if (index == null) {
      index = positions.length / 3;
      indexOf.set(key, index);
      positions.push(x, grid.sample(x, z), z);
      uvs.push(xn, zn);
    }
    return index;
  };
  const corner = (c, r) => {
    const [x, z, xn, zn] = at(c, r);
    return vert(`g:${c}:${r}`, x, z, xn, zn);
  };
  const mid = (key, c0, r0, c1, r1) => {
    const [x0, z0, u0, v0] = at(c0, r0);
    const [x1, z1, u1, v1] = at(c1, r1);
    return vert(key, (x0 + x1) / 2, (z0 + z1) / 2, (u0 + u1) / 2, (v0 + v1) / 2);
  };
  for (let r = 0; r < cellRows; r++) {
    for (let c = 0; c < cellCols; c++) {
      const hot = on(r, c);
      const midN = hot || on(r - 1, c);
      const midS = hot || on(r + 1, c);
      const midW = hot || on(r, c - 1);
      const midE = hot || on(r, c + 1);
      const p00 = corner(c, r);
      const p10 = corner(c + 1, r);
      const p01 = corner(c, r + 1);
      const p11 = corner(c + 1, r + 1);
      if (!hot && !midN && !midS && !midW && !midE) {
        indices.push(p00, p01, p10, p10, p01, p11);
        continue;
      }
      const boundary = [p00];
      if (midW) boundary.push(mid(`v:${c}:${r}`, c, r, c, r + 1));
      boundary.push(p01);
      if (midS) boundary.push(mid(`h:${c}:${r + 1}`, c, r + 1, c + 1, r + 1));
      boundary.push(p11);
      if (midE) boundary.push(mid(`v:${c + 1}:${r}`, c + 1, r, c + 1, r + 1));
      boundary.push(p10);
      if (midN) boundary.push(mid(`h:${c}:${r}`, c, r, c + 1, r));
      const [cx, cz, cu, cv] = at(c + 0.5, r + 0.5);
      const center = vert(`c:${c}:${r}`, cx, cz, cu, cv);
      for (let i = 0; i < boundary.length; i++) indices.push(center, boundary[i], boundary[(i + 1) % boundary.length]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aNy', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3).fill(1), 1));
  geometry.setAttribute('aShore', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3).fill(80), 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal.array;
  let up = 0;
  for (let i = 1; i < normals.length; i += 3) up += normals[i];
  if (up < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  }
  groundMat = new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff, side: THREE.DoubleSide });
  const texel = new THREE.Vector2(1 / Math.max(1, texture.image?.width || 3605), 1 / Math.max(1, texture.image?.height || 2733));
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.paveMap = { value: pave };
    shader.uniforms.uHasPave = { value: pavingTex ? 1 : 0 };
    shader.uniforms.uTexel = { value: texel };
    const sq = projector.toLocal(14.040439, 50.660244);
    shader.uniforms.uSquare = { value: new THREE.Vector2(sq[0], sq[1]) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nattribute float aNy;\nattribute float aShore;\nvarying float vCamDist;\nvarying vec2 vGround;\nvarying float vNy;\nvarying float vShore;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCamDist = length(mvPosition.xyz);\nvGround = position.xz;\nvNy = aNy;\nvShore = aShore;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_pars_fragment>',
        '#include <map_pars_fragment>\nvarying float vCamDist;\nvarying vec2 vGround;\nvarying float vNy;\nvarying float vShore;\nuniform sampler2D paveMap;\nuniform float uHasPave;\nuniform vec2 uTexel;\nuniform vec2 uSquare;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 blur = (
          texture2D(map, vMapUv + vec2(uTexel.x, 0.0)).rgb +
          texture2D(map, vMapUv - vec2(uTexel.x, 0.0)).rgb +
          texture2D(map, vMapUv + vec2(0.0, uTexel.y)).rgb +
          texture2D(map, vMapUv - vec2(0.0, uTexel.y)).rgb
        ) * 0.25;
        vec3 photo = diffuseColor.rgb;
        vec3 sharp = clamp(photo + (photo - blur) * 0.95, 0.0, 1.0);
        float luma = dot(sharp, vec3(0.30, 0.55, 0.15));
        float green = sharp.g - max(sharp.r, sharp.b);
        float pale = smoothstep(0.28, 0.48, luma);
        vec3 settled = mix(sharp, sharp * vec3(0.62, 0.60, 0.56), pale);
        float nearMix = 1.0 - smoothstep(4.0, 32.0, vCamDist);
        float stone = smoothstep(0.16, 0.36, luma) * (1.0 - smoothstep(0.008, 0.045, green));
        vec2 uvA = vGround * 0.54;
        vec2 uvB = vec2(vGround.y, -vGround.x) * 0.29 + 0.19;
        vec3 stones = texture2D(paveMap, uvA).rgb;
        float grain = fract(sin(dot(vGround, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 stonesB = texture2D(paveMap, uvB + grain * 0.03).rgb;
        vec3 mixedStones = mix(stones, stonesB, 0.42 + 0.22 * grain);
        float square = 1.0 - smoothstep(8.0, 28.0, length(vGround - vec2(uSquare.x, uSquare.y)));
        diffuseColor.rgb = mix(photo, settled, nearMix);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(mixedStones, settled, 0.08), nearMix * max(stone, square * 0.65) * uHasPave);
        float quayWall = (1.0 - smoothstep(0.60, 0.68, vNy)) * (1.0 - smoothstep(13.0, 16.0, vShore));
        vec3 quay = vec3(0.56, 0.54, 0.50) * (0.94 + 0.08 * grain);
        diffuseColor.rgb = mix(diffuseColor.rgb, quay, quayWall);`
      );
  };
  groundMat.customProgramCacheKey = () => 'usti-ground-v6-quay';
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
let shotLook = '';

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
    if (stop) spawnAtPoi(stop.poi);
    wantTour = false;
    intro = 0;
  } else {
    intro = shotMode ? 0 : 1;
    camBack = shotMode ? 6.4 : 16.5;
    if (shotMode) setThirdPerson(false);
    if (!shotMode) player.pitch = -0.7;
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
  if (poi) climbLookout();
});
document.querySelector('#poi-next').addEventListener('click', () => {
  const stop = places?.currentHunt() ? places.advanceHunt() : places?.advance();
  closePoi();
  if (stop) {
    spawnAtPoi(stop.poi);
    if (stop.say) statusEl.textContent = stop.say;
  }
});
document.querySelector('#poi-cancel').addEventListener('click', () => {
  places?.cancelTour();
  places?.cancelHunt();
  closePoi();
});
document.querySelector('#home-btn').addEventListener('click', () => {
  goHome();
  closeMenu();
});
document.querySelector('#tour-btn').addEventListener('click', () => {
  places?.cancelHunt();
  places?.startTour();
  const stop = places?.currentStop();
  if (stop) spawnAtPoi(stop.poi);
  closeMenu();
});
document.querySelector('#hunt-btn')?.addEventListener('click', () => {
  places?.cancelTour();
  const stop = places?.startHunt();
  if (stop) {
    spawnAtPoi(stop.poi);
    statusEl.textContent = stop.say;
  }
  closeMenu();
});
document.querySelector('#fireworks-btn')?.addEventListener('click', () => {
  const on = daylight?.toggleFireworks();
  statusEl.textContent = on ? 'Ohňostroj zapnutý.' : 'Ohňostroj vypnutý.';
});
document.querySelector('#season')?.addEventListener('change', (event) => {
  daylight?.setSeason(event.target.value);
});
document.querySelector('#ride-btn')?.addEventListener('click', () => {
  if (trolleys?.riding()) trolleys.stopRide();
  else if (trolleys?.near(player.x, player.z)) trolleys.startRide(player.x, player.z);
  else if (cable?.nearStation(player.x, player.z)) cable.startRide(cable.nearStation(player.x, player.z));
  closeMenu();
});
document.querySelector('#hud-btn').addEventListener('click', () => setClean(!clean));
document.querySelector('#restore').addEventListener('click', () => setClean(false));
document.querySelector('#photo-btn').addEventListener('click', () => setPhoto(true));
document.querySelector('#photo-exit').addEventListener('click', () => setPhoto(false));
document.querySelector('#photo-thirds').addEventListener('click', () => {
  const thirds = document.querySelector('#thirds');
  thirds.hidden = !thirds.hidden;
});
document.querySelector('#share-btn').addEventListener('click', async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    statusEl.textContent = 'Odkaz na výhled je ve schránce.';
  } catch {
    statusEl.textContent = url;
  }
});
document.querySelector('#photo-save').addEventListener('click', () => {
  const hide = person.visible;
  person.visible = false;
  renderer.render(scene, camera);
  person.visible = hide;
  const dataUrl = renderer.domElement.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = dataUrl;
  const here = (places?.whereText(player.x, player.z) || 'centrum').split(' · ')[0];
  const slug = here.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pohled';
  const when = timeNow();
  const stamp = `${when.getHours().toString().padStart(2, '0')}${when.getMinutes().toString().padStart(2, '0')}`;
  link.download = `usti-${slug}-${stamp}.png`;
  link.click();
  try {
    const album = JSON.parse(localStorage.getItem('usti-album') || '[]');
    album.unshift({ name: link.download, at: Date.now(), thumb: dataUrl });
    localStorage.setItem('usti-album', JSON.stringify(album.slice(0, 8)));
  } catch {
    /* quota */
  }
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

function updatePoiMarks() {
  const camX = -camera.position.x;
  const camZ = camera.position.z;
  for (const mark of poiMarks) {
    const nearPlayer = Math.hypot(player.x - mark.x, player.z - mark.z);
    const nearCam = Math.hypot(camX - mark.x, camZ - mark.z);
    mark.pin.visible = nearPlayer > 14 && nearCam > 14 && nearPlayer < 160;
  }
}

function updateLampLights(night) {
  const allow = PRESETS[quality].lamps && night > 0.4;
  const strength = allow ? Math.min(1, (night - 0.4) / 0.35) : 0;
  const nearest = (furniture?.lamps || [])
    .map((lamp) => ({ lamp, dist: (lamp.x - player.x) ** 2 + (lamp.z - player.z) ** 2 }))
    .sort((a, b) => a.dist - b.dist);
  const nearStreet = nearest.filter((item) => item.dist < 75 * 75).slice(0, lampLights.length);
  lampLights.forEach((entry, index) => {
    const hit = nearStreet[index];
    if (!hit || strength <= 0) {
      entry.light.intensity = 0;
      entry.glow.visible = false;
      return;
    }
    entry.light.position.set(hit.lamp.x, hit.lamp.y + 4.2, hit.lamp.z);
    entry.light.intensity = 5.2 * strength;
    entry.glow.position.set(hit.lamp.x, hit.lamp.y + 0.2, hit.lamp.z);
    entry.glow.visible = true;
  });
  if (lampLights[0]) lampLights[0].glowMat.opacity = 0.22 * strength;
}

function collectWater(water, projector) {
  const points = [];
  for (const feature of water?.features || []) {
    const geometry = feature.geometry;
    const rings = geometry?.type === 'Polygon' ? geometry.coordinates : geometry?.type === 'MultiPolygon' ? geometry.coordinates.flat() : [];
    for (const ring of rings) {
      if (!ring?.length) continue;
      let lon = 0;
      let lat = 0;
      for (const [lo, la] of ring) {
        lon += lo;
        lat += la;
      }
      const [x, z] = projector.toLocal(lon / ring.length, lat / ring.length);
      points.push({ x, z });
    }
  }
  return points;
}

function timeNow() {
  if (forceNight) {
    const d = new Date();
    d.setHours(22, 40, 0, 0);
    return d;
  }
  return new Date(Date.now() + (realClock ? 0 : hourShift) * 3600000);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  if (playing && !overlayBlocks()) updatePlayer(dt);
  if (playing && intro > 0) {
    if (keys.size || Math.abs(stickX) > 0.05 || Math.abs(stickY) > 0.05) intro = 0;
    else {
      intro = Math.max(0, intro - dt / 2.6);
      const blend = 1 - intro * intro;
      camBack = 16.5 + (8.2 - 16.5) * blend;
      player.pitch = -0.7 + 0.3 * blend;
    }
  }
  updateCamera();
  let nightNow = 0;
  if (daylight) {
    const skyState = daylight.update(player, { when: timeNow(), weather, allowRain: PRESETS[quality].rain });
    nightNow = skyState.night;
    if (playing) {
      const aqi = Number.isFinite(airQuality?.european_aqi) ? ` · AQI ${Math.round(airQuality.european_aqi)}` : '';
      clockEl.textContent = `${skyState.clock}${aqi}`;
      document.querySelector('#menu-clock').textContent = clockEl.textContent;
      if (groundMat) groundMat.color.setScalar((1 - skyState.night * 0.22) * (skyState.wet ? 0.74 : 1));
      if (waterMat) {
        waterMat.opacity = skyState.wet ? 0.86 : 0.72;
        waterMat.color.set(skyState.wet ? 0x123f52 : 0x1a6d88);
        waterMat.shininess = skyState.night > 0.45 ? 64 : 18;
        waterMat.specular.set(skyState.night > 0.45 ? 0xd5eef6 : 0xb7dbe6);
      }
      if (lampMat) lampMat.emissiveIntensity = skyState.night > 0.4 ? 2.6 : 0.22;
      nightGlow.value = skyState.night > 0.32 ? 1.7 : 0;
      if (waterMat?.userData?.shader) {
        waterMat.userData.shader.uniforms.uTime.value = now * 0.001;
        waterMat.userData.shader.uniforms.uNight.value = skyState.night;
      }
    }
  }
  if (playing) updatePoiMarks();
  updateLampLights(nightNow);
  if (trolleys && playing) trolleys.update(dt);
  if (cable && playing) cable.update(dt, terrain.sample.bind(terrain));
  if (playing && trolleys?.riding()) {
    const ride = trolleys.stepRide(dt);
    if (ride) {
      player.x = ride.x;
      player.z = ride.z;
      player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
      if (Number.isFinite(ride.yaw)) player.yaw = ride.yaw;
    }
  } else if (playing && cable?.riding()) {
    const ride = cable.stepRide(dt, terrain.sample.bind(terrain));
    if (ride) {
      player.x = ride.x;
      player.z = ride.z;
      player.y = ride.y;
      if (Number.isFinite(ride.yaw)) player.yaw = ride.yaw;
      if (ride.done) climbLookout();
    }
  }
  if (playing) {
    updateLabels(labels, camera, {
      maxDist: PRESETS[quality].labels,
      hide: clean || photoMode,
      blockers: hudRects(['#dock', '#touch', '#mini', '#credit']),
    });
  }
  if (overview && playing) {
    overview.drawMini();
    if (overview.isOpen()) overview.drawMap();
  }
  if (playing) refreshWalkHud(now || performance.now());
  renderer.render(scene, camera);
}

function loadPublicTexture(url) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => resolve(null));
  });
}

function detailZones(water) {
  return { segments: [], slope: null };
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
  ];
  if (quality !== 'low') jobs.push(['routes.geojson', false]);
  jobs.push(['railways.geojson', false]);
  jobs.push(['addresses.geojson', false]);
  jobs.push(['aerialways.geojson', false]);
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
  let detail = null;
  try {
    const extra = await fetchBytes('terrain-detail.bin', onProgress);
    const parsed = terrainDetailFromBin(extra.buffer.slice(extra.byteOffset, extra.byteOffset + extra.byteLength));
    const zones = detailZones(loaded.water);
    detail = { patches: parsed.patches, segments: zones.segments, slope: zones.slope };
  } catch {
    detail = null;
  }
  terrain = makeTerrain(terrainGrid, projector, detail);
  const pavingTex = await loadPublicTexture('/textures/paving.jpg');
  const asphaltTex = await loadPublicTexture('/textures/asphalt.jpg');
  addGround(texture, terrain, pavingTex);
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
      asphaltMap: asphaltTex,
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
  terrain.sample = wrapBankSample(terrain.sample.bind(terrain), city.basins, city.waterY);
  const ground = view.getObjectByName('ground');
  if (ground?.geometry) sinkGround(ground.geometry, city.basins, city.waterY, []);
  const parks = city.group.getObjectByName('parks');
  const asphalt = city.group.getObjectByName('asphalt');
  if (parks?.geometry) sinkGround(parks.geometry, city.basins, city.waterY, []);
  if (asphalt?.geometry) sinkGround(asphalt.geometry, city.basins, city.waterY, []);
  const heroHits = addHeroBuildings(view, city.heroes, quality !== 'low');
  for (const hit of heroHits) addBlocker(collision, hit);
  labels = city.labels;
  const poiNames = new Set((loaded.pois?.features || []).map((poi) => poi.name));
  for (const sprite of labels) {
    if (poiNames.has(sprite.userData.text)) sprite.userData.poi = true;
  }
  waterMat = city.waterMaterial;
  api.trees = city.trees;
  player.x = city.start.x;
  player.z = city.start.z;
  player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
  player.yaw = city.start.yaw;
  const aheadX = player.x - Math.sin(player.yaw) * 7;
  const aheadZ = player.z - Math.cos(player.yaw) * 7;
  if (!walkBlocked(collision, aheadX, aheadZ, player.radius)) {
    player.x = aheadX;
    player.z = aheadZ;
    player.y = walkHeight(collision, player.x, player.z, terrain.sample(player.x, player.z));
  }
  api.start = city.start;
  const pois = (loaded.pois?.features || []).map((poi) => {
    const [x, z] = projector.toLocal(poi.lon, poi.lat);
    return { ...poi, x, z };
  });
  const poiGroup = new THREE.Group();
  poiGroup.name = 'pois';
  const ringGeo = new THREE.RingGeometry(0.45, 0.68, 18);
  const pinPole = new THREE.CylinderGeometry(0.03, 0.04, 1.05, 5);
  const pinFlag = new THREE.BoxGeometry(0.36, 0.18, 0.03);
  for (const poi of pois) {
    const y = terrain.sample(poi.x, poi.z);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xf0d78c, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(poi.x, y + 0.16, poi.z);
    const pin = new THREE.Group();
    const pole = new THREE.Mesh(pinPole, new THREE.MeshLambertMaterial({ color: 0xc4923a }));
    pole.position.y = 0.52;
    const flag = new THREE.Mesh(pinFlag, new THREE.MeshLambertMaterial({ color: 0xf0d78c, emissive: 0x8a6a20, emissiveIntensity: 0.2 }));
    flag.position.set(0.18, 0.95, 0);
    pin.add(pole, flag);
    pin.position.set(poi.x, y, poi.z);
    pin.userData.noShadow = true;
    ring.userData.noShadow = true;
    poiGroup.add(ring, pin);
    poiMarks.push({ pin, x: poi.x, z: poi.z });
    const named = city.labelPoints.some((point) => point.text === poi.name && Math.hypot(point.x - poi.x, point.z - poi.z) < 90);
    if (!named) {
      const sprite = makeNameSprite(poi.name);
      sprite.userData.poi = true;
      sprite.position.set(poi.x, y + 2.4, poi.z);
      poiGroup.add(sprite);
      labels.push(sprite);
    }
  }
  view.add(poiGroup);
  goalMark = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.7, 7),
    new THREE.MeshLambertMaterial({ color: 0xf0c14e, emissive: 0x8a6420, emissiveIntensity: 0.35 }),
  );
  goalMark.visible = false;
  goalMark.userData.noShadow = true;
  view.add(goalMark);
  furniture = addStreetFurniture(view, loaded.furniture, projector, terrain.sample.bind(terrain));
  lampMat = furniture.lampMat;
  const bridges = addSignatureBridges(view, {
    highways: loaded.highways,
    railways: loaded.railways,
    projector,
    sample: terrain.sample.bind(terrain),
    waterY: city.waterY ?? 0.9,
    detail: true,
  });
  collision.decks = bridges.decks;
  collision.rails = bridges.rails;
  const waterObj = view.getObjectByName('water');
  if (waterObj?.geometry) punchWaterUnderDecks(waterObj.geometry, bridges.decks, city.waterY ?? 0.9);
  if (ground?.geometry) sinkGround(ground.geometry, city.basins, city.waterY, bridges.decks);
  if (parks?.geometry) sinkGround(parks.geometry, city.basins, city.waterY, bridges.decks);
  if (asphalt?.geometry) sinkGround(asphalt.geometry, city.basins, city.waterY, bridges.decks);
  cable = addCableCar(view, {
    aerialways: loaded.aerialways,
    projector,
    sample: terrain.sample.bind(terrain),
    low: quality === 'low',
  });
  for (const stop of furniture.stops || []) {
    if (!stop.name) continue;
    const sprite = makeNameSprite(stop.name);
    sprite.userData.kind = 'stop';
    sprite.position.set(stop.x, stop.y + 4.2, stop.z);
    view.add(sprite);
    labels.push(sprite);
    city.labelPoints.push({ text: stop.name, x: stop.x, z: stop.z, y: stop.y + 4.2, kind: 'stop' });
  }
  trolleys = quality === 'low' ? null : addTrolleys(view, loaded.routes, projector, terrain.sample.bind(terrain));
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffb15a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  lampLights = Array.from({ length: 8 }, () => {
    const light = new THREE.PointLight(0xffc178, 0, 46, 1);
    light.castShadow = false;
    const glow = new THREE.Mesh(new THREE.CircleGeometry(2.4, 16), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.userData.noShadow = true;
    view.add(light, glow);
    return { light, glow, glowMat };
  });
  waterPoints = collectWater(loaded.water, projector);
  const addressRows = Array.isArray(loaded.addresses)
    ? loaded.addresses
    : loaded.addresses?.features?.map((feature) => ({
        name: feature.properties?.name || feature.name,
        lon: feature.lon ?? feature.geometry?.coordinates?.[0],
        lat: feature.lat ?? feature.geometry?.coordinates?.[1],
      })) || [];
  const addresses = addressRows
    .filter((item) => item?.name && Number.isFinite(item.lon) && Number.isFinite(item.lat))
    .map((item) => {
      const [x, z] = projector.toLocal(item.lon, item.lat);
      return { ...item, x, z };
    });
  places = createPlaces({ pois, labelPoints: city.labelPoints, addresses });
  const bounds = { minX: projector.minX, maxX: projector.maxX, minZ: projector.minZ, maxZ: projector.maxZ };
  overview = createOverview({
    mini: document.querySelector('#mini'),
    canvas: document.querySelector('#map-canvas'),
    panel: document.querySelector('#map'),
    geometry: collectMapGeometry(loaded.highways, loaded.water, projector, loaded.railways),
    bounds,
    getPlayer: () => ({ x: player.x, z: player.z, yaw: player.yaw }),
    getWhere: () => places.whereText(player.x, player.z),
    getPois: () => places.pois.map((poi) => ({ ...poi, visited: places.visited.has(poi.id) })),
    getLabels: () => city.labelPoints,
    getGoal: () => places.currentHunt()?.poi || places.currentStop()?.poi || null,
    search: (query) => places.search(query),
    onTeleport: (x, z, poi) => {
      if (poi) spawnAtPoi(poi);
      else placeNear(x, z);
      overview.setOpen(false);
    },
    onPoi: (poi) => {
      spawnAtPoi(poi);
      overview.setOpen(false);
      openPoi(poi);
    },
    onHome: () => goHome(),
    onTour: () => {
      places.startTour();
      const stop = places.currentStop();
      if (stop) spawnAtPoi(stop.poi);
      overview.setOpen(false);
    },
  });
  daylight = createDaylight({ hemi, sun, sky, fog: scene.fog, scene, camera });
  const applyHash = () => {
    const hashed = readHash();
    if (!hashed) return false;
    const [x, z] = projector.toLocal(hashed[0], hashed[1]);
    shotLook = '';
    const ok = placeNear(x, z, hashed[2], hashed[3]);
    if (Math.abs(hashed[0] - 14.05296) < 0.0008 && Math.abs(hashed[1] - 50.66107) < 0.0008) {
      faceMarianDeck();
      return true;
    }
    return ok;
  };
  applyHash();
  window.addEventListener('hashchange', applyHash);
  applyQuality(quality);
  api.labels = city.labelPoints;
  api.ready = true;
  built = true;
  setProgress(1, 'Hotovo');
  if (!wantPlay) document.getElementById('start-progress').hidden = true;
  refreshVisited();
  if (wantPlay) reveal();
  if (shotMode && !wantPlay) beginPlay(false);
  fetchWeather()
    .then((current) => {
      weather = current;
      document.querySelector('#weather-credit').hidden = false;
      clockEl.title = 'Weather data by Open-Meteo.com (CC BY 4.0)';
    })
    .catch(() => {
      weather = null;
    });
  fetchAirQuality()
    .then((air) => {
      airQuality = air;
    })
    .catch(() => {
      airQuality = null;
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
