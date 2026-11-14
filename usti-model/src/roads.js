import { clipPolyline, distPointSeg, roadWidth } from './geom.js';

const JOIN_TOL = 2.4;
const STITCH_MAX = 16;
const QUAY_STITCH_MAX = 36;
const SIDEWALK = 1.65;
const QUAY_NAME = /nábřež|přístav|předmost|labsk|bílinsk|bilinsk|hraž/i;
const HERO_BRIDGE = /Mariánský most|Most Dr\.?\s*E\.?\s*Beneše/i;
const WALK_WIDTH = {
  footway: 2.2,
  path: 1.8,
  steps: 1.5,
  pedestrian: 8,
  living_street: 5.2,
};
const ORDINARY = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'road', 'busway']);

function hypot(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
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

function kindOf(key) {
  if (key === 'pedestrian' || key === 'living_street') return 'pave';
  if (WALK_WIDTH[key]) return 'walk';
  if (roadWidth(key)) return 'asphalt';
  return null;
}

function lengthOf(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += hypot(pts[i - 1], pts[i]);
  return len;
}

function sameClass(a, b) {
  const na = String(a).replace(/_link$/, '');
  const nb = String(b).replace(/_link$/, '');
  return na === nb || String(a).endsWith('_link') || String(b).endsWith('_link');
}

function prepareSegments(features, projector) {
  const box = [projector.minX, projector.minZ, projector.maxX, projector.maxZ];
  const segments = [];
  for (const feature of features || []) {
    if (feature.geometry?.type !== 'LineString') continue;
    const tags = feature.properties || {};
    const key = String(tags.highway || '').replace(/_link$/, '');
    const kind = kindOf(key);
    if (!kind) continue;
    const local = feature.geometry.coordinates.map(([lon, lat]) => projector.toLocal(lon, lat));
    let full = 0;
    for (let i = 1; i < local.length; i++) full += hypot(local[i - 1], local[i]);
    if (tags.bridge === 'yes' && HERO_BRIDGE.test(String(tags.name || '')) && full > 70) continue;
    let half = (WALK_WIDTH[key] || roadWidth(tags.highway) || 0) / 2;
    // A long pedestrian way is a square, not a street. The old 34 m ribbon
    // painted Mírové náměstí as a solid sand field over the orthophoto.
    if (key === 'pedestrian' && full > 90) half = 3.4;
    if (!(half > 0.15)) continue;
    const roundabout = tags.junction === 'roundabout';
    let left = kind === 'asphalt' && sideOn(tags, 'left', key);
    let right = kind === 'asphalt' && sideOn(tags, 'right', key);
    if (roundabout) {
      left = false;
      right = false;
    }
    const name = String(tags.name || '').trim();
    for (const part of clipPolyline(local, ...box)) {
      if (part.length < 2) continue;
      let pts = part.map((p) => [p[0], p[1]]);
      let closed = false;
      if (pts.length > 3 && hypot(pts[0], pts[pts.length - 1]) < 0.8) {
        closed = true;
        pts = pts.slice(0, -1);
      }
      const cleaned = [];
      for (const p of pts) {
        if (!cleaned.length || hypot(p, cleaned[cleaned.length - 1]) > 0.35) cleaned.push(p);
      }
      if (cleaned.length < (closed ? 3 : 2)) continue;
      const spans = cleaned.length - (closed ? 0 : 1);
      segments.push({
        pts: cleaned,
        closed,
        name,
        key,
        kind,
        footway: String(tags.footway || ''),
        roundabout,
        half: Array(spans).fill(half),
        left: Array(spans).fill(left),
        right: Array(spans).fill(right),
      });
    }
  }
  return segments;
}

function clusterEnds(segments, tolerance) {
  const ends = [];
  segments.forEach((seg, i) => {
    ends.push({ i, end: 0, p: seg.pts[0] });
    if (!seg.closed) ends.push({ i, end: 1, p: seg.pts[seg.pts.length - 1] });
  });
  const parent = ends.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const uni = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  const cell = tolerance;
  const grid = new Map();
  const gk = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  ends.forEach((e, idx) => {
    const k = gk(e.p);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(idx);
  });
  for (let a = 0; a < ends.length; a++) {
    const ix = Math.floor(ends[a].p[0] / cell);
    const iz = Math.floor(ends[a].p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const b of grid.get(`${ix + dx},${iz + dz}`) || []) {
          if (b <= a) continue;
          if (hypot(ends[a].p, ends[b].p) <= tolerance) uni(a, b);
        }
      }
    }
  }
  const groups = new Map();
  ends.forEach((e, idx) => {
    const root = find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ ...e, idx });
  });
  return { ends, groups };
}

function awayDir(seg, end) {
  const pts = seg.pts;
  const a = end === 0 ? pts[0] : pts[pts.length - 1];
  let b = end === 0 ? pts[Math.min(1, pts.length - 1)] : pts[Math.max(0, pts.length - 2)];
  if (end === 0) {
    for (let k = 1; k < pts.length; k++) {
      if (hypot(pts[k], a) > 0.8) {
        b = pts[k];
        break;
      }
    }
  } else {
    for (let k = pts.length - 2; k >= 0; k--) {
      if (hypot(pts[k], a) > 0.8) {
        b = pts[k];
        break;
      }
    }
  }
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}

