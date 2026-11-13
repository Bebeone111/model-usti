import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildingBase,
  buildingHeight,
  cleanRing,
  clipPolygon,
  clipPolyline,
  distPointSeg,
  eachPolygon,
  pointInRing,
  signedArea,
  startPreference,
  windowRows,
} from './geom.js';
import { buildRoadGeometry, makeLineIndex } from './roads.js';
import { onDeck } from './bridges.js';

const WALLS = [0xf4d2a2, 0xe7b15f, 0xf8e4c8, 0xd9a05a, 0xf0c48c, 0xc98652, 0xedd4ae, 0xe8bc86, 0xf7e0c0, 0xdba56c, 0xf3d0a6, 0xe6c198];
const ROOFS = [0xd4653a, 0xc4512c, 0xe07040, 0xb8432a, 0xcc5a34, 0xa84830, 0x8d4a3c, 0x5c646c];
const LANDMARKS = {
  95522479: 'pavel',
  43529959: 'vojtech',
  52106385: 'cathedral',
  52107614: 'forum',
  63469970: 'zdar',
  63470030: 'magistrat',
  188090766: 'nadrazi',
  55855582: 'vetruse',
  79413889: 'divadlo',
};
const HERO_MESH = new Set(['pavel', 'vojtech', 'cathedral', 'forum', 'nadrazi', 'vetruse', 'divadlo']);
const FACADE = {
  pavel: { color: 0x8c3a32, roof: 0x4a3030, glass: [0.14, 0.16, 0.18], trim: [0.86, 0.78, 0.66], cell: 2.15, mode: 1, glow: 0.35, tower: 'brick' },
  vojtech: { color: 0xdccbb0, roof: 0x7a4332, glass: [0.16, 0.24, 0.28], trim: [0.94, 0.9, 0.84], cell: 2.55, mode: 1, glow: 0.4, tower: 'stone' },
  cathedral: { color: 0xe8d9c6, roof: 0x684038, glass: [0.13, 0.2, 0.26], trim: [0.96, 0.93, 0.88], cell: 3.05, mode: 1, glow: 0.42, tower: 'spire' },
  zdar: { color: 0xf6ead8, roof: 0xc25c38, glass: [0.2, 0.32, 0.38], trim: [0.9, 0.76, 0.56], cell: 3.5, mode: 0, glow: 0.72, tower: null },
  forum: { color: 0x909aa4, roof: 0x566068, glass: [0.1, 0.26, 0.36], trim: [0.72, 0.76, 0.8], cell: 9, mode: 2, glow: 0.9, tower: null },
  magistrat: { color: 0xe0cba6, roof: 0x8a4c36, glass: [0.18, 0.28, 0.34], trim: [0.95, 0.9, 0.78], cell: 4.6, mode: 0, glow: 0.5, tower: null },
};
const PARKISH = new Set(['park', 'forest', 'recreation_ground', 'grass', 'village_green', 'meadow', 'garden', 'cemetery']);

function hashId(value) {
  const text = String(value ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const NAMED_COLORS = {
  red: 0x8c3a32,
  brick: 0x8c3a32,
  brown: 0x6e4a32,
  yellow: 0xe2c36a,
  white: 0xf2ece2,
  grey: 0x8a9096,
  gray: 0x8a9096,
  black: 0x3a3c40,
  beige: 0xe8d7b8,
  cream: 0xf0e6d2,
  sand: 0xe2d0ae,
  orange: 0xc46a32,
};

function parseColor(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (NAMED_COLORS[text] != null) return NAMED_COLORS[text];
  const hex = text.match(/^#?([0-9a-f]{6})$/);
  if (hex) return Number.parseInt(hex[1], 16);
  return null;
}

function wallColorFor(tags, fallback) {
  if (tags['building:material'] === 'brick' && !tags['building:colour']) return 0x8c3a32;
  return parseColor(tags['building:colour']) || fallback;
}

function roofColorFor(tags, fallback) {
  return parseColor(tags['roof:colour']) || fallback;
}

function orient(ring, ccw) {
  if (!ring) return null;
  const open = cleanRing(ring);
  if (open.length < 3) return null;
  const positive = signedArea(open) > 0;
  if (positive !== ccw) open.reverse();
  return open;
}

function triangulate(outer, holes, y, normalY) {
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const holePts = holes.map((hole) => hole.map(([x, z]) => new THREE.Vector2(x, z)));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holePts);
  } catch {
    return null;
  }
  const flat = contour.concat(...holePts);
  const positions = [];
  const normals = [];
  for (const face of faces) {
    for (const index of face) {
      const p = flat[index];
      if (!p) return null;
      positions.push(p.x, y, p.y);
      normals.push(0, normalY, 0);
    }
  }
  return positions.length ? { positions, normals } : null;
}

function wallStrip(ring, groundAt, base, top, floors = 3) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const span = Math.max(2.4, top - base);
  const rows = Math.max(1, floors);
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const pieces = Math.max(1, Math.ceil(len / 7));
    for (let s = 0; s < pieces; s++) {
      const t0 = s / pieces;
      const t1 = (s + 1) / pieces;
      const ax = a[0] + dx * t0;
      const az = a[1] + dz * t0;
      const bx = a[0] + dx * t1;
      const bz = a[1] + dz * t1;
      const seg = len / pieces;
      const y0 = groundAt(ax, az) + base;
      const y1 = groundAt(bx, bz) + base;
      positions.push(ax, y0, az, bx, y1, bz, bx, y1 + span, bz, ax, y0, az, bx, y1 + span, bz, ax, y0 + span, az);
      for (let k = 0; k < 6; k++) normals.push(nx, 0, nz);
      uvs.push(acc, 0, acc + seg, 0, acc + seg, rows, acc, 0, acc + seg, rows, acc, rows);
      acc += seg;
    }
  }
  return positions.length ? { positions, normals, uvs } : null;
}

function doorStrip(ring, groundAt, base, top, edgeIndex = null) {
  let best = null;
  const consider = (i) => {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (!best || len > best.len) best = { a, b, dx, dz, len };
  };
  if (Number.isInteger(edgeIndex)) consider(edgeIndex);
  else for (let i = 0; i < ring.length; i++) consider(i);
  if (!best || best.len < 2.2) return null;
  const low = top - base < 4.4;
  const doorW = Math.min(low ? 2.6 : 1.45, best.len * (low ? 0.72 : 0.5));
  if (doorW < 0.7) return null;
  const doorH = Math.min(low ? 2.45 : 2.35, top - base - 0.2);
  if (doorH < 1.45) return null;
  const mx = (best.a[0] + best.b[0]) / 2;
  const mz = (best.a[1] + best.b[1]) / 2;
  const yb = groundAt(mx, mz) + base;
  const inv = best.len;
  const tx = best.dx / inv;
  const tz = best.dz / inv;
  const nx = best.dz / inv;
  const nz = -best.dx / inv;
  const hw = doorW / 2;
  const x0 = mx - tx * hw + nx * 0.1;
  const z0 = mz - tz * hw + nz * 0.1;
  const x1 = mx + tx * hw + nx * 0.1;
  const z1 = mz + tz * hw + nz * 0.1;
  const yt = yb + doorH;
  const positions = [x0, yb, z0, x1, yb, z1, x1, yt, z1, x0, yb, z0, x1, yt, z1, x0, yt, z0];
  const normals = [];
  for (let k = 0; k < 6; k++) normals.push(nx, 0, nz);
  return { positions, normals };
}

function geometryFromParts(parts) {
  let count = 0;
  for (const part of parts) count += part.positions.length;
  if (!count) return null;
  const positions = new Float32Array(count);
  const normals = new Float32Array(count);
  const hasUv = parts.every((part) => part.uvs && part.uvs.length === (part.positions.length / 3) * 2);
  const uvs = hasUv ? new Float32Array((count / 3) * 2) : null;
  let offset = 0;
  let uvOffset = 0;
  for (const part of parts) {
    positions.set(part.positions, offset);
    normals.set(part.normals, offset);
    if (uvs) {
      uvs.set(part.uvs, uvOffset);
      uvOffset += part.uvs.length;
    }
    offset += part.positions.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

function mergeList(list) {
  const geometries = list.filter(Boolean).map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  if (!geometries.length) return null;
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  if (geometries.length > 1) geometries.forEach((geometry) => geometry.dispose());
  return merged;
}

function polygonBounds(rings) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]);
      maxZ = Math.max(maxZ, p[1]);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

