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
  roadWidth,
  signedArea,
  startPreference,
} from './geom.js';

const WALLS = [0xf7e7c4, 0xf3d48f, 0xf8f1e2, 0xe8c07a, 0xf6d7b0, 0xf4e0c4, 0xedd0a4, 0xf6efe2, 0xe4c49a, 0xf0c8a4, 0xf8e6d0, 0xe9d2b2];
const ROOFS = [0xd4653a, 0xc4512c, 0xe07040, 0xb8432a, 0xcc5a34, 0xa84830, 0x8d4a3c, 0x5c646c];
const WALK_WIDTH = {
  footway: 2.2,
  path: 1.8,
  steps: 1.5,
  pedestrian: 8,
  living_street: 5.2,
};
const ORDINARY = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'road', 'busway']);
const PARKISH = new Set(['park', 'forest', 'recreation_ground', 'grass', 'village_green', 'meadow', 'garden', 'cemetery']);
const SIDEWALK = 1.65;

function hashId(value) {
  const text = String(value ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
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

function wallStrip(ring, groundAt, base, top) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const span = Math.max(2.4, top - base);
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
      uvs.push(acc, 0, acc + seg, 0, acc + seg, span, acc, 0, acc + seg, span, acc, span);
      acc += seg;
    }
  }
  return positions.length ? { positions, normals, uvs } : null;
}

function doorStrip(ring, groundAt, base, top) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (!best || len > best.len) best = { a, b, dx, dz, len };
  }
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
  const geometries = list.filter(Boolean);
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

function cleanLine(points) {
  const out = [];
  for (const p of points || []) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.45) out.push(p);
  }
  return out.length >= 2 ? out : null;
}

function lineDirs(pts) {
  const dirs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dz) || 1;
    dirs.push([dx / len, dz / len]);
  }
  return dirs;
}