function canJoin(s1, s2, dot, nodeDegree) {
  if (s1.kind !== s2.kind || s1.closed || s2.closed) return false;
  if (Boolean(s1.roundabout) !== Boolean(s2.roundabout)) return false;
  if (s1.roundabout && s2.roundabout) return dot < 0.8;
  const n1 = s1.name;
  const n2 = s2.name;
  if (n1 && n2 && n1 !== n2) return false;
  if (n1 && n2) return dot < 0.45;
  if (s1.kind === 'walk' && nodeDegree <= 2) return dot < 0.55;
  if (!sameClass(s1.key, s2.key)) return false;
  if (nodeDegree <= 2) return dot < 0.2;
  return dot < -0.84;
}

function quayName(name) {
  return QUAY_NAME.test(name || '');
}

function quayFamily(name) {
  return quayName(name) || HERO_BRIDGE.test(name || '');
}

function stitchRoadGaps(segments) {
  const ends = [];
  segments.forEach((seg, i) => {
    if (seg.closed || seg.kind !== 'asphalt') return;
    ends.push({ i, end: 0, p: seg.pts[0], name: seg.name, key: seg.key });
    ends.push({ i, end: 1, p: seg.pts[seg.pts.length - 1], name: seg.name, key: seg.key });
  });
  const cands = [];
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      const A = ends[a];
      const B = ends[b];
      if (A.i === B.i) continue;
      const same = Boolean(A.name && A.name === B.name);
      const family = quayFamily(A.name) && quayFamily(B.name);
      if (!same && !family) continue;
      const d = hypot(A.p, B.p);
      const maxD = family || quayFamily(A.name) || quayFamily(B.name) ? QUAY_STITCH_MAX : STITCH_MAX;
      if (d <= JOIN_TOL + 0.15 || d > maxD) continue;
      const d1 = awayDir(segments[A.i], A.end);
      const d2 = awayDir(segments[B.i], B.end);
      const vx = B.p[0] - A.p[0];
      const vz = B.p[1] - A.p[1];
      const vl = Math.hypot(vx, vz) || 1;
      const ux = vx / vl;
      const uz = vz / vl;
      if (-d1[0] * ux - d1[1] * uz < 0.08) continue;
      if (d2[0] * ux + d2[1] * uz < 0.08) continue;
      cands.push({ A, B, d });
    }
  }
  cands.sort((x, y) => x.d - y.d);
  const used = new Set();
  for (const cand of cands) {
    const ka = `${cand.A.i}:${cand.A.end}`;
    const kb = `${cand.B.i}:${cand.B.end}`;
    if (used.has(ka) || used.has(kb)) continue;
    used.add(ka);
    used.add(kb);
    const segA = segments[cand.A.i];
    const segB = segments[cand.B.i];
    const h = Math.max(spanHalf(segA, cand.A.end), spanHalf(segB, cand.B.end));
    segments.push({
      pts: [cand.A.p, cand.B.p],
      closed: false,
      name: cand.A.name || cand.B.name,
      key: cand.A.key,
      kind: 'asphalt',
      footway: '',
      roundabout: false,
      half: [h],
      left: [Boolean(spanFlag(segA, cand.A.end, 'left') && spanFlag(segB, cand.B.end, 'left'))],
      right: [Boolean(spanFlag(segA, cand.A.end, 'right') && spanFlag(segB, cand.B.end, 'right'))],
    });
  }
}