function projectRing(coords, projector) {
  return coords.map(([lon, lat]) => projector.toLocal(lon, lat));
}

function ringCentroid(ring) {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

function conformSurface(flat, sample, lift) {
  const src = flat.positions;
  const tris = [];
  for (let i = 0; i < src.length; i += 9) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const o = i + k * 3;
      const x = src[o];
      const z = src[o + 2];
      tri.push([x, sample(x, z) + lift, z]);
    }
    tri.depth = 0;
    tris.push(tri);
  }
  const cap = Math.min(tris.length * 14, tris.length + 120000);
  for (let t = 0; t < tris.length && tris.length < cap; t++) {
    const tri = tris[t];
    if (tri.depth >= 6) continue;
    let worst = 0;
    let edge = 0;
    let mid = null;
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const span = Math.hypot(a[0] - b[0], a[2] - b[2]);
      if (span < 1.6) continue;
      const mx = (a[0] + b[0]) * 0.5;
      const mz = (a[2] + b[2]) * 0.5;
      const gap = Math.abs((a[1] + b[1]) * 0.5 - (sample(mx, mz) + lift));
      if (gap > worst) {
        worst = gap;
        edge = e;
        mid = [mx, sample(mx, mz) + lift, mz];
      }
    }
    if (!(worst > 0.4 && mid)) continue;
    const a = tri[edge];
    const b = tri[(edge + 1) % 3];
    const c = tri[(edge + 2) % 3];
    const left = [a, mid, c];
    left.depth = tri.depth + 1;
    const right = [mid, b, c];
    right.depth = tri.depth + 1;
    tris[t] = left;
    tris.push(right);
    t -= 1;
  }
  const positions = [];
  const normals = [];
  for (const tri of tris) {
    let a = tri[0];
    let b = tri[1];
    let c = tri[2];
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acz = c[2] - a[2];
    if (abz * acx - abx * acz < 0) {
      const swap = b;
      b = c;
      c = swap;
    }
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) normals.push(nx, ny, nz);
  }
  return { positions, normals };
}

function densify(points, step) {
  if (!points || points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pieces = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function midpointOf(part) {
  let len = 0;
  for (let i = 1; i < part.length; i++) {
    len += Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
  }
  if (len < 8) return null;
  let acc = 0;
  const target = len / 2;
  for (let i = 1; i < part.length; i++) {
    const seg = Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
    if (acc + seg >= target) {
      const t = seg ? (target - acc) / seg : 0;
      return {
        len,
        x: part[i - 1][0] + (part[i][0] - part[i - 1][0]) * t,
        z: part[i - 1][1] + (part[i][1] - part[i - 1][1]) * t,
      };
    }
    acc += seg;
  }
  return { len, x: part[0][0], z: part[0][1] };
}

function niceName(text) {
  return String(text || '')
    .trim()
    .replace('Městský čast', 'Městský část')
    .replace('C´UP', "C'UP");
}

function rememberLine(store, name, part, sample, lift) {
  const text = niceName(name);
  if (!text || text === 'Elbe') return;
  const mid = midpointOf(part);
  if (!mid) return;
  const prev = store.get(text);
  if (prev && prev.len >= mid.len) return;
  store.set(text, { len: mid.len, x: mid.x, z: mid.z, y: sample(mid.x, mid.z) + lift });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function labelTexture(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const family = 'system-ui, sans-serif';
  let px = 54;
  ctx.font = `700 ${px}px ${family}`;
  let width = Math.ceil(ctx.measureText(text).width + 48);
  if (width > 920) {
    px = 40;
    ctx.font = `700 ${px}px ${family}`;
    width = Math.ceil(ctx.measureText(text).width + 40);
  }
  const height = px + 34;
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  roundRect(g, 2, 2, width - 4, height - 4, 14);
  g.fillStyle = 'rgba(16, 20, 24, 0.84)';
  g.fill();
  g.font = `700 ${px}px ${family}`;
  g.fillStyle = '#f6f3ec';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, width / 2, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData = { aspect: width / height };
  return texture;
}

export function makeNameSprite(text) {
  const map = labelTexture(niceName(text));
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, fog: false }),
  );
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 12;
  sprite.userData.aspect = map.userData.aspect;
  sprite.userData.text = niceName(text);
  sprite.scale.set(map.userData.aspect * 4, 4, 1);
  return sprite;
}

export const nightGlow = { value: 0 };

function facadeOnBeforeCompile(shader) {
  shader.uniforms.nightGlow = nightGlow;
  shader.vertexShader = shader.vertexShader
    .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vFacadeUv;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = uv;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nvarying vec2 vFacadeUv;\nuniform float nightGlow;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float fx = mod(vFacadeUv.x, 3.05);
      float fy = fract(vFacadeUv.y);
      float pane = step(0.48, fx) * step(fx, 2.4) * step(0.28, fy) * step(fy, 0.74);
      float course = step(fy, 0.05);
      vec3 glass = vec3(0.18, 0.22, 0.26);
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, pane * 0.72);
      diffuseColor.rgb *= mix(1.0, 0.8, course);
      float cornice = step(0.9, fy);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.68, 0.62), cornice);
      float id = floor(vFacadeUv.x / 3.05) * 17.0 + floor(vFacadeUv.y * 9.0);
      float lit = step(0.5, fract(sin(id * 127.13) * 43758.5453));
      diffuseColor.rgb += vec3(1.0, 0.48, 0.08) * pane * lit * nightGlow * 3.4;`,
    );
}

function convexOpen(ring) {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1.2) continue;
    const s = Math.sign(cross);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function pyramidRoof(ring, sample, top, rise) {
  const [cx, cz] = ringCentroid(ring);
  const yc = sample(cx, cz) + top + rise;
  const positions = [];
  const normals = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ya = sample(a[0], a[1]) + top;
    const yb = sample(b[0], b[1]) + top;
    let p0 = [a[0], ya, a[1]];
    let p1 = [b[0], yb, b[1]];
    let p2 = [cx, yc, cz];
    const abx = p1[0] - p0[0];
    const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0];
    const acz = p2[2] - p0[2];
    if (abz * acx - abx * acz < 0) {
      const swap = p1;
      p1 = p2;
      p2 = swap;
    }
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    for (let k = 0; k < 3; k++) normals.push(nx / len, ny / len, nz / len);
  }
  return positions.length ? { positions, normals } : null;
}

function facadeMaterial(color) {
  const material = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  material.onBeforeCompile = facadeOnBeforeCompile;
  material.customProgramCacheKey = () => 'usti-facade-v6-amber';
  return material;
}

function landmarkKey(tags) {
  const id = Number(tags.osmId);
  if (LANDMARKS[id]) return LANDMARKS[id];
  const kind = String(tags.building || '');
  const name = String(tags.name || '');
  if (kind === 'cathedral' || /katedr|nanebevzet/i.test(name)) return 'cathedral';
  if (kind === 'church' || /kostel|chrám|chram/i.test(name)) return /pavla/i.test(name) ? 'pavel' : 'vojtech';
  return null;
}

function towerPoint(outer) {
  const [cx, cz] = ringCentroid(outer);
  let far = outer[0];
  let best = -1;
  for (const point of outer) {
    const dist = (point[0] - cx) ** 2 + (point[1] - cz) ** 2;
    if (dist > best) {
      best = dist;
      far = point;
    }
  }
  return [cx * 0.64 + far[0] * 0.36, cz * 0.64 + far[1] * 0.36];
}

function styledFacade(style, name) {
  const material = new THREE.MeshLambertMaterial({ color: style.color, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.nightGlow = nightGlow;
    shader.uniforms.uCell = { value: style.cell };
    shader.uniforms.uMode = { value: style.mode };
    shader.uniforms.uGlow = { value: style.glow };
    shader.uniforms.uGlass = { value: new THREE.Vector3(...style.glass) };
    shader.uniforms.uTrim = { value: new THREE.Vector3(...style.trim) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vFacadeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <uv_pars_fragment>',
        '#include <uv_pars_fragment>\nvarying vec2 vFacadeUv;\nuniform float nightGlow;\nuniform float uCell;\nuniform float uMode;\nuniform float uGlow;\nuniform vec3 uGlass;\nuniform vec3 uTrim;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float nx = mod(vFacadeUv.x, uCell) / uCell;
        float fy = fract(vFacadeUv.y);
        float pane = step(0.18, nx) * step(nx, 0.82) * step(0.24, fy) * step(fy, 0.78);
        if (uMode > 0.5 && uMode < 1.5) pane = step(0.36, nx) * step(nx, 0.64) * step(0.16, fy) * step(fy, 0.9);
        if (uMode > 1.5) pane = step(0.1, fy) * step(fy, 0.78);
        float cornice = smoothstep(0.8, 0.9, fy);
        float base = 1.0 - smoothstep(0.0, 0.16, fy);
        vec3 tone = diffuseColor.rgb;
        tone = mix(tone, uGlass, pane * 0.9);
        tone = mix(tone, uTrim, cornice);
        tone *= mix(1.0, 0.7, base * 0.8);
        float id = floor(vFacadeUv.x / max(uCell, 0.2)) * 19.0 + floor(vFacadeUv.y * 8.0);
        float lit = step(0.52, fract(sin(id * 91.17) * 43758.5453));
        diffuseColor.rgb = tone + vec3(1.0, 0.48, 0.08) * pane * lit * nightGlow * uGlow * 2.8;`,
      );
  };
  material.customProgramCacheKey = () => `usti-landmark-${name}-amber`;
  return material;
}

