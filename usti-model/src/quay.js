import * as THREE from 'three';

const HALF = 5.7;
const PARALLEL_M = 14;
const WELD_MAX = 42;

function hypot(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function lengthOf(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += hypot(pts[i - 1], pts[i]);
  return n;
}

function dirOf(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = hypot(a, b) || 1;
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
}

function distPointPoly(x, z, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const az = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dz = pts[i][1] - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

function collapseParallel(chains) {
  const sorted = chains
    .filter((c) => c.pts?.length >= 2)
    .map((c) => ({ ...c, pts: c.pts.map((p) => [p[0], p[1]]), _len: lengthOf(c.pts) }))
    .sort((a, b) => b._len - a._len);
  const keep = [];
  for (const chain of sorted) {
    const d = dirOf(chain.pts);
    const twin = keep.find((other) => {
      const o = dirOf(other.pts);
      if (Math.abs(d[0] * o[0] + d[1] * o[1]) < 0.7) return false;
      let acc = 0;
      const step = Math.max(1, Math.floor(chain.pts.length / 8));
      let n = 0;
      for (let i = 0; i < chain.pts.length; i += step) {
        acc += distPointPoly(chain.pts[i][0], chain.pts[i][1], other.pts);
        n += 1;
      }
      return n && acc / n < PARALLEL_M;
    });
    if (!twin) keep.push(chain);
  }
  return keep;
}

function weld(chains) {
  const pool = collapseParallel(chains).map((c) => ({ pts: c.pts.slice(), name: c.name }));
  const used = new Set();
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const cur = pool[i];
    let grew = true;
    while (grew) {
      grew = false;
      let best = null;
      for (let j = 0; j < pool.length; j++) {
        if (used.has(j)) continue;
        const other = pool[j];
        const pairs = [
          { mine: cur.pts[cur.pts.length - 1], theirs: other.pts[0], minePrev: cur.pts[cur.pts.length - 2] || cur.pts[0], theirsNext: other.pts[1] || other.pts[0], rev: false, front: false },
          { mine: cur.pts[cur.pts.length - 1], theirs: other.pts[other.pts.length - 1], minePrev: cur.pts[cur.pts.length - 2] || cur.pts[0], theirsNext: other.pts[other.pts.length - 2] || other.pts[0], rev: true, front: false },
          { mine: cur.pts[0], theirs: other.pts[other.pts.length - 1], minePrev: cur.pts[1] || cur.pts[0], theirsNext: other.pts[other.pts.length - 2] || other.pts[0], rev: false, front: true },
          { mine: cur.pts[0], theirs: other.pts[0], minePrev: cur.pts[1] || cur.pts[0], theirsNext: other.pts[1] || other.pts[0], rev: true, front: true },
        ];
        for (const pair of pairs) {
          const d = hypot(pair.mine, pair.theirs);
          if (d > WELD_MAX) continue;
          const vx = pair.theirs[0] - pair.mine[0];
          const vz = pair.theirs[1] - pair.mine[1];
          const vl = Math.hypot(vx, vz) || 1;
          const along = [(pair.mine[0] - pair.minePrev[0]), (pair.mine[1] - pair.minePrev[1])];
          const al = Math.hypot(along[0], along[1]) || 1;
          const into = (along[0] / al) * (vx / vl) + (along[1] / al) * (vz / vl);
          if (d > 1.2 && into < 0.25) continue;
          if (!best || d < best.d) best = { j, d, ...pair, other };
        }
      }
      if (!best) break;
      used.add(best.j);
      const add = best.rev ? [...best.other.pts].reverse() : best.other.pts.slice();
      cur.pts = best.front ? add.concat(cur.pts) : cur.pts.concat(add);
      grew = true;
    }
    out.push(cur);
  }
  return out;
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = hypot(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function extendToDecks(chains, decks) {
  for (const deck of decks || []) {
    if (deck.name !== 'marian' && deck.name !== 'benes') continue;
    for (const end of deck.ends || []) {
      let best = null;
      for (const chain of chains) {
        const last = chain.pts.length - 1;
        for (const idx of [0, last]) {
          const p = chain.pts[idx];
          const d = Math.hypot(p[0] - end.x, p[1] - end.z);
          if (!best || d < best.d) best = { chain, idx, d };
        }
      }
      if (!best || best.d < 0.8 || best.d > 55) continue;
      const onto = [end.x - end.tx * 5, end.z - end.tz * 5];
      const tip = [end.x, end.z];
      if (best.idx === 0) best.chain.pts.unshift(onto, tip);
      else best.chain.pts.push(tip, onto);
    }
  }
}

function heights(pts, sample, waterY, decks) {
  const floor = (waterY ?? 0.9) + 2.2;
  const raw = pts.map((p) => Math.max(sample(p[0], p[1]) + 0.38, floor));
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + hypot(pts[i - 1], pts[i]));
  const ys = raw.map((y, i) => {
    let high = y;
    for (let j = 0; j < pts.length; j++) {
      if (Math.abs(acc[j] - acc[i]) <= 16) high = Math.max(high, raw[j]);
    }
    return high;
  });
  for (let i = 0; i < pts.length; i++) {
    let nearest = null;
    for (const deck of decks || []) {
      if (deck.name !== 'marian' && deck.name !== 'benes') continue;
      for (const end of deck.ends || []) {
        const d = Math.hypot(pts[i][0] - end.x, pts[i][1] - end.z);
        if (d > 26) continue;
        if (!nearest || d < nearest.d) nearest = { d, y: end.y };
      }
    }
    if (!nearest) continue;
    if (nearest.d < 8) {
      ys[i] = nearest.y;
      continue;
    }
    const t = Math.min(1, (nearest.d - 8) / 16);
    const ease = (1 - t) * (1 - t);
    ys[i] = nearest.y * ease + ys[i] * (1 - ease);
  }
  return ys;
}

function pushTri(positions, normals, a, b, c) {
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
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
    positions.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
  } else {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  for (let k = 0; k < 3; k++) normals.push(nx, ny, nz);
}

function apron(positions, normals, decks) {
  for (const deck of decks || []) {
    if (deck.name !== 'marian' && deck.name !== 'benes') continue;
    for (const end of deck.ends || []) {
      const across = Math.max(HALF, end.half || HALF) + 0.35;
      const y = end.y;
      const back = 4;
      const fwd = 12;
      const ax = end.x - end.tx * back;
      const az = end.z - end.tz * back;
      const bx = end.x + end.tx * fwd;
      const bz = end.z + end.tz * fwd;
      const nx = end.nx || 0;
      const nz = end.nz || 0;
      const a0 = [ax + nx * across, y, az + nz * across];
      const a1 = [ax - nx * across, y, az - nz * across];
      const b0 = [bx + nx * across, y, bz + nz * across];
      const b1 = [bx - nx * across, y, bz - nz * across];
      pushTri(positions, normals, a0, b0, b1);
      pushTri(positions, normals, a0, b1, a1);
    }
  }
}

export function placeQuayRibbon(group, chains, decks, sample, waterY, material) {
  if (!chains?.length) return { mesh: null };
  const welded = weld(chains);
  extendToDecks(welded, decks);
  const positions = [];
  const normals = [];
  apron(positions, normals, decks);
  for (const raw of welded) {
    const pts = densify(raw.pts, 3);
    if (pts.length < 2) continue;
    const ys = heights(pts, sample, waterY, decks);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const a0 = [a[0] + nx * HALF, ys[i], a[1] + nz * HALF];
      const a1 = [a[0] - nx * HALF, ys[i], a[1] - nz * HALF];
      const b0 = [b[0] + nx * HALF, ys[i + 1], b[1] + nz * HALF];
      const b1 = [b[0] - nx * HALF, ys[i + 1], b[1] - nz * HALF];
      pushTri(positions, normals, a0, b0, b1);
      pushTri(positions, normals, a0, b1, a1);
    }
  }
  if (!positions.length) return { mesh: null };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const mesh = new THREE.Mesh(
    geometry,
    material || new THREE.MeshLambertMaterial({ color: 0x3a414c, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
  );
  mesh.name = 'quay-ribbon';
  mesh.renderOrder = 3;
  mesh.userData.noShadow = true;
  group.add(mesh);
  return { mesh };
}