function joinSegments(segments) {
  const { groups } = clusterEnds(segments, JOIN_TOL);
  const partner = new Map();
  for (const group of groups.values()) {
    const uniq = [];
    const seen = new Set();
    for (const arm of group) {
      if (seen.has(arm.i)) continue;
      seen.add(arm.i);
      uniq.push(arm);
    }
    const degree = uniq.length;
    const cands = [];
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const A = group[a];
        const B = group[b];
        if (A.i === B.i) continue;
        const s1 = segments[A.i];
        const s2 = segments[B.i];
        const d1 = awayDir(s1, A.end);
        const d2 = awayDir(s2, B.end);
        const dot = d1[0] * d2[0] + d1[1] * d2[1];
        if (!canJoin(s1, s2, dot, degree)) continue;
        const named = Boolean(s1.name && s2.name && s1.name === s2.name);
        cands.push({ A, B, dot, named });
      }
    }
    cands.sort((p, q) => (p.named === q.named ? p.dot - q.dot : p.named ? -1 : 1));
    const taken = new Set();
    for (const cand of cands) {
      const ka = `${cand.A.i}:${cand.A.end}`;
      const kb = `${cand.B.i}:${cand.B.end}`;
      if (taken.has(ka) || taken.has(kb)) continue;
      partner.set(ka, kb);
      partner.set(kb, ka);
      taken.add(ka);
      taken.add(kb);
    }
  }

  function orient(seg, fromEnd) {
    const pts = seg.pts.map((p) => [p[0], p[1]]);
    const half = seg.half.slice();
    const left = seg.left.slice();
    const right = seg.right.slice();
    if (fromEnd === 0) return { pts, half, left, right };
    pts.reverse();
    half.reverse();
    return { pts, half, left: right.slice().reverse(), right: left.slice().reverse() };
  }

  function append(out, piece) {
    if (!out.pts.length) {
      out.pts = piece.pts;
      out.half = piece.half;
      out.left = piece.left;
      out.right = piece.right;
      return;
    }
    const gap = hypot(out.pts[out.pts.length - 1], piece.pts[0]);
    if (gap >= 0.05) {
      out.pts.push(piece.pts[0]);
      const h = Math.max(out.half[out.half.length - 1] ?? piece.half[0] ?? 1, piece.half[0] ?? 1);
      out.half.push(h);
      out.left.push(Boolean(out.left[out.left.length - 1] && piece.left[0]));
      out.right.push(Boolean(out.right[out.right.length - 1] && piece.right[0]));
    }
    for (let i = 1; i < piece.pts.length; i++) {
      out.pts.push(piece.pts[i]);
      out.half.push(piece.half[i - 1]);
      out.left.push(piece.left[i - 1]);
      out.right.push(piece.right[i - 1]);
    }
  }

    const chains = [];
    const visited = new Set();
    for (let i = 0; i < segments.length; i++) {
      if (visited.has(i)) continue;
      let seg = i;
      let end = 0;
      const seen = new Set();
      if (!segments[i].closed) {
        while (partner.has(`${seg}:${end}`) && !seen.has(`${seg}:${end}`)) {
          seen.add(`${seg}:${end}`);
          const [ns, ne] = partner.get(`${seg}:${end}`).split(':').map(Number);
          seg = ns;
          end = ne ^ 1;
        }
      }
      const firstSeg = seg;
      let looped = false;
      const chain = {
        pts: [],
        half: [],
        left: [],
        right: [],
        name: '',
        nameLen: 0,
        kind: segments[seg].kind,
        closed: segments[seg].closed,
        roundabout: Boolean(segments[seg].roundabout),
      };
      let guard = 0;
      while (seg != null && !visited.has(seg) && guard < segments.length + 2) {
        guard += 1;
        visited.add(seg);
        const src = segments[seg];
        append(chain, orient(src, end));
        if (src.name) {
          const len = lengthOf(src.pts);
          if (len >= chain.nameLen) {
            chain.name = src.name;
            chain.nameLen = len;
          }
        }
        if (src.roundabout) chain.roundabout = true;
        if (src.closed) break;
        const link = partner.get(`${seg}:${end ^ 1}`);
        if (!link) break;
        const [ns, ne] = link.split(':').map(Number);
        if (visited.has(ns)) {
          if (ns === firstSeg) {
            chain.closed = true;
            looped = true;
          }
          break;
        }
        seg = ns;
        end = ne;
      }
      if (looped && chain.pts.length > 2 && hypot(chain.pts[0], chain.pts[chain.pts.length - 1]) <= JOIN_TOL + 0.3) {
        chain.pts.pop();
      }
      const spanOk = chain.closed ? chain.half.length === chain.pts.length : chain.half.length === chain.pts.length - 1;
      if (chain.pts.length >= 2 && spanOk) chains.push(chain);
    }
    return { chains, joins: partner.size / 2 };
}

function simplifyChain(chain) {
  if (chain.pts.length < 3 || chain.closed) return chain;
  const keep = [0];
  for (let i = 1; i < chain.pts.length - 1; i++) {
    const a = chain.pts[keep[keep.length - 1]];
    const b = chain.pts[i];
    const c = chain.pts[i + 1];
    const ab = hypot(a, b);
    const bc = hypot(b, c);
    if (ab < 0.2) continue;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const cross = Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / len;
    const flagsDiffer = chain.left[i - 1] !== chain.left[i] || chain.right[i - 1] !== chain.right[i];
    const widthJump = Math.abs(chain.half[i - 1] - chain.half[i]) > 0.4;
    if (cross > 0.28 || flagsDiffer || widthJump || bc < 0.2) keep.push(i);
  }
  keep.push(chain.pts.length - 1);
  if (keep.length === chain.pts.length) return chain;
  const pts = keep.map((i) => chain.pts[i]);
  const half = [];
  const left = [];
  const right = [];
  for (let k = 0; k < keep.length - 1; k++) {
    const from = keep[k];
    const to = keep[k + 1];
    let h = 0;
    let l = false;
    let r = false;
    for (let s = from; s < to; s++) {
      h = Math.max(h, chain.half[s]);
      l = l || chain.left[s];
      r = r || chain.right[s];
    }
    half.push(h || chain.half[from]);
    left.push(l);
    right.push(r);
  }
  return { ...chain, pts, half, left, right };
}