const CAFE_GARDEN = {
  name: "C'UP",
  // Palachova side of the house, in the strip between that wall and the roadway.
  lon: 14.0274680,
  lat: 50.6657236,
  yaw: 0.8669,
};

function addCafeGarden(group, sample, projector) {
  const [x, z] = projector.toLocal(CAFE_GARDEN.lon, CAFE_GARDEN.lat);
  if (x < projector.minX + 4 || x > projector.maxX - 4 || z < projector.minZ + 4 || z > projector.maxZ - 4) return null;
  const y = sample(x, z);
  const root = new THREE.Group();
  root.name = 'cafe-garden';
  root.position.set(x, y, z);
  root.rotation.y = CAFE_GARDEN.yaw;

  const wood = new THREE.MeshLambertMaterial({ color: 0x8d5a34 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.07, 0.9), wood);
  top.position.y = 0.74;
  root.add(top);
  const legGeo = new THREE.BoxGeometry(0.08, 0.7, 0.08);
  for (const [lx, lz] of [[-1.05, -0.32], [1.05, -0.32], [-1.05, 0.32], [1.05, 0.32]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(lx, 0.35, lz);
    root.add(leg);
  }

  const shirts = [0x3c6eae, 0xc4553a, 0x3d8b5f, 0xd4a24a, 0x6a4c93, 0x2f6f8f, 0xb85c38, 0x355e78];
  const hairs = [0x3a2c24, 0x1c140f, 0x6b4a32, 0x2a211c, 0x4a3428, 0x111111, 0x8a6844, 0x241810];
  const seats = [
    [-0.78, 0.86, 0],
    [0, 0.86, 0],
    [0.78, 0.86, 0],
    [-0.78, -0.86, Math.PI],
    [0, -0.86, Math.PI],
    [0.78, -0.86, Math.PI],
    [1.55, 0, Math.PI / 2],
    [-1.55, 0, -Math.PI / 2],
  ];
  seats.forEach(([sx, sz, rot], i) => {
    const guest = makeSeatedGuest(shirts[i], hairs[i]);
    guest.position.set(sx, 0, sz);
    guest.rotation.y = rot;
    root.add(guest);
  });
  group.add(root);
  return { name: CAFE_GARDEN.name, x, y: y + 2.5, z };
}

function makeSeatedGuest(shirtColor, hairColor) {
  const skin = new THREE.MeshLambertMaterial({ color: 0xd2a679 });
  const hair = new THREE.MeshLambertMaterial({ color: hairColor });
  const shirt = new THREE.MeshLambertMaterial({ color: shirtColor });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2a3644 });
  const chairMat = new THREE.MeshLambertMaterial({ color: 0x6e4a30 });
  const cupMat = new THREE.MeshLambertMaterial({ color: 0xf7f4ee });
  const coffee = new THREE.MeshLambertMaterial({ color: 0x4a2e22 });
  const guest = new THREE.Group();

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), chairMat);
  seat.position.set(0, 0.46, 0.06);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.46, 0.05), chairMat);
  back.position.set(0, 0.7, 0.26);
  guest.add(seat, back);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.36, 0.16), shirt);
  torso.position.set(0, 0.86, 0.02);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), skin);
  head.position.set(0, 1.16, 0.01);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.17), hair);
  cap.position.set(0, 1.26, 0.01);
  guest.add(torso, head, cap);

  const thighL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.34), pants);
  thighL.position.set(-0.09, 0.5, -0.16);
  const thighR = thighL.clone();
  thighR.position.x = 0.09;
  const shinL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.32, 0.09), pants);
  shinL.position.set(-0.09, 0.28, -0.32);
  const shinR = shinL.clone();
  shinR.position.x = 0.09;
  const footL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.16), new THREE.MeshLambertMaterial({ color: 0x241c18 }));
  footL.position.set(-0.09, 0.08, -0.36);
  const footR = footL.clone();
  footR.position.x = 0.09;
  guest.add(thighL, thighR, shinL, shinR, footL, footR);

  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.28), shirt);
  armL.position.set(-0.2, 0.78, -0.16);
  const armR = armL.clone();
  armR.position.x = 0.2;
  guest.add(armL, armR);

  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.07, 8), cupMat);
  cup.position.set(0.12, 0.8, -0.58);
  const drink = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.015, 8), coffee);
  drink.position.set(0.12, 0.83, -0.58);
  guest.add(cup, drink);
  return guest;
}

function streetEdge(ring, roads) {
  let best = null;
  let longest = 0;
  let longestIndex = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len > longest) {
      longest = len;
      longestIndex = i;
    }
    if (len < 2.2) continue;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    const hit = roads.query(mx, mz, 36);
    if (!hit) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const vx = hit.x - mx;
    const vz = hit.z - mz;
    const dist = Math.hypot(vx, vz) || 1;
    if ((vx * nx + vz * nz) / dist < 0.2) continue;
    const score = dist - Math.min(len, 22) * 0.03;
    if (!best || score < best.score) best = { index: i, score };
  }
  return best ? best.index : longestIndex;
}

function drapeFlat(flat, sample, lift, parts) {
  const positions = [];
  const normals = [];
  for (let i = 0; i < flat.length; i += 6) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const x = flat[i + k * 2];
      const z = flat[i + k * 2 + 1];
      tri.push([x, sample(x, z) + lift, z]);
    }
    let [a, b, c] = tri;
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acz = c[2] - a[2];
    if (abz * acx - abx * acz < 0) {
      const swap = b;
      b = c;
      c = swap;
    }
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) normals.push(nx, ny, nz);
  }
  if (positions.length) parts.push({ positions, normals });
}