function ribbonStations(pts, half) {
  const dirs = lineDirs(pts);
  const left = [];
  const right = [];
  const station = (i, dir, scale = 1) => {
    const nx = -dir[1] * half * scale;
    const nz = dir[0] * half * scale;
    left.push([pts[i][0] + nx, pts[i][1] + nz]);
    right.push([pts[i][0] - nx, pts[i][1] - nz]);
  };
  station(0, dirs[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const d0 = dirs[i - 1];
    const d1 = dirs[i];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (dot < 0.72) {
      station(i, d0);
      station(i, d1);
      continue;
    }
    let nx = -d0[1] - d1[1];
    let nz = d0[0] + d1[0];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const along = Math.max(0.62, nx * -d0[1] + nz * d0[0]);
    station(i, [nz, -nx], Math.min(1.2, 1 / along));
  }
  station(pts.length - 1, dirs[dirs.length - 1]);
  return { left, right };
}

function addRibbon(parts, line, half, sample, lift) {
  if (!(half > 0.15)) return false;
  const pts = densify(cleanLine(line), 5);
  if (!pts || pts.length < 2) return false;
  const { left, right } = ribbonStations(pts, half);
  const positions = [];
  const normals = [];
  for (let i = 0; i < left.length - 1; i++) {
    const quad = [left[i], right[i], right[i + 1], left[i + 1]];
    positions.push(
      quad[0][0], 0, quad[0][1],
      quad[1][0], 0, quad[1][1],
      quad[2][0], 0, quad[2][1],
      quad[0][0], 0, quad[0][1],
      quad[2][0], 0, quad[2][1],
      quad[3][0], 0, quad[3][1],
    );
    for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
  }
  if (!positions.length) return false;
  parts.push(conformSurface({ positions, normals }, sample, lift));
  return true;
}

function offsetLine(points, dist) {
  const pts = cleanLine(points);
  if (!pts) return null;
  const dirs = lineDirs(pts);
  const out = [];
  const push = (i, dir, scale = 1) => {
    out.push([pts[i][0] + -dir[1] * dist * scale, pts[i][1] + dir[0] * dist * scale]);
  };
  push(0, dirs[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const d0 = dirs[i - 1];
    const d1 = dirs[i];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (dot < 0.72) {
      push(i, d0);
      push(i, d1);
      continue;
    }
    let nx = -d0[1] - d1[1];
    let nz = d0[0] + d1[0];
    const len = Math.hypot(nx, nz) || 1;
    push(i, [nz / len, -nx / len], Math.min(1.2, 1 / Math.max(0.62, (nx / len) * -d0[1] + (nz / len) * d0[0])));
  }
  push(pts.length - 1, dirs[dirs.length - 1]);
  return out;
}

function sideOn(tags, side, key) {
  const specific = tags[`sidewalk:${side}`];
  if (specific != null && specific !== '') {
    const value = String(specific);
    return value !== 'no' && value !== 'none' && value !== 'separate';
  }
  if (tags.sidewalk != null && tags.sidewalk !== '') {
    const value = String(tags.sidewalk);
    if (value === 'no' || value === 'none' || value === 'separate') return false;
    if (value === 'both' || value === 'yes') return true;
    return value === side;
  }
  return ORDINARY.has(key);
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

function rememberLine(store, name, part, sample, lift) {
  const text = String(name || '').trim();
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
  const family = '"Liberation Sans", "Noto Sans", "DejaVu Sans", sans-serif';
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

function facadeOnBeforeCompile(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vFacadeUv;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = uv;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nvarying vec2 vFacadeUv;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float fx = mod(vFacadeUv.x, 2.75);
      float fy = mod(vFacadeUv.y, 3.0);
      float pane = step(0.58, fx) * step(fx, 2.18) * step(0.95, fy) * step(fy, 2.42);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.18, 0.32, 0.42), pane * 0.78);`,
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
  material.customProgramCacheKey = () => 'usti-facade-v2';
  return material;
}

const CAFE_GARDEN = {
  name: 'C´UP - coffeeup',
  // Northeast facade, in the paved strip between the house and Palachova.
  lon: 14.0274401,
  lat: 50.6657347,
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

export function buildCity(data, projector) {
  const { buildings, highways, water } = data;
  const sample = data.terrain?.sample || (() => 0);
  const wallBuckets = WALLS.map(() => []);
  const roofBuckets = ROOFS.map(() => []);
  const doorParts = [];
  const walkParts = [];
  const paveParts = [];
  const asphaltParts = [];
  const waterParts = [];
  const parkParts = [];
  const blockers = [];
  const buildingLabels = new Map();
  const streetLabels = new Map();
  const riverLabels = new Map();
  const stats = { buildings: 0, skippedBuildings: 0, roads: 0, sidewalks: 0, water: 0, labels: 0 };
  const box = [projector.minX, projector.minZ, projector.maxX, projector.maxZ];

  for (const feature of buildings.features || []) {
    const tags = feature.properties || {};
    const top = buildingHeight(tags);
    const base = buildingBase(tags, top);
    const colorKey = String(tags.osmId ?? tags.name ?? '');
    const wallIndex = hashId(colorKey) % WALLS.length;
    const roofIndex = hashId(`${colorKey}:roof`) % ROOFS.length;
    const name = String(tags.name || '').trim();
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
      const strips = [];
      const outerWall = wallStrip(outer, sample, base, top);
      if (outerWall) strips.push(outerWall);
      for (const hole of holes) {
        const innerWall = wallStrip(hole, sample, base, top);
        if (innerWall) strips.push(innerWall);
      }
      const shape = String(tags['roof:shape'] || '');
      const area = Math.abs(signedArea(outer));
      const pitched = !holes.length && top >= 5 && area >= 48 && shape !== 'flat' && shape !== 'skillion' && convexOpen(outer);
      if (pitched) {
        const rise = Math.min(4.6, Math.max(1.6, Math.sqrt(area) * 0.22));
        const hip = pyramidRoof(outer, sample, top, rise);
        if (hip) roofBuckets[roofIndex].push(geometryFromParts([hip]));
      } else {
        const roof = triangulate(outer, holes, 0, 1);
        if (roof) {
          const p = roof.positions;
          for (let i = 0; i < p.length; i += 3) p[i + 1] = sample(p[i], p[i + 2]) + top + 0.35;
          roofBuckets[roofIndex].push(geometryFromParts([roof]));
        }
      }
      const walls = geometryFromParts(strips);
      if (walls) wallBuckets[wallIndex].push(walls);
      const door = doorStrip(outer, sample, base, top);
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
  }

  for (const feature of highways.features || []) {
    const tags = feature.properties || {};
    if (feature.geometry?.type !== 'LineString') continue;
    const key = String(tags.highway || '').replace(/_link$/, '');
    const local = projectRing(feature.geometry.coordinates, projector);
    const parts = clipPolyline(local, ...box);
    for (const part of parts) {
      rememberLine(streetLabels, tags.name, part, sample, 4.2);
      const walk = WALK_WIDTH[key];
      if (walk) {
        const paving = key === 'pedestrian' || key === 'living_street';
        let half = walk / 2;
        if (key === 'pedestrian') {
          let len = 0;
          for (let i = 1; i < part.length; i++) len += Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
          if (len > 90) half = 17;
        }
        if (addRibbon(paving ? paveParts : walkParts, part, half, sample, paving ? 0.22 : 0.16)) stats.sidewalks += 1;
        continue;
      }
      const width = roadWidth(tags.highway);
      if (!width) continue;
      const left = sideOn(tags, 'left', key);
      const right = sideOn(tags, 'right', key);
      if (left && right) {
        if (addRibbon(walkParts, part, width / 2 + SIDEWALK, sample, 0.12)) stats.sidewalks += 1;
      } else {
        if (left && addRibbon(walkParts, offsetLine(part, width / 2 + SIDEWALK / 2), SIDEWALK / 2, sample, 0.12)) {
          stats.sidewalks += 1;
        }
        if (right && addRibbon(walkParts, offsetLine(part, -(width / 2 + SIDEWALK / 2)), SIDEWALK / 2, sample, 0.12)) {
          stats.sidewalks += 1;
        }
      }
      if (addRibbon(asphaltParts, part, width / 2, sample, 0.28)) stats.roads += 1;
    }
  }

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
      const flat = triangulate(densify(outer.concat([outer[0]]), 12).slice(0, -1), holes.map((hole) => densify(hole.concat([hole[0]]), 12).slice(0, -1)), 0, 1);
      if (flat) {
        waterParts.push(conformSurface(flat, sample, 0.22));
        stats.water += 1;
      }
      if (tags.name && feature.geometry?.type !== 'LineString') {
        rememberLine(riverLabels, tags.name, outer.concat([outer[0]]), sample, 9);
      }
      const closedOuter = outer.concat([outer[0]]);
      const closedHoles = holes.map((hole) => hole.concat([hole[0]]));
      const bounds = polygonBounds([closedOuter, ...closedHoles]);
      blockers.push({
        outer: closedOuter,
        holes: closedHoles,
        top: 0.2,
        blocksWalk: true,
        blocksCamera: false,
        ...bounds,
      });
    });
  }

  const areaLabels = [];
  const [startX, startZ] = data.startHint ? projector.toLocal(data.startHint.lon, data.startHint.lat) : [0, 0];
  for (const feature of data.landuse?.features || []) {
    const tags = feature.properties || {};
    const name = String(tags.name || '').trim();
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
        if (flat) parkParts.push(conformSurface(flat, sample, 0.06));
      }
    });
    if (best) areaLabels.push({ text: name, ...best });
  }

  const group = new THREE.Group();
  group.name = 'city';

  WALLS.forEach((color, index) => {
    const geometry = mergeList(wallBuckets[index]);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, facadeMaterial(color));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  });
  ROOFS.forEach((color, index) => {
    const geometry = mergeList(roofBuckets[index]);
    if (!geometry) return;
    group.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  });
  const doors = geometryFromParts(doorParts);
  if (doors) {
    group.add(new THREE.Mesh(doors, new THREE.MeshLambertMaterial({ color: 0x6a4632, side: THREE.DoubleSide })));
  }

  const parks = geometryFromParts(parkParts);
  if (parks) {
    group.add(
      new THREE.Mesh(
        parks,
        new THREE.MeshLambertMaterial({ color: 0x63a84a, side: THREE.FrontSide }),
      ),
    );
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
  const paving = geometryFromParts(paveParts);
  if (paving) {
    group.add(
      new THREE.Mesh(
        paving,
        new THREE.MeshLambertMaterial({
          color: 0xe2c27a,
          side: THREE.FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      ),
    );
  }
  const asphalt = geometryFromParts(asphaltParts);
  if (asphalt) {
    group.add(
      new THREE.Mesh(
        asphalt,
        new THREE.MeshLambertMaterial({
          color: 0x3a414c,
          side: THREE.FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      ),
    );
  }
  const waterMesh = geometryFromParts(waterParts);
  if (waterMesh) {
    group.add(
      new THREE.Mesh(
        waterMesh,
        new THREE.MeshLambertMaterial({
          color: 0x1b6f90,
          emissive: 0x0b3344,
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.82,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
    );
  }

  const labelPoints = [];
  const textures = new Map();
  const place = (text, x, y, z) => {
    if (x < projector.minX + 2 || x > projector.maxX - 2 || z < projector.minZ + 2 || z > projector.maxZ - 2) return;
    stats.labels += 1;
    labelPoints.push({ text, x, y, z });
    if (typeof document === 'undefined') return;
    let map = textures.get(text);
    if (!map) {
      map = labelTexture(text);
      textures.set(text, map);
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: true, fog: false }),
    );
    sprite.position.set(x, y, z);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 10;
    sprite.userData.aspect = map.userData.aspect;
    sprite.userData.text = text;
    sprite.scale.set(map.userData.aspect * 4, 4, 1);
    group.add(sprite);
  };

  const cafe = addCafeGarden(group, sample, projector);
  if (cafe) place(cafe.name, cafe.x, cafe.y, cafe.z);

  for (const [text, point] of streetLabels) place(text, point.x, point.y, point.z);
  for (const [text, point] of riverLabels) place(text, point.x, point.y, point.z);
  for (const point of areaLabels) place(point.text, point.x, point.y, point.z);
  for (const [text, point] of buildingLabels) place(text, point.x, point.y, point.z);

  const collision = makeCollision(blockers, projector);
  const start = findStart(highways, collision, projector, data.startHint);
  const labels = group.children.filter((child) => child.isSprite);
  return { group, collision, start, stats, labels, labelPoints };
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
  return { blockers, cell, grid, projector };
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
  for (const poly of polysNear(collision, x, z, radius + 2)) {
    if (!poly.blocksWalk) continue;
    if (hitsPoly(x, z, radius, poly)) return true;
  }
  return false;
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