function densifyChain(chain, step) {
  const src = chain.pts;
  const spanCount = chain.half.length;
  const pts = [src[0]];
  const half = [];
  const left = [];
  const right = [];
  for (let i = 0; i < spanCount; i++) {
    const a = src[i % src.length];
    const b = src[(i + 1) % src.length];
    const len = hypot(a, b);
    const pieces = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= pieces; k++) {
      const closing = chain.closed && i === spanCount - 1 && k === pieces;
      if (!closing) {
        const t = k / pieces;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      half.push(chain.half[i]);
      left.push(Boolean(chain.left[i]));
      right.push(Boolean(chain.right[i]));
    }
  }
  return { ...chain, pts, half, left, right };
}

function vertexHalf(half, i, count, closed) {
  if (!half.length) return 1;
  if (closed) return Math.max(half[(i - 1 + half.length) % half.length], half[i % half.length]);
  if (i <= 0) return half[0];
  if (i >= count - 1) return half[half.length - 1];
  return Math.max(half[i - 1], half[i]);
}

function emitOffset(pts, distInnerAt, distOuterAt, closed, bucket) {
  const n = pts.length;
  if (n < 2) return;
  const segCount = closed ? n : n - 1;
  const dir = (i) => {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [dx / len, dz / len];
  };
  const dirs = [];
  for (let i = 0; i < segCount; i++) dirs.push(dir(i));
  const leftN = (d) => [-d[1], d[0]];
  const samples = [];
  const push = (i, nx, nz, scale) => {
    const di = distInnerAt(i) * scale;
    const dout = distOuterAt(i) * scale;
    samples.push({
      inner: [pts[i][0] + nx * di, pts[i][1] + nz * di],
      outer: [pts[i][0] + nx * dout, pts[i][1] + nz * dout],
    });
  };
  for (let i = 0; i < n; i++) {
    const prev = i === 0 && !closed ? null : dirs[(i - 1 + segCount) % segCount];
    const next = i === n - 1 && !closed ? null : dirs[i % segCount];
    if (!prev || !next) {
      const d = next || prev;
      const normal = leftN(d);
      push(i, normal[0], normal[1], 1);
      continue;
    }
    const dot = prev[0] * next[0] + prev[1] * next[1];
    const na = leftN(prev);
    const nb = leftN(next);
    if (dot < 0.5) {
      push(i, na[0], na[1], 1);
      push(i, nb[0], nb[1], 1);
      continue;
    }
    let nx = na[0] + nb[0];
    let nz = na[1] + nb[1];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const along = Math.max(0.42, nx * na[0] + nz * na[1]);
    push(i, nx, nz, Math.min(1.65, 1 / along));
  }
  const area = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i].inner;
    const b = samples[i].outer;
    const c = samples[i + 1].outer;
    const d = samples[i + 1].inner;
    const a1 = area(a, b, c);
    const a2 = area(a, c, d);
    if (a1 * a2 < 0) continue;
    if (Math.abs(a1) + Math.abs(a2) < 0.05) continue;
    bucket.push(a[0], a[1], b[0], b[1], c[0], c[1], a[0], a[1], c[0], c[1], d[0], d[1]);
  }
  if (closed && samples.length > 2) {
    const a = samples[samples.length - 1].inner;
    const b = samples[samples.length - 1].outer;
    const c = samples[0].outer;
    const d = samples[0].inner;
    const a1 = area(a, b, c);
    const a2 = area(a, c, d);
    if (a1 * a2 >= 0 && Math.abs(a1) + Math.abs(a2) >= 0.05) {
      bucket.push(a[0], a[1], b[0], b[1], c[0], c[1], a[0], a[1], c[0], c[1], d[0], d[1]);
    }
  }
}

function emitRoad(chain, bucket) {
  const count = chain.pts.length;
  const hAt = chain.pts.map((_, i) => vertexHalf(chain.half, i, count, chain.closed));
  const maxH = hAt.reduce((m, h) => Math.max(m, h), 0);
  const strips = Math.max(1, Math.ceil((maxH * 2) / 2.6));
  for (let s = 0; s < strips; s++) {
    const t0 = -1 + (2 * s) / strips;
    const t1 = -1 + (2 * (s + 1)) / strips;
    emitOffset(
      chain.pts,
      (i) => hAt[i] * t0,
      (i) => hAt[i] * t1,
      chain.closed,
      bucket,
    );
  }
}

function emitClosedSide(chain, side, bucket) {
  const inner = [];
  const outer = [];
  for (let i = 0; i < chain.pts.length; i++) {
    const h = vertexHalf(chain.half, i, chain.pts.length, true);
    if (side === 'left') {
      inner.push(h);
      outer.push(h + SIDEWALK);
    } else {
      inner.push(-(h + SIDEWALK));
      outer.push(-h);
    }
  }
  emitOffset(chain.pts, (i) => inner[i], (i) => outer[i], true, bucket);
}