function coverIndex(polys) {
  const cell = 48;
  const grid = new Map();
  polys.forEach((poly, index) => {
    const minIx = Math.floor(poly.minX / cell);
    const maxIx = Math.floor(poly.maxX / cell);
    const minIz = Math.floor(poly.minZ / cell);
    const maxIz = Math.floor(poly.maxZ / cell);
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iz = minIz; iz <= maxIz; iz++) {
        const key = `${ix},${iz}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(index);
      }
    }
  });
  return function blocked(x, z) {
    const list = grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) || [];
    for (const index of list) {
      const poly = polys[index];
      if (!pointInRing(x, z, poly.outer)) continue;
      let hole = false;
      for (const h of poly.holes) {
        if (pointInRing(x, z, h)) {
          hole = true;
          break;
        }
      }
      if (!hole) return true;
    }
    return false;
  };
}

function treeUnit(salt, x, z) {
  let h = Math.imul((Math.round(x * 10) ^ Math.imul(Math.round(z * 10), 0x9e3779b1) ^ salt) >>> 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h >>> 0) / 4294967296;
}

function canopyGeometry() {
  const positions = [];
  const pushCone = (y0, y1, radius, sides) => {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      positions.push(0, y1, 0, Math.cos(a0) * radius, y0, Math.sin(a0) * radius, Math.cos(a1) * radius, y0, Math.sin(a1) * radius);
    }
  };
  pushCone(0, 0.62, 1, 6);
  pushCone(0.4, 1.02, 0.58, 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function addTrees(group, data, projector, sample, roads, blockers) {
  const blocked = coverIndex(blockers);
  const points = [];
  const occupied = new Set();
  const claim = (x, z) => {
    const key = `${Math.round(x / 4.4)},${Math.round(z / 4.4)}`;
    if (occupied.has(key)) return false;
    occupied.add(key);
    return true;
  };
  const place = (x, z, extra) => {
    if (x < projector.minX + 3 || x > projector.maxX - 3 || z < projector.minZ + 3 || z > projector.maxZ - 3) return;
    const hit = roads.query(x, z, 28);
    if (hit && hit.dist < hit.half + extra) return;
    if (blocked(x, z)) return;
    if (!claim(x, z)) return;
    const roll = treeUnit(1, x, z);
    points.push({
      x,
      z,
      y: sample(x, z),
      scale: 0.82 + roll * 0.55,
      rot: treeUnit(2, x, z) * Math.PI * 2,
      tint: treeUnit(3, x, z),
    });
  };
  const box = [projector.minX, projector.minZ, projector.maxX, projector.maxZ];
  const scatterArea = (feature, spacing) => {
    eachPolygon(feature.geometry, (coords) => {
      if (!coords?.[0]) return;
      const outer = orient(clipPolygon(projectRing(coords[0], projector), ...box), true);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < coords.length; i++) {
        const hole = orient(clipPolygon(projectRing(coords[i], projector), ...box), false);
        if (hole) holes.push(hole);
      }
      const area = Math.abs(signedArea(outer));
      if (area < 80) return;
      let step = spacing;
      if (area / (step * step) > 620) step = Math.sqrt(area / 620);
      const bounds = polygonBounds([outer]);
      for (let x = bounds.minX + step * 0.5; x < bounds.maxX; x += step) {
        for (let z = bounds.minZ + step * 0.5; z < bounds.maxZ; z += step) {
          const jx = x + (treeUnit(4, x, z) - 0.5) * step * 0.7;
          const jz = z + (treeUnit(5, x, z) - 0.5) * step * 0.7;
          if (!pointInRing(jx, jz, outer)) continue;
          let hole = false;
          for (const ring of holes) {
            if (pointInRing(jx, jz, ring)) hole = true;
          }
          if (!hole) place(jx, jz, 4.4);
        }
      }
    });
  };
  for (const feature of data.trees?.features || []) {
    const tags = feature.properties || {};
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'Point' && tags.natural === 'tree') {
      const [x, z] = projector.toLocal(geometry.coordinates[0], geometry.coordinates[1]);
      place(x, z, -0.35);
      continue;
    }
    if (geometry.type === 'LineString' && tags.natural === 'tree_row') {
      const local = projectRing(geometry.coordinates, projector);
      for (const part of clipPolyline(local, ...box)) {
        let acc = 6;
        for (let i = 1; i < part.length; i++) {
          const len = Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
          let walked = 0;
          while (acc + walked <= len) {
            const t = len ? (acc + walked) / len : 0;
            place(
              part[i - 1][0] + (part[i][0] - part[i - 1][0]) * t,
              part[i - 1][1] + (part[i][1] - part[i - 1][1]) * t,
              -0.2,
            );
            walked += 8;
          }
          acc = acc + walked - len;
        }
      }
      continue;
    }
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      const park = tags.leisure === 'park';
      const wood = tags.natural === 'wood' || tags.landuse === 'forest';
      if (park || wood) scatterArea(feature, park ? 8.2 : 11);
    }
  }
  for (const feature of data.landuse?.features || []) {
    if (feature.properties?.landuse === 'forest') scatterArea(feature, 11);
  }
  if (!points.length) return { count: 0, trunks: null, canopy: null };
  const greens = [0x2e6b34, 0x3d7c3c, 0x4d8c42, 0x255e30, 0x5a9346];
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.1, 0.16, 1, 5).translate(0, 0.5, 0),
    new THREE.MeshLambertMaterial({ color: 0x6a4b32 }),
    points.length,
  );
  const canopy = new THREE.InstancedMesh(
    canopyGeometry(),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    points.length,
  );
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  points.forEach((point, index) => {
    const trunkH = 1.45 + point.scale * 1.05;
    const canopyH = 2.15 + point.scale * 1.45;
    const radius = 1.05 + point.scale * 0.85;
    dummy.rotation.set(0, point.rot, 0);
    dummy.position.set(point.x, point.y, point.z);
    dummy.scale.set(1, trunkH, 1);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);
    dummy.position.y = point.y + trunkH * 0.86;
    dummy.scale.set(radius, canopyH, radius);
    dummy.updateMatrix();
    canopy.setMatrixAt(index, dummy.matrix);
    color.setHex(greens[Math.floor(point.tint * greens.length) % greens.length]);
    canopy.setColorAt(index, color);
  });
  trunks.instanceMatrix.needsUpdate = true;
  canopy.instanceMatrix.needsUpdate = true;
  if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
  const grove = new THREE.Group();
  grove.name = 'trees';
  grove.add(trunks, canopy);
  group.add(grove);
  trunks.userData.fullCount = points.length;
  canopy.userData.fullCount = points.length;
  return { count: points.length, trunks, canopy };
}

function asphaltMaterial(texture) {
  const material = new THREE.MeshLambertMaterial({
    color: texture ? 0xffffff : 0x3a414c,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  if (!texture) return material;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.asphaltMap = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vRoadUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRoadUv = position.xz * 0.18;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D asphaltMap;\nvarying vec2 vRoadUv;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= texture2D(asphaltMap, vRoadUv).rgb;');
  };
  material.customProgramCacheKey = () => 'usti-asphalt-v1';
  return material;
}

function onMapEdge(ax, az, bx, bz, box) {
  const [minX, minZ, maxX, maxZ] = box;
  const near = (value, limit) => Math.abs(value - limit) < 1.4;
  return (
    (near(ax, minX) && near(bx, minX))
    || (near(ax, maxX) && near(bx, maxX))
    || (near(az, minZ) && near(bz, minZ))
    || (near(az, maxZ) && near(bz, maxZ))
  );
}

function pushRibbon(positions, ax, az, bx, bz, ox, oz, sample, lift, cap = Infinity) {
  const y0 = Math.min(cap, sample(ax, az) + lift);
  const y1 = Math.min(cap, sample(bx, bz) + lift);
  const y2 = Math.min(cap, sample(bx + ox, bz + oz) + lift);
  const y3 = Math.min(cap, sample(ax + ox, az + oz) + lift);
  positions.push(ax, y0, az, bx, y1, bz, bx + ox, y2, bz + oz, ax, y0, az, bx + ox, y2, bz + oz, ax + ox, y3, az + oz);
}

function addShores(group, rings, sample, box, waterY = 0.9) {
  const gravel = [];
  const wet = [];
  const quay = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.8) continue;
      if (onMapEdge(a[0], a[1], b[0], b[1], box)) continue;
      const pieces = Math.max(1, Math.ceil(len / 24));
      for (let s = 0; s < pieces; s++) {
        const t0 = s / pieces;
        const t1 = (s + 1) / pieces;
        const ax = a[0] + dx * t0;
        const az = a[1] + dz * t0;
        const bx = a[0] + dx * t1;
        const bz = a[1] + dz * t1;
        const landX = (-dz / len) * 2.4;
        const landZ = (dx / len) * 2.4;
        pushRibbon(gravel, ax, az, bx, bz, landX, landZ, () => waterY + 1.35, 0, waterY + 1.45);
        pushRibbon(wet, ax, az, bx, bz, (dz / len) * 1.2, (-dx / len) * 1.2, () => waterY, 0.04, waterY + 0.1);
        const yb = waterY - 0.15;
        const yt = waterY + 1.55;
        quay.push(ax, yb, az, bx, yb, bz, bx, yt, bz, ax, yb, az, bx, yt, bz, ax, yt, az);
      }
    }
  }
  const make = (positions, color, factor) => {
    if (positions.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshLambertMaterial({
          color,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: factor,
          polygonOffsetUnits: factor,
        }),
      ),
    );
  };
  make(gravel, 0xc6b59a, -2);
  make(wet, 0x5e6d66, -3);
  make(quay, 0x8a8580, -1);
}

export async function buildCity(data, projector, hooks = {}) {
  const tick = async (phase, done, total) => {
    if (!hooks.onSlice) return;
    await hooks.onSlice({ phase, done, total });
  };
  const { buildings, highways, water } = data;
  const sample = data.terrain?.sample || (() => 0);
  const roads = buildRoadGeometry(highways.features || [], projector);
  const carriageways = makeLineIndex(roads.centerlines);
  const wallBuckets = WALLS.map(() => ({ plain: [], windows: [] }));
  const roofBuckets = ROOFS.map(() => []);
  const extraWalls = new Map();
  const extraRoofs = new Map();
  const extraBucket = (map, color) => {
    if (!map.has(color)) map.set(color, []);
    return map.get(color);
  };
  const styledParts = Object.fromEntries(Object.keys(FACADE).map((name) => [name, { walls: [], roofs: [] }]));
  const doorParts = [];
  const walkParts = [];
  const asphaltParts = [];
  const waterParts = [];
  const parkParts = [];
  const blockers = [];
  const towers = [];
  const heroes = [];
  const buildingLabels = new Map();
  const streetLabels = new Map();
  const riverLabels = new Map();
  const shoreRings = [];
  const stats = { buildings: 0, skippedBuildings: 0, roads: 0, sidewalks: 0, water: 0, labels: 0, trees: 0 };
  const box = [projector.minX, projector.minZ, projector.maxX, projector.maxZ];

  for (const feature of buildings.features || []) {
    const tags = feature.properties || {};
    const top = buildingHeight(tags);
    const base = buildingBase(tags, top);
    const colorKey = String(tags.osmId ?? tags.name ?? '');
    const wallIndex = hashId(colorKey) % WALLS.length;
    const roofIndex = hashId(`${colorKey}:roof`) % ROOFS.length;
    const taggedWall = wallColorFor(tags, null);
    const taggedRoof = roofColorFor(tags, null);
    const name = niceName(tags.name);
    const styleName = landmarkKey(tags);
    let placed = false;
    eachPolygon(feature.geometry, (coords) => {
      if (!coords?.[0]) return;
      const outer = orient(clipPolygon(projectRing(coords[0], projector), ...box), true);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < coords.length; i++) {
        const hole = orient(clipPolygon(projectRing(coords[i], projector), ...box), false);
        if (hole) holes.push(hole);
      }
      const rows = windowRows(tags, top, base);
      const [cx0, cz0] = ringCentroid(outer);
      const vetruseAt = projector.toLocal(14.039608, 50.655013);
      const lookoutAt = projector.toLocal(14.03980, 50.65540);
      const squareAt = projector.toLocal(14.040439, 50.660244);
      const churchAt = projector.toLocal(14.040451, 50.659072);
      if (
        styleName !== 'vetruse'
        && (Math.hypot(cx0 - vetruseAt[0], cz0 - vetruseAt[1]) < 120 || Math.hypot(cx0 - lookoutAt[0], cz0 - lookoutAt[1]) < 130)
      ) {
        return;
      }
      if (styleName !== 'cathedral') {
        const span = squareAt[1] - churchAt[1];
        const along = span ? (cz0 - churchAt[1]) / span : -1;
        if (along > 0.12 && along < 0.88 && Math.abs(cx0 - churchAt[0]) < 36) return;
      }
      if (styleName && HERO_MESH.has(styleName)) {
        const [hx, hz] = ringCentroid(outer);
        heroes.push({
          key: styleName,
          tags,
          outer,
          holes,
          x: hx,
          z: hz,
          y: sample(hx, hz),
          top,
          area: Math.abs(signedArea(outer)),
        });
        const closedOuter = outer.concat([outer[0]]);
        const closedHoles = holes.map((hole) => hole.concat([hole[0]]));
        const bounds = polygonBounds([closedOuter, ...closedHoles]);
        blockers.push({
          outer: closedOuter,
          holes: closedHoles,
          top,
          blocksWalk: true,
          blocksCamera: true,
          ...bounds,
        });
        if (name) {
          const prev = buildingLabels.get(name);
          const area = Math.abs(signedArea(outer));
          if (!prev || area > prev.area) {
            buildingLabels.set(name, { area, x: hx, z: hz, y: sample(hx, hz) + top + 2.4 });
          }
        }
        placed = true;
        return;
      }
      const strips = [];
      const outerWall = wallStrip(outer, sample, base, top, Math.max(1, rows));
      if (outerWall) strips.push(outerWall);
      for (const hole of holes) {
        const innerWall = wallStrip(hole, sample, base, top, Math.max(1, rows));
        if (innerWall) strips.push(innerWall);
      }
      const shape = String(tags['roof:shape'] || '');
      const area = Math.abs(signedArea(outer));
      const pitched = !holes.length && top >= 5 && area >= 48 && shape !== 'flat' && shape !== 'skillion' && convexOpen(outer);
      const roofTarget = styleName
        ? styledParts[styleName].roofs
        : taggedRoof
          ? extraBucket(extraRoofs, taggedRoof)
          : roofBuckets[roofIndex];
      if (pitched) {
        const rise = Math.min(4.6, Math.max(1.6, Math.sqrt(area) * 0.22));
        const hip = pyramidRoof(outer, sample, top, rise);
        if (hip) roofTarget.push(geometryFromParts([hip]));
      } else {
        const roof = triangulate(outer, holes, 0, 1);
        if (roof) {
          const p = roof.positions;
          for (let i = 0; i < p.length; i += 3) p[i + 1] = sample(p[i], p[i + 2]) + top + 0.35;
          roofTarget.push(geometryFromParts([roof]));
        }
      }
      const walls = geometryFromParts(strips);
      if (walls) {
        if (styleName) styledParts[styleName].walls.push(walls);
        else if (taggedWall) extraBucket(extraWalls, taggedWall).push(walls);
        else {
          const bucket = rows > 0 ? wallBuckets[wallIndex].windows : wallBuckets[wallIndex].plain;
          bucket.push(walls);
        }
      }
      const door = doorStrip(outer, sample, base, top, streetEdge(outer, carriageways));
      if (door) doorParts.push(door);
      const closedOuter = outer.concat([outer[0]]);
      const closedHoles = holes.map((hole) => hole.concat([hole[0]]));
      const bounds = polygonBounds([closedOuter, ...closedHoles]);
      blockers.push({
        outer: closedOuter,
        holes: closedHoles,
        top,
        blocksWalk: true,
        blocksCamera: true,
        ...bounds,
      });
      if (styleName && FACADE[styleName]?.tower && area > 18) {
        const [tx, tz] = towerPoint(outer);
        towers.push({ x: tx, z: tz, y: sample(tx, tz), top, area, tower: FACADE[styleName].tower });
      }
      if (name) {
        const [cx, cz] = ringCentroid(outer);
        const area = Math.abs(signedArea(outer));
        const prev = buildingLabels.get(name);
        if (!prev || area > prev.area) {
          buildingLabels.set(name, { area, x: cx, z: cz, y: sample(cx, cz) + top + 2.4 });
        }
      }
      placed = true;
    });
    if (placed) stats.buildings += 1;
    else stats.skippedBuildings += 1;
    if (stats.buildings > 0 && stats.buildings % 40 === 0) {
      await tick('buildings', stats.buildings, (buildings.features || []).length);
    }
  }

  stats.roads = roads.stats.chains;
  stats.sidewalks = roads.stats.sidewalkRuns;
  for (const label of roads.labels) rememberLine(streetLabels, label.name, label.pts, sample, 4.2);

  const basins = [];
  const riverHeights = [];
  for (const feature of water.features || []) {
    const tags = feature.properties || {};
    if (feature.geometry?.type === 'LineString') {
      const local = projectRing(feature.geometry.coordinates, projector);
      for (const part of clipPolyline(local, ...box)) rememberLine(riverLabels, tags.name, part, sample, 9);
    }
    eachPolygon(feature.geometry, (coords) => {
      if (!coords?.[0]) return;
      const outer = orient(clipPolygon(projectRing(coords[0], projector), ...box), true);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < coords.length; i++) {
        const hole = orient(clipPolygon(projectRing(coords[i], projector), ...box), false);
        if (hole) holes.push(hole);
      }
      const edge = densify(outer.concat([outer[0]]), 8);
      const samples = [];
      for (const p of edge) samples.push(sample(p[0], p[1]));
      samples.sort((a, b) => a - b);
      const level = samples.length ? samples[Math.max(0, Math.floor(samples.length * 0.18))] : 0.8;
      const river = tags.water === 'river' || tags.waterway === 'river' || /Labe|Bílina|Bilina/i.test(tags.name || '');
      if (river) riverHeights.push(level);
      basins.push({ outer, holes, y: level, river, name: tags.name || '' });
      if (river) shoreRings.push(outer);
      if (tags.name && feature.geometry?.type !== 'LineString') {
        rememberLine(riverLabels, tags.name, outer.concat([outer[0]]), sample, 9);
      }
    });
  }
  const riverY = riverHeights.length ? Math.min(...riverHeights) : 0.85;
  const banked = wrapBankSample(sample, basins, riverY);
  const roadSample = (x, z) => {
    const { inside, shore } = shoreDist(x, z, basins, riverY);
    return inside || shore < 22 ? banked(x, z) : sample(x, z);
  };
  drapeFlat(roads.asphalt, roadSample, 0.28, asphaltParts);
  drapeFlat(roads.walk, roadSample, 0.14, walkParts);
  for (const basin of basins) {
    if (basin.river) basin.y = riverY;
    const holes = basin.holes;
    const flat = triangulate(
      densify(basin.outer.concat([basin.outer[0]]), 14).slice(0, -1),
      holes.map((hole) => densify(hole.concat([hole[0]]), 14).slice(0, -1)),
      basin.y,
      1,
    );
    if (flat) {
      const pos = flat.positions;
      for (let i = 1; i < pos.length; i += 3) pos[i] = basin.y;
      const nrm = flat.normals;
      for (let i = 0; i < nrm.length; i += 3) {
        nrm[i] = 0;
        nrm[i + 1] = 1;
        nrm[i + 2] = 0;
      }
      waterParts.push(flat);
      stats.water += 1;
    }
    const closedOuter = basin.outer.concat([basin.outer[0]]);
    const closedHoles = holes.map((hole) => hole.concat([hole[0]]));
    const bounds = polygonBounds([closedOuter, ...closedHoles]);
    blockers.push({
      outer: closedOuter,
      holes: closedHoles,
      top: basin.y,
      blocksWalk: true,
      blocksCamera: false,
      kind: 'water',
      ...bounds,
    });
  }

  const areaLabels = [];
  const [startX, startZ] = data.startHint ? projector.toLocal(data.startHint.lon, data.startHint.lat) : [0, 0];
  for (const feature of data.landuse?.features || []) {
    const tags = feature.properties || {};
    const name = niceName(tags.name);
    if (!PARKISH.has(tags.landuse)) continue;
    let best = null;
    eachPolygon(feature.geometry, (coords) => {
      if (!coords?.[0]) return;
      const outer = orient(clipPolygon(projectRing(coords[0], projector), ...box), true);
      if (!outer) return;
      const area = Math.abs(signedArea(outer));
      if (name && (!best || area > best.area)) {
        const [x, z] = ringCentroid(outer);
        best = { area, x, z, y: sample(x, z) + 8 };
      }
        if (!pointInRing(startX, startZ, outer)) {
        const edge = densify(outer.concat([outer[0]]), 14);
        const flat = triangulate(edge.slice(0, -1), [], 0, 1);
        if (flat) parkParts.push(conformSurface(flat, banked, 0.06));
      }
    });
    if (best) areaLabels.push({ text: name, ...best });
  }

  await tick('merge', 1, 2);
  const group = new THREE.Group();
  group.name = 'city';

  WALLS.forEach((color, index) => {
    const windows = mergeList(wallBuckets[index].windows);
    if (windows) {
      const mesh = new THREE.Mesh(windows, facadeMaterial(color));
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    const plain = mergeList(wallBuckets[index].plain);
    if (plain) group.add(new THREE.Mesh(plain, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  });
  ROOFS.forEach((color, index) => {
    const geometry = mergeList(roofBuckets[index]);
    if (!geometry) return;
    group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  });
  for (const [color, parts] of extraWalls) {
    const geometry = mergeList(parts);
    if (geometry) group.add(new THREE.Mesh(geometry, facadeMaterial(color)));
  }
  for (const [color, parts] of extraRoofs) {
    const geometry = mergeList(parts);
    if (geometry) group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  }
  for (const [name, parts] of Object.entries(styledParts)) {
    const style = FACADE[name];
    const walls = mergeList(parts.walls);
    if (walls) group.add(new THREE.Mesh(walls, styledFacade(style, name)));
    const roofs = mergeList(parts.roofs);
    if (roofs) group.add(new THREE.Mesh(roofs, new THREE.MeshLambertMaterial({ color: style.roof, side: THREE.DoubleSide })));
  }
  const keptTowers = [];
  for (const tower of towers.sort((a, b) => b.area - a.area)) {
    if (keptTowers.some((kept) => Math.hypot(kept.x - tower.x, kept.z - tower.z) < 16)) continue;
    keptTowers.push(tower);
    const spire = tower.tower === 'spire';
    const brick = tower.tower === 'brick';
    const width = spire ? 3.6 : brick ? 5.4 : 4.6;
    const height = tower.top + (spire ? 26 : brick ? 18 : 15);
    const shaftColor = brick ? 0x7a342c : 0xe4d6c2;
    const capColor = brick ? 0x3c2826 : 0x5e3832;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), new THREE.MeshLambertMaterial({ color: shaftColor }));
    shaft.position.set(tower.x, tower.y + height / 2, tower.z);
    const capH = spire ? 12 : 5.2;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(width * (spire ? 0.62 : 0.78), capH, 4), new THREE.MeshLambertMaterial({ color: capColor }));
    cap.position.set(tower.x, tower.y + height + capH / 2, tower.z);
    cap.rotation.y = Math.PI / 4;
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.04, 0.45, width * 1.04),
      new THREE.MeshLambertMaterial({ color: brick ? 0x2c1c1a : 0x4a4038 }),
    );
    band.position.set(tower.x, tower.y + height * 0.72, tower.z);
    group.add(shaft, cap, band);
  }
  addShores(group, shoreRings, sample, box, riverY);
  const doors = geometryFromParts(doorParts);
  if (doors) {
    group.add(new THREE.Mesh(doors, new THREE.MeshLambertMaterial({ color: 0x7a4e32, side: THREE.DoubleSide })));
  }

  const parks = geometryFromParts(parkParts);
  if (parks) {
    const parkMesh = new THREE.Mesh(
      parks,
      new THREE.MeshLambertMaterial({ color: 0x63a84a, side: THREE.FrontSide }),
    );
    parkMesh.name = 'parks';
    group.add(parkMesh);
  }
  const walkMesh = geometryFromParts(walkParts);
  if (walkMesh) {
    group.add(
      new THREE.Mesh(
        walkMesh,
        new THREE.MeshLambertMaterial({
          color: 0xf4ecdf,
          side: THREE.FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      ),
    );
  }
  const asphalt = geometryFromParts(asphaltParts);
  if (asphalt) {
    const asphaltMesh = new THREE.Mesh(asphalt, asphaltMaterial(data.asphaltMap));
    asphaltMesh.name = 'asphalt';
    group.add(asphaltMesh);
  }
  const waterMesh = geometryFromParts(waterParts);
  let waterMaterial = null;
  if (waterMesh) {
    waterMaterial = new THREE.MeshPhongMaterial({
      color: 0x1a6d88,
      specular: 0xb7dbe6,
      shininess: 18,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uNight = { value: 0 };
      waterMaterial.userData.shader = shader;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform float uTime;\nuniform float uNight;')
        .replace(
          '#include <lights_phong_fragment>',
          `#include <lights_phong_fragment>
          float spark = 0.5 + 0.5 * sin(vWorld.x * 0.07 + vWorld.z * 0.05 + uTime * 0.55);
          spark *= 0.5 + 0.5 * sin(vWorld.x * 0.028 - vWorld.z * 0.04);
          reflectedLight.indirectSpecular += vec3(0.07, 0.11, 0.13) * spark * (0.16 + uNight * 0.5);`,
        );
    };
    waterMaterial.customProgramCacheKey = () => 'usti-water-flat-v1';
    const waterObject = new THREE.Mesh(waterMesh, waterMaterial);
    waterObject.name = 'water';
    waterObject.renderOrder = 0;
    waterObject.userData.noShadow = true;
    group.add(waterObject);
  }

  const labelPoints = [];
  const textures = new Map();
  const place = (text, x, y, z, kind = 'place') => {
    if (x < projector.minX + 2 || x > projector.maxX - 2 || z < projector.minZ + 2 || z > projector.maxZ - 2) return;
    stats.labels += 1;
    labelPoints.push({ text, x, y, z, kind });
    if (typeof document === 'undefined') return;
    let map = textures.get(text);
    if (!map) {
      map = labelTexture(text);
      textures.set(text, map);
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, fog: false }),
    );
    sprite.position.set(x, y, z);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 10;
    sprite.userData.aspect = map.userData.aspect;
    sprite.userData.text = text;
    sprite.scale.set(map.userData.aspect * 4, 4, 1);
    group.add(sprite);
  };

  await tick('trees', 1, 1);
  const trees = addTrees(group, data, projector, sample, carriageways, blockers);
  stats.trees = trees.count;
  const cafe = addCafeGarden(group, sample, projector);
  if (cafe) place(cafe.name, cafe.x, cafe.y, cafe.z);

  for (const [text, point] of streetLabels) place(text, point.x, point.y, point.z, 'street');
  for (const [text, point] of riverLabels) place(text, point.x, point.y, point.z);
  for (const point of areaLabels) place(point.text, point.x, point.y, point.z);
  for (const [text, point] of buildingLabels) place(text, point.x, point.y, point.z);

  const collision = makeCollision(blockers, projector);
  const start = findStart(highways, collision, projector, data.startHint);
  const labels = group.children.filter((child) => child.isSprite);
  return { group, collision, start, stats, labels, labelPoints, trees, waterMaterial, waterY: riverY, basins, heroes };
}

function makeCollision(blockers, projector) {
  const cell = 42;
  const grid = new Map();
  blockers.forEach((poly, index) => {
    const minIx = Math.floor(poly.minX / cell);
    const maxIx = Math.floor(poly.maxX / cell);
    const minIz = Math.floor(poly.minZ / cell);
    const maxIz = Math.floor(poly.maxZ / cell);
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iz = minIz; iz <= maxIz; iz++) {
        const key = `${ix},${iz}`;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(index);
      }
    }
  });
  return { blockers, cell, grid, projector, decks: [], rails: [] };
}

export function addBlocker(collision, poly) {
  if (!collision || !poly) return;
  const index = collision.blockers.length;
  collision.blockers.push(poly);
  const { cell, grid } = collision;
  const minIx = Math.floor(poly.minX / cell);
  const maxIx = Math.floor(poly.maxX / cell);
  const minIz = Math.floor(poly.minZ / cell);
  const maxIz = Math.floor(poly.maxZ / cell);
  for (let ix = minIx; ix <= maxIx; ix++) {
    for (let iz = minIz; iz <= maxIz; iz++) {
      const key = `${ix},${iz}`;
      let list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(index);
    }
  }
}

function polysNear(collision, x, z, pad) {
  const { cell, grid, blockers } = collision;
  const minIx = Math.floor((x - pad) / cell);
  const maxIx = Math.floor((x + pad) / cell);
  const minIz = Math.floor((z - pad) / cell);
  const maxIz = Math.floor((z + pad) / cell);
  const seen = new Set();
  const found = [];
  for (let ix = minIx; ix <= maxIx; ix++) {
    for (let iz = minIz; iz <= maxIz; iz++) {
      const list = grid.get(`${ix},${iz}`);
      if (!list) continue;
      for (const index of list) {
        if (seen.has(index)) continue;
        seen.add(index);
        found.push(blockers[index]);
      }
    }
  }
  return found;
}

function hitsPoly(x, z, radius, poly) {
  if (x + radius < poly.minX || x - radius > poly.maxX || z + radius < poly.minZ || z - radius > poly.maxZ) return false;
  const inOuter = pointInRing(x, z, poly.outer);
  let inHole = false;
  for (const hole of poly.holes) {
    if (pointInRing(x, z, hole)) {
      inHole = true;
      break;
    }
  }
  if (inOuter && !inHole) return true;
  const rings = [poly.outer, ...poly.holes];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      if (distPointSeg(x, z, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]) < radius) return true;
    }
  }
  return false;
}

export function walkBlocked(collision, x, z, radius) {
  const { projector } = collision;
  if (x < projector.minX + radius || x > projector.maxX - radius || z < projector.minZ + radius || z > projector.maxZ - radius) {
    return true;
  }
  const deck = onDeck(collision.decks, x, z, radius);
  for (const poly of polysNear(collision, x, z, radius + 2)) {
    if (!poly.blocksWalk) continue;
    if (deck && (poly.kind === 'water' || poly.kind === 'track')) continue;
    if (hitsPoly(x, z, radius, poly)) return true;
  }
  if (!deck) {
    for (const poly of collision.rails || []) {
      if (poly.kind === 'track' && hitsPoly(x, z, radius, poly)) return true;
    }
  } else {
    for (const poly of collision.rails || []) {
      if (poly.kind === 'rail' && hitsPoly(x, z, 0.12, poly)) return true;
    }
  }
  return false;
}

export function walkHeight(collision, x, z, ground) {
  if (!collision) return ground;
  const deck = onDeck(collision.decks, x, z, 0.45);
  return deck ? Math.max(ground, deck.y) : ground;
}

function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = distPointSeg(x, z, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

export function bankHeight(rawY, x, z, basins, riverY) {
  if (!basins?.length) return rawY;
  let inside = false;
  let shore = Infinity;
  for (const basin of basins) {
    const hit = pointInRing(x, z, basin.outer);
    let hole = false;
    for (const ring of basin.holes || []) {
      if (pointInRing(x, z, ring)) hole = true;
    }
    if (hit && !hole) inside = true;
    const d = distToRing(x, z, basin.outer.concat([basin.outer[0]]));
    if (d < shore) shore = d;
  }
  if (inside) return Math.min(rawY, riverY - 0.9);
  if (shore < 12) return Math.min(rawY, riverY + 0.18 + shore * 0.12);
  if (shore < 28) return Math.min(rawY, riverY + 1.62 + (shore - 12) * 0.16);
  return rawY;
}

export function wrapBankSample(sample, basins, riverY) {
  return (x, z) => bankHeight(sample(x, z), x, z, basins, riverY);
}

function shoreDist(x, z, basins, riverY) {
  let inside = false;
  let shore = Infinity;
  for (const basin of basins || []) {
    const hit = pointInRing(x, z, basin.outer);
    let hole = false;
    for (const ring of basin.holes || []) {
      if (pointInRing(x, z, ring)) hole = true;
    }
    if (hit && !hole) inside = true;
    const d = distToRing(x, z, basin.outer.concat([basin.outer[0]]));
    if (d < shore) shore = d;
  }
  return { inside, shore };
}

export function sinkGround(geometry, basins, riverY, decks = []) {
  if (!geometry?.attributes?.position || !basins?.length) return;
  const pos = geometry.attributes.position;
  const y0 = riverY ?? Math.min(...basins.map((b) => b.y));
  const cell = 10;
  const wet = new Map();
  const wetKey = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const markWet = (x, z) => {
    const k = wetKey(x, z);
    let list = wet.get(k);
    if (!list) {
      list = [];
      wet.set(k, list);
    }
    list.push(x, z);
  };
  for (const basin of basins) {
    const ring = basin.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / 5));
      for (let s = 0; s <= n; s++) markWet(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n);
    }
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let y = bankHeight(pos.getY(i), x, z, basins, y0);
    const { inside, shore } = shoreDist(x, z, basins, y0);
    for (const deck of decks) {
      if (!deck.walk) continue;
      if (x < deck.minX - 28 || x > deck.maxX + 28 || z < deck.minZ - 28 || z > deck.maxZ + 28) continue;
      const on = pointInRing(x, z, deck.outer);
      const edge = distToRing(x, z, deck.outer);
      if (on || edge < 24) {
        y = Math.min(y, y0 - 0.45);
      }
    }
    pos.setY(i, y);
    if (inside || y <= y0 + 0.85 || shore < 5) markWet(x, z);
  }
  const wetDist = (x, z) => {
    let best = Infinity;
    const ix = Math.floor(x / cell);
    const iz = Math.floor(z / cell);
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const list = wet.get(`${ix + dx},${iz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const d = Math.hypot(x - list[i], z - list[i + 1]);
          if (d < best) best = d;
        }
      }
    }
    return best;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const d = wetDist(x, z);
    let y = pos.getY(i);
    if (d < 12) y = Math.min(y, y0 + 0.18 + d * 0.12);
    else if (d < 50) y = Math.min(y, y0 + 1.62 + (d - 12) * 0.05);
    pos.setY(i, y);
  }
  const index = geometry.index;
  if (index) {
    const neigh = Array.from({ length: pos.count }, () => []);
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      neigh[a].push(b, c);
      neigh[b].push(a, c);
      neigh[c].push(a, b);
    }
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        let y = pos.getY(i);
        if (y <= y0 + 1.8) continue;
        if (wetDist(x, z) > 48 && shoreDist(x, z, basins, y0).shore > 48) continue;
        let cap = y;
        for (const j of neigh[i]) {
          const yj = pos.getY(j);
          if (yj > y0 + 6.5) continue;
          const dist = Math.hypot(x - pos.getX(j), z - pos.getZ(j)) || 1;
          cap = Math.min(cap, yj + dist * 0.08);
        }
        if (cap < y) pos.setY(i, cap);
      }
    }
  }
  if (index) {
    for (let t = 0; t < index.count; t += 3) {
      const i0 = index.getX(t);
      const i1 = index.getX(t + 1);
      const i2 = index.getX(t + 2);
      const ax = pos.getX(i0);
      const ay = pos.getY(i0);
      const az = pos.getZ(i0);
      const bx = pos.getX(i1);
      const by = pos.getY(i1);
      const bz = pos.getZ(i1);
      const cx = pos.getX(i2);
      const cy = pos.getY(i2);
      const cz = pos.getZ(i2);
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const ny = uz * vx - ux * vz;
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      if (ny / len > 0.93) continue;
      const low = Math.min(ay, by, cy);
      if (low > y0 + 14) continue;
      const mx = (ax + bx + cx) / 3;
      const mz = (az + bz + cz) / 3;
      const { inside, shore } = shoreDist(mx, mz, basins, y0);
      const dWet = wetDist(mx, mz);
      const nearWater = inside || shore < 48 || dWet < 44 || low < y0 + 3.2;
      if (!nearWater) continue;
      const cap = y0 + (inside ? -0.4 : 0.28 + Math.min(Math.min(shore, dWet), 22) * 0.09);
      const next = Math.min(low + 0.18, cap);
      pos.setY(i0, Math.min(ay, next));
      pos.setY(i1, Math.min(by, next));
      pos.setY(i2, Math.min(cy, next));
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

function segIntersect(x1, z1, x2, z2, x3, z3, x4, z4) {
  const d = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / d;
  const u = ((x1 - x3) * (z1 - z2) - (z1 - z3) * (x1 - x2)) / d;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}

export function cameraDistance(collision, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.05) return len;
  let best = len;
  const steps = Math.max(1, Math.ceil(len / collision.cell));
  const seen = new Set();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    for (const poly of polysNear(collision, x, z, 1)) {
      if (!poly.blocksCamera || seen.has(poly)) continue;
      seen.add(poly);
      const rings = [poly.outer, ...poly.holes];
      for (const ring of rings) {
        for (let k = 0; k < ring.length - 1; k++) {
          const hit = segIntersect(x0, z0, x1, z1, ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]);
          if (hit != null) best = Math.min(best, hit * len);
        }
      }
    }
  }
  return best;
}