function emitSides(chain, bucket) {
  for (const side of ['left', 'right']) {
    const flags = chain[side];
    if (chain.closed && flags.length === chain.pts.length && flags.every(Boolean)) {
      emitClosedSide(chain, side, bucket);
      continue;
    }
    let start = null;
    const flush = (end) => {
      if (start == null) return;
      const sub = chain.pts.slice(start, end + 1);
      const inner = [];
      const outer = [];
      for (let i = start; i <= end; i++) {
        const h = vertexHalf(chain.half, i, chain.pts.length, false);
        if (side === 'left') {
          inner.push(h);
          outer.push(h + SIDEWALK);
        } else {
          inner.push(-(h + SIDEWALK));
          outer.push(-h);
        }
      }
      emitOffset(sub, (i) => inner[i], (i) => outer[i], false, bucket);
      start = null;
    };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i]) {
        if (start == null) start = i;
      } else if (start != null) flush(i);
    }
    if (start != null) flush(flags.length);
  }
}

function lineCross(p, d, q, e) {
  const det = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(det) < 1e-6) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / det;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

function fan(hull, bucket) {
  for (let i = 1; i < hull.length - 1; i++) {
    bucket.push(hull[0][0], hull[0][1], hull[i][0], hull[i][1], hull[i + 1][0], hull[i + 1][1]);
  }
}

function convexHull(points) {
  const uniq = [];
  const seen = new Set();
  for (const p of points) {
    const key = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  if (uniq.length < 3) return null;
  uniq.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : null;
}

function spanHalf(seg, end) {
  if (end === 0) return seg.half[0];
  return seg.half[seg.half.length - 1];
}

function spanFlag(seg, end, side) {
  const flags = seg[side];
  if (end === 0) return Boolean(flags[0]);
  return Boolean(flags[flags.length - 1]);
}

function junctionPatches(segments) {
  const { groups } = clusterEnds(segments, JOIN_TOL);
  const asphalt = [];
  const walk = [];
  const pave = [];
  for (const group of groups.values()) {
    const uniq = [];
    const seen = new Set();
    for (const arm of group) {
      if (seen.has(arm.i)) continue;
      seen.add(arm.i);
      uniq.push(arm);
    }
    if (uniq.length < 2) continue;
    if (uniq.every((arm) => quayFamily(segments[arm.i].name))) continue;
    let cx = 0;
    let cz = 0;
    for (const arm of uniq) {
      const p = arm.end === 0 ? segments[arm.i].pts[0] : segments[arm.i].pts[segments[arm.i].pts.length - 1];
      cx += p[0];
      cz += p[1];
    }
    cx /= uniq.length;
    cz /= uniq.length;
    const arms = [];
    for (const arm of uniq) {
      const seg = segments[arm.i];
      const away = awayDir(seg, arm.end);
      const leftN = [-away[1], away[0]];
      const rightN = [away[1], -away[0]];
      const half = spanHalf(seg, arm.end);
      arms.push({
        kind: seg.kind,
        away,
        angle: Math.atan2(away[1], away[0]),
        half,
        left: seg.kind === 'asphalt' && spanFlag(seg, arm.end, 'left'),
        right: seg.kind === 'asphalt' && spanFlag(seg, arm.end, 'right'),
        leftN,
        rightN,
      });
    }
    const shoulders = [];
    for (const arm of arms) {
      if (arm.kind === 'walk') continue;
      shoulders.push([cx + arm.leftN[0] * arm.half, cz + arm.leftN[1] * arm.half]);
      shoulders.push([cx + arm.rightN[0] * arm.half, cz + arm.rightN[1] * arm.half]);
    }
    const hull = convexHull(shoulders);
    if (hull) {
      let area = 0;
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (Math.abs(area) > 0.8 && Math.abs(area) < 900) {
        const bucket = arms.some((arm) => arm.kind === 'asphalt') ? asphalt : pave;
        fan(hull, bucket);
      }
    }
    const cornerArms = arms.filter((arm) => arm.kind === 'asphalt').sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < cornerArms.length; i++) {
      const A = cornerArms[i];
      const B = cornerArms[(i + 1) % cornerArms.length];
      let sweep = B.angle - A.angle;
      if (sweep <= 0) sweep += Math.PI * 2;
      if (sweep < 0.4 || sweep > Math.PI * 0.92) continue;
      if (!A.left || !B.right) continue;
      const curbA = [cx + A.leftN[0] * A.half, cz + A.leftN[1] * A.half];
      const outerA = [cx + A.leftN[0] * (A.half + SIDEWALK), cz + A.leftN[1] * (A.half + SIDEWALK)];
      const curbB = [cx + B.rightN[0] * B.half, cz + B.rightN[1] * B.half];
      const outerB = [cx + B.rightN[0] * (B.half + SIDEWALK), cz + B.rightN[1] * (B.half + SIDEWALK)];
      const c1 = lineCross(curbA, A.away, curbB, B.away);
      const c2 = lineCross(curbA, A.away, outerB, B.away);
      const c3 = lineCross(outerA, A.away, outerB, B.away);
      const c4 = lineCross(outerA, A.away, curbB, B.away);
      if (![c1, c2, c3, c4].every(Boolean)) continue;
      const far = [c1, c2, c3, c4].some((p) => Math.hypot(p[0] - cx, p[1] - cz) > 22);
      if (far) continue;
      walk.push(c1[0], c1[1], c2[0], c2[1], c3[0], c3[1], c1[0], c1[1], c3[0], c3[1], c4[0], c4[1]);
    }
    const walkArms = arms.filter((arm) => arm.kind === 'walk');
    if (walkArms.length >= 2) {
      const pts = [];
      for (const arm of walkArms) {
        pts.push([cx + arm.leftN[0] * arm.half, cz + arm.leftN[1] * arm.half]);
        pts.push([cx + arm.rightN[0] * arm.half, cz + arm.rightN[1] * arm.half]);
      }
      const walkHull = convexHull(pts);
      if (walkHull) {
        let area = 0;
        for (let i = 0; i < walkHull.length; i++) {
          const a = walkHull[i];
          const b = walkHull[(i + 1) % walkHull.length];
          area += a[0] * b[1] - b[0] * a[1];
        }
        if (Math.abs(area) > 0.4 && Math.abs(area) < 80) fan(walkHull, walk);
      }
    }
  }
  return { asphalt, walk, pave };
}