function findStart(highways, collision, projector, hint) {
  const hx = hint ? projector.toLocal(hint.lon, hint.lat)[0] : 0;
  const hz = hint ? projector.toLocal(hint.lon, hint.lat)[1] : 0;
  const radius = 0.55;
  const free = (x, z) => !walkBlocked(collision, x, z, radius);

  const candidates = [];
  for (const feature of highways.features || []) {
    const tags = feature.properties || {};
    if (feature.geometry?.type !== 'LineString') continue;
    const pref = startPreference(tags.highway);
    if (pref > 10) continue;
    const coords = feature.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = projector.toLocal(coords[i][0], coords[i][1]);
      const b = projector.toLocal(coords[i + 1][0], coords[i + 1][1]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2) continue;
      const steps = Math.max(1, Math.floor(len / 8));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const dist = Math.hypot(x - hx, z - hz);
        if (dist > 200) continue;
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        candidates.push({
          x,
          z,
          dx,
          dz,
          score: dist + pref * 14,
          name: tags.name || '',
          highway: tags.highway,
        });
      }
    }
  }
  candidates.sort((p, q) => p.score - q.score);

  const yawFrom = (dx, dz) => Math.atan2(-dx, -dz);
  const finish = (x, z, dx, dz, name) => {
    const [lon, lat] = projector.toLonLat(x, z);
    const label = name || hint?.name || 'centrum';
    return { x, y: 0, z, yaw: yawFrom(dx || 0, dz || 1), label, lon, lat, inside: walkBlocked(collision, x, z, 0.35) };
  };

  if (free(hx, hz)) {
    const near = candidates[0];
    return finish(hx, hz, near?.dx ?? 0, near?.dz ?? 1, hint?.name || near?.name);
  }

  for (const candidate of candidates) {
    if (free(candidate.x, candidate.z)) return finish(candidate.x, candidate.z, candidate.dx, candidate.dz, candidate.name || hint?.name);
    const len = Math.hypot(candidate.dx, candidate.dz) || 1;
    const px = -candidate.dz / len;
    const pz = candidate.dx / len;
    for (const side of [2.2, -2.2, 3.6, -3.6]) {
      const x = candidate.x + px * side;
      const z = candidate.z + pz * side;
      if (free(x, z)) return finish(x, z, candidate.dx, candidate.dz, candidate.name || hint?.name);
    }
  }

  for (let ring = 3; ring < 280; ring += 3) {
    for (let a = 0; a < 20; a++) {
      const x = hx + Math.cos((a / 20) * Math.PI * 2) * ring;
      const z = hz + Math.sin((a / 20) * Math.PI * 2) * ring;
      if (free(x, z)) return finish(x, z, 0, 1, hint?.name || 'centrum');
    }
  }
  return finish(hx, hz, 0, 1, hint?.name || 'centrum');
}