function buildFootGrid(segments) {
  const cell = 10;
  const grid = new Map();
  segments.forEach((seg) => {
    if (seg.kind !== 'walk' || seg.footway === 'crossing' || seg.footway === 'traffic_island') return;
    const spans = seg.closed ? seg.pts.length : seg.pts.length - 1;
    for (let i = 0; i < spans; i++) {
      const a = seg.pts[i];
      const b = seg.pts[(i + 1) % seg.pts.length];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const key = `${Math.floor(mx / cell)},${Math.floor(mz / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ a, b });
    }
  });
  return { grid, cell };
}

function nearSeparateWalk(gridInfo, x, z, dx, dz) {
  const { grid, cell } = gridInfo;
  const ix = Math.floor(x / cell);
  const iz = Math.floor(z / cell);
  const roadLen = Math.hypot(dx, dz) || 1;
  const rx = dx / roadLen;
  const rz = dz / roadLen;
  for (let gx = ix - 1; gx <= ix + 1; gx++) {
    for (let gz = iz - 1; gz <= iz + 1; gz++) {
      for (const seg of grid.get(`${gx},${gz}`) || []) {
        const hit = distPointSeg(x, z, seg.a[0], seg.a[1], seg.b[0], seg.b[1]);
        if (hit > 3.3) continue;
        const sx = seg.b[0] - seg.a[0];
        const sz = seg.b[1] - seg.a[1];
        const sl = Math.hypot(sx, sz) || 1;
        if (Math.abs((sx / sl) * rx + (sz / sl) * rz) < 0.72) continue;
        return true;
      }
    }
  }
  return false;
}

function suppressSeparateSides(segments) {
  const gridInfo = buildFootGrid(segments);
  for (const seg of segments) {
    if (seg.kind !== 'asphalt') continue;
    const spans = seg.closed ? seg.pts.length : seg.pts.length - 1;
    for (let i = 0; i < spans; i++) {
      const a = seg.pts[i];
      const b = seg.pts[(i + 1) % seg.pts.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const h = seg.half[i] + 0.45;
      if (seg.left[i] && nearSeparateWalk(gridInfo, mx + nx * h, mz + nz * h, dx, dz)) seg.left[i] = false;
      if (seg.right[i] && nearSeparateWalk(gridInfo, mx - nx * h, mz - nz * h, dx, dz)) seg.right[i] = false;
    }
  }
}

function dirOf(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = hypot(a, b) || 1;
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
}

function distPointPoly(x, z, pts) {
  let best = Infinity;
  let cx = pts[0][0];
  let cz = pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const az = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dz = pts[i][1] - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      cx = px;
      cz = pz;
    }
  }
  return { d: best, x: cx, z: cz };
}

function absorbTwin(keep, drop, median, shift) {
  let sx = 0;
  let sz = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(drop.pts.length / 8));
  for (let i = 0; i < drop.pts.length; i += step) {
    const hit = distPointPoly(drop.pts[i][0], drop.pts[i][1], keep.pts);
    sx += drop.pts[i][0] - hit.x;
    sz += drop.pts[i][1] - hit.z;
    n += 1;
  }
  if (!n) return;
  if (keep._baseHalf == null) keep._baseHalf = Math.max(...keep.half, 3);
  keep._cover = Math.max(keep._cover || 0, median);
  if (shift) {
    const ox = (sx / n) * 0.5;
    const oz = (sz / n) * 0.5;
    keep.pts = keep.pts.map((p) => [p[0] + ox, p[1] + oz]);
  }
  const extra = median * 0.5 + Math.max(...drop.half, 0);
  const half = Math.min(12, Math.max(...keep.half, extra, keep._baseHalf));
  keep.half = keep.half.map(() => half);
}

function centroidOf(pts) {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    z += p[1];
  }
  return [x / pts.length, z / pts.length];
}

function diskRadiusOf(chain) {
  if (!chain?.pts?.length) return 0;
  const c = centroidOf(chain.pts);
  let r = 0;
  for (const p of chain.pts) r = Math.max(r, hypot(p, c));
  return r + Math.max(...(chain.half || [0]), 0);
}

function collapseParallelAsphalt(chains) {
  const asphalt = [];
  const rest = [];
  for (const chain of chains) {
    if (chain.kind === 'asphalt' && !quayFamily(chain.name)) asphalt.push(chain);
    else rest.push(chain);
  }
  asphalt.sort((a, b) => lengthOf(b.pts) - lengthOf(a.pts));
  const keep = [];
  for (const chain of asphalt) {
    const d = dirOf(chain.pts);
    const twin = keep.find((other) => {
      if (chain.closed || other.closed) {
        if (!chain.closed || !other.closed) return false;
        return hypot(centroidOf(chain.pts), centroidOf(other.pts)) < 18;
      }
      const same = Boolean(chain.name && other.name && chain.name === other.name);
      const o = dirOf(other.pts);
      const parallel = Math.abs(d[0] * o[0] + d[1] * o[1]);
      let acc = 0;
      const step = Math.max(1, Math.floor(chain.pts.length / 8));
      let n = 0;
      for (let i = 0; i < chain.pts.length; i += step) {
        acc += distPointPoly(chain.pts[i][0], chain.pts[i][1], other.pts).d;
        n += 1;
      }
      if (!n) return false;
      const median = acc / n;
      const cover = Math.max(...chain.half, 0) + Math.max(...other.half, 0) + 1.8;
      if (median < cover) return true;
      if (median < 6.8) return true;
      if (parallel < 0.55) return false;
      return same ? median < 11 : median < 8.4;
    });
    if (!twin) {
      keep.push({
        ...chain,
        pts: chain.pts.map((p) => [p[0], p[1]]),
        half: chain.half.slice(),
        left: chain.left.slice(),
        right: chain.right.slice(),
        diskR: chain.closed || chain.roundabout ? diskRadiusOf(chain) : 0,
      });
      continue;
    }
    let acc = 0;
    const step = Math.max(1, Math.floor(chain.pts.length / 8));
    let n = 0;
    for (let i = 0; i < chain.pts.length; i += step) {
      acc += distPointPoly(chain.pts[i][0], chain.pts[i][1], twin.pts).d;
      n += 1;
    }
    if (chain.closed && twin.closed) {
      twin.diskR = Math.max(twin.diskR || 0, diskRadiusOf(twin), diskRadiusOf(chain));
      continue;
    }
    absorbTwin(twin, chain, n ? acc / n : 0, false);
  }
  return rest.concat(keep);
}

export function buildRoadGeometry(features, projector) {
  const segments = prepareSegments(features, projector);
  suppressSeparateSides(segments);
  stitchRoadGaps(segments);
  const joined = joinSegments(segments);
  const chains = collapseParallelAsphalt(joined.chains);
  const joins = joined.joins;
  const asphalt = [];
  const walk = [];
  const pave = [];
  const labels = [];
  const centerlines = [];
  const quayChains = [];
  let sidewalkRuns = 0;
  for (const raw of chains) {
    const simple = simplifyChain(raw);
    const chain = densifyChain(simple, 3);
    if (chain.kind === 'asphalt') {
      if (quayFamily(chain.name)) {
        quayChains.push(simple);
        centerlines.push({ pts: chain.pts, half: chain.half, closed: chain.closed, quay: true });
      } else {
        centerlines.push({
          pts: chain.pts,
          half: chain.half,
          closed: chain.closed,
          roundabout: Boolean(chain.roundabout),
          diskR: chain.diskR || 0,
        });
        if (!chain.closed && !chain.roundabout) {
          const walkBefore = walk.length;
          emitSides(chain, walk);
          if (walk.length > walkBefore) sidewalkRuns += 1;
        }
      }
    } else if (chain.kind === 'pave') {
      emitRoad(chain, pave);
      centerlines.push({ pts: chain.pts, half: chain.half, closed: chain.closed });
    } else {
      // Independent footways drape as leftover slabs on the hillside.
      // Sidewalks stay on emitSides along the carriageway.
    }
    if (chain.name) labels.push({ name: chain.name, pts: simple.pts });
  }
  const patches = junctionPatches(segments);
  walk.push(...patches.walk);
  pave.push(...patches.pave);
  return {
    asphalt,
    walk,
    pave,
    labels,
    centerlines,
    quayChains,
    stats: {
      segments: segments.length,
      chains: chains.length,
      joins,
      sidewalkRuns,
    },
  };
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

function raiseQuayY(pts, sample, waterY) {
  const floor = (waterY ?? 0.9) + 2.05;
  const raw = pts.map((p) => Math.max(sample(p[0], p[1]) + 0.36, floor));
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + hypot(pts[i - 1], pts[i]));
  return raw.map((y, i) => {
    let high = y;
    for (let j = 0; j < pts.length; j++) {
      if (Math.abs(acc[j] - acc[i]) <= 14) high = Math.max(high, raw[j]);
    }
    return high;
  });
}

function weldQuayChains(chains) {
  const pool = chains
    .filter((c) => c.pts?.length >= 2)
    .map((c) => ({
      pts: c.pts.map((p) => [p[0], p[1]]),
      half: c.half.slice(),
      left: (c.left || []).slice(),
      right: (c.right || []).slice(),
      name: c.name,
      kind: 'asphalt',
      closed: false,
    }));
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
          { mine: cur.pts[cur.pts.length - 1], theirs: other.pts[0], rev: false, front: false },
          { mine: cur.pts[cur.pts.length - 1], theirs: other.pts[other.pts.length - 1], rev: true, front: false },
          { mine: cur.pts[0], theirs: other.pts[other.pts.length - 1], rev: false, front: true },
          { mine: cur.pts[0], theirs: other.pts[0], rev: true, front: true },
        ];
        for (const pair of pairs) {
          const d = hypot(pair.mine, pair.theirs);
          if (d < 0.8 || d > 40) continue;
          if (!best || d < best.d) best = { j, d, ...pair, other };
        }
      }
      if (!best) break;
      used.add(best.j);
      const addPts = best.rev ? [...best.other.pts].reverse() : best.other.pts.slice();
      const addHalf = best.rev ? [...best.other.half].reverse() : best.other.half.slice();
      const gapH = Math.max(4.2, cur.half[0] || 4.2, cur.half[cur.half.length - 1] || 4.2, addHalf[0] || 4.2);
      if (best.front) {
        cur.pts = addPts.concat(cur.pts);
        cur.half = addHalf.concat([gapH], cur.half);
      } else {
        cur.pts = cur.pts.concat(addPts);
        cur.half = cur.half.concat([gapH], addHalf);
      }
      grew = true;
    }
    out.push(cur);
  }
  return out;
}

export function drapeQuayChains(chains, sample, waterY) {
  const positions = [];
  const normals = [];
  const centerlines = [];
  for (const raw of weldQuayChains(chains)) {
    const chain = densifyChain(
      {
        ...raw,
        left: raw.half.map(() => false),
        right: raw.half.map(() => false),
        closed: false,
      },
      3.2,
    );
    if (chain.pts.length < 2) continue;
    const ys = raiseQuayY(chain.pts, sample, waterY);
    const n = chain.pts.length;
    for (let i = 0; i < n - 1; i++) {
      const a = chain.pts[i];
      const b = chain.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const ha = Math.max(4.2, vertexHalf(chain.half, i, n, false));
      const hb = Math.max(4.2, vertexHalf(chain.half, i + 1, n, false));
      const a0 = [a[0] + nx * ha, ys[i], a[1] + nz * ha];
      const a1 = [a[0] - nx * ha, ys[i], a[1] - nz * ha];
      const b0 = [b[0] + nx * hb, ys[i + 1], b[1] + nz * hb];
      const b1 = [b[0] - nx * hb, ys[i + 1], b[1] - nz * hb];
      pushTri(positions, normals, a0, b0, b1);
      pushTri(positions, normals, a0, b1, a1);
    }
    centerlines.push({ pts: chain.pts, half: chain.half, closed: false, ys });
  }
  return { positions, normals, centerlines };
}

export function makeLineIndex(lines, cell = 16) {
  const grid = new Map();
  const segs = [];
  for (const line of lines || []) {
    const spans = line.closed ? line.pts.length : line.pts.length - 1;
    for (let i = 0; i < spans; i++) {
      const a = line.pts[i];
      const b = line.pts[(i + 1) % line.pts.length];
      const half = line.half?.[i] ?? line.half?.[0] ?? 3;
      const rec = { a, b, half };
      segs.push(rec);
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const key = `${Math.floor(mx / cell)},${Math.floor(mz / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(rec);
    }
  }
  return {
    segs,
    query(x, z, maxDist) {
      const ix = Math.floor(x / cell);
      const iz = Math.floor(z / cell);
      const reach = Math.ceil(maxDist / cell);
      let best = null;
      for (let gx = ix - reach; gx <= ix + reach; gx++) {
        for (let gz = iz - reach; gz <= iz + reach; gz++) {
          for (const seg of grid.get(`${gx},${gz}`) || []) {
            const dx = seg.b[0] - seg.a[0];
            const dz = seg.b[1] - seg.a[1];
            const len2 = dx * dx + dz * dz;
            let t = len2 > 0 ? ((x - seg.a[0]) * dx + (z - seg.a[1]) * dz) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const px = seg.a[0] + dx * t;
            const pz = seg.a[1] + dz * t;
            const dist = Math.hypot(x - px, z - pz);
            if (dist > maxDist) continue;
            if (!best || dist < best.dist) best = { dist, x: px, z: pz, half: seg.half };
          }
        }
      }
      return best;
    },
  };
}
