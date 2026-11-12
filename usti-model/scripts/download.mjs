import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'area.config.json'), 'utf8'));
const bbox = config.bbox;
const dataDir = path.join(root, 'public', 'data');
const UA = 'usti-nad-labem-model/0.1 (local educational 3D city model)';

const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
const themes = [
  ['buildings', `way["building"](${b});relation["building"](${b});`],
  ['highways', `way["highway"](${b});`],
  ['landuse', `way["landuse"](${b});relation["landuse"](${b});`],
  [
    'water',
    `way["natural"="water"](${b});relation["natural"="water"](${b});way["waterway"~"^(riverbank|river|dock)$"](${b});relation["waterway"~"^(riverbank|river)$"](${b});`,
  ],
  [
    'trees',
    `node["natural"="tree"](${b});way["natural"="tree_row"](${b});way["natural"="wood"](${b});relation["natural"="wood"](${b});way["leisure"="park"](${b});relation["leisure"="park"](${b});`,
  ],
  [
    'furniture',
    `node["amenity"="bench"](${b});node["highway"="street_lamp"](${b});node["highway"="bus_stop"](${b});node["amenity"="waste_basket"](${b});node["highway"="crossing"](${b});`,
  ],
  ['routes', `relation["route"="trolleybus"](${b});`],
];

const KEEP = {
  buildings: ['height', 'building:levels', 'building', 'min_height', 'building:min_level', 'roof:shape', 'name'],
  highways: ['highway', 'footway', 'sidewalk', 'sidewalk:left', 'sidewalk:right', 'name', 'junction', 'bridge'],
  landuse: ['landuse', 'leisure', 'natural', 'name'],
  water: ['natural', 'water', 'waterway', 'name'],
  trees: ['natural', 'leisure', 'landuse', 'name'],
  furniture: ['amenity', 'highway', 'name', 'shelter'],
  routes: ['route', 'name', 'ref'],
};

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

function samePt(a, c) {
  return Math.abs(a[0] - c[0]) < 1e-7 && Math.abs(a[1] - c[1]) < 1e-7;
}

function isClosed(coords) {
  return coords.length >= 4 && samePt(coords[0], coords[coords.length - 1]);
}

function closeRing(coords) {
  if (coords.length < 3) return null;
  const ring = coords.slice();
  if (!samePt(ring[0], ring[ring.length - 1])) ring.push(ring[0].slice());
  return ring.length >= 4 ? ring : null;
}

function wayCoords(el) {
  if (!Array.isArray(el.geometry)) return [];
  return el.geometry.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat)).map((p) => [p.lon, p.lat]);
}

function stitch(parts) {
  const open = [];
  const rings = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    if (isClosed(part)) rings.push(part);
    else open.push(part.slice());
  }
  while (open.length) {
    let cur = open.pop();
    let grew = true;
    while (grew && !samePt(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        if (samePt(cur[cur.length - 1], o[0])) {
          cur = cur.concat(o.slice(1));
          open.splice(i, 1);
          grew = true;
          break;
        }
        if (samePt(cur[cur.length - 1], o[o.length - 1])) {
          const rev = o.slice(0, -1).reverse();
          cur = cur.concat(rev);
          open.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (samePt(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function relationPolygons(el) {
  const outers = [];
  const inners = [];
  for (const member of el.members || []) {
    if (member.type && member.type !== 'way') continue;
    const coords = wayCoords(member);
    if (coords.length < 2) continue;
    const role = member.role || 'outer';
    if (role === 'inner') inners.push(coords);
    else outers.push(coords);
  }
  const outerRings = stitch(outers).map(closeRing).filter(Boolean);
  const innerRings = stitch(inners).map(closeRing).filter(Boolean);
  const polys = outerRings.map((outer) => ({ outer, holes: [] }));
  for (const hole of innerRings) {
    const probe = hole[Math.min(1, hole.length - 1)];
    let best = null;
    let bestArea = Infinity;
    for (const poly of polys) {
      if (!pointInRing(probe[0], probe[1], poly.outer)) continue;
      const area = Math.abs(ringArea(poly.outer));
      if (area < bestArea) {
        best = poly;
        bestArea = area;
      }
    }
    if (best) best.holes.push(hole);
  }
  return polys;
}

function propsOf(el, theme) {
  const tags = el.tags || {};
  const allow = KEEP[theme];
  const out = { osmId: el.id };
  if (!allow) {
    for (const [key, value] of Object.entries(tags)) {
      if (value != null && value !== '') out[key] = value;
    }
  } else {
    for (const key of allow) {
      if (tags[key] != null && tags[key] !== '') out[key] = tags[key];
    }
  }
  if (out.name === 'Městský čast Střekov') out.name = 'Městský část Střekov';
  return out;
}

function polygonFeature(el, polygons, theme) {
  if (!polygons.length) return null;
  if (polygons.length === 1) {
    const p = polygons[0];
    return {
      type: 'Feature',
      properties: propsOf(el, theme),
      geometry: { type: 'Polygon', coordinates: [p.outer, ...p.holes] },
    };
  }
  return {
    type: 'Feature',
    properties: propsOf(el, theme),
    geometry: {
      type: 'MultiPolygon',
      coordinates: polygons.map((p) => [p.outer, ...p.holes]),
    },
  };
}

function lineFeature(el, coords, theme) {
  if (coords.length < 2) return null;
  return {
    type: 'Feature',
    properties: propsOf(el, theme),
    geometry: { type: 'LineString', coordinates: coords },
  };
}

function lineMeters(a, b) {
  return Math.hypot((a[0] - b[0]) * 70000, (a[1] - b[1]) * 111320);
}

function stitchLines(lines) {
  const pool = lines.filter((line) => line.length >= 2).map((line) => line.slice());
  if (!pool.length) return [];
  pool.sort((a, b) => b.length - a.length);
  const path = pool.shift();
  let grew = true;
  while (grew && pool.length) {
    grew = false;
    let bestI = -1;
    let bestD = 28;
    let mode = 0;
    const head = path[0];
    const tail = path[path.length - 1];
    for (let i = 0; i < pool.length; i++) {
      const seg = pool[i];
      const options = [
        [lineMeters(tail, seg[0]), 0],
        [lineMeters(tail, seg[seg.length - 1]), 1],
        [lineMeters(head, seg[seg.length - 1]), 2],
        [lineMeters(head, seg[0]), 3],
      ];
      for (const [distance, how] of options) {
        if (distance < bestD) {
          bestD = distance;
          bestI = i;
          mode = how;
        }
      }
    }
    if (bestI < 0) break;
    let seg = pool.splice(bestI, 1)[0];
    if (mode === 1 || mode === 3) seg = seg.slice().reverse();
    if (mode >= 2) path.unshift(...seg.slice(0, -1));
    else path.push(...seg.slice(1));
    grew = true;
  }
  return path;
}

function resampleLine(coords, stepM = 18) {
  if (coords.length < 2) return coords;
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += lineMeters(coords[i - 1], coords[i]);
    if (acc >= stepM) {
      out.push(coords[i]);
      acc = 0;
    }
  }
  const last = coords[coords.length - 1];
  if (lineMeters(out[out.length - 1], last) > 1) out.push(last);
  return out;
}

function convertRoutes(elements) {
  const byRef = new Map();
  let skipped = 0;
  for (const el of elements) {
    if (el.type !== 'relation' || el.tags?.route !== 'trolleybus') {
      skipped += 1;
      continue;
    }
    const lines = [];
    for (const member of el.members || []) {
      const coords = wayCoords(member);
      if (coords.length >= 2) lines.push(coords);
    }
    if (!lines.length) {
      skipped += 1;
      continue;
    }
    const ref = String(el.tags.ref || el.tags.name || el.id);
    const prev = byRef.get(ref);
    if (!prev || lines.length > prev.lines.length) byRef.set(ref, { el, lines });
  }
  const features = [];
  for (const { el, lines } of byRef.values()) {
    const path = resampleLine(stitchLines(lines), 18);
    if (path.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: propsOf(el, 'routes'),
      geometry: { type: 'LineString', coordinates: path },
    });
  }
  return { features, skipped };
}

function convertTheme(name, elements) {
  const features = [];
  const memberWayIds = new Set();
  if (name !== 'highways') {
    for (const el of elements) {
      if (el.type !== 'relation') continue;
      for (const member of el.members || []) {
        if ((member.type === 'way' || !member.type) && member.ref) memberWayIds.add(member.ref);
      }
    }
  }
  let skipped = 0;
  for (const el of elements) {
    const tags = el.tags || {};
    if (name === 'buildings' && el.type === 'way' && memberWayIds.has(el.id) && tags.building) {
      skipped += 1;
      continue;
    }
    if (el.type === 'node') {
      if ((name === 'trees' || name === 'furniture') && Number.isFinite(el.lon) && Number.isFinite(el.lat)) {
        features.push({
          type: 'Feature',
          properties: propsOf(el, name),
          geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
        });
      } else skipped += 1;
      continue;
    }
    if (el.type === 'way') {
      const coords = wayCoords(el);
      const closed = isClosed(coords);
      if (name === 'trees') {
        const feature = tags.natural === 'tree_row' || !closed ? lineFeature(el, coords, name) : polygonFeature(el, [{ outer: coords, holes: [] }], name);
        if (feature) features.push(feature);
        else skipped += 1;
        continue;
      }
      if (name === 'highways') {
        const feature = lineFeature(el, coords, name);
        if (feature) features.push(feature);
        else skipped += 1;
        continue;
      }
      if (name === 'water' && tags.waterway && tags.waterway !== 'riverbank' && !closed) {
        const feature = lineFeature(el, coords, name);
        if (feature) features.push(feature);
        else skipped += 1;
        continue;
      }
      if (!closed) {
        if (name === 'water' && tags.waterway) {
          const feature = lineFeature(el, coords, name);
          if (feature) features.push(feature);
        } else skipped += 1;
        continue;
      }
      const feature = polygonFeature(el, [{ outer: coords, holes: [] }], name);
      if (feature) features.push(feature);
      else skipped += 1;
      continue;
    }
    if (el.type === 'relation') {
      const feature = polygonFeature(el, relationPolygons(el), name);
      if (feature) features.push(feature);
      else skipped += 1;
    }
  }
  return { features, skipped };
}

async function overpass(query) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(120000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${text.slice(0, 180)}`);
        const json = JSON.parse(text);
        if (!json.elements) throw new Error(`${url} missing elements`);
        return { json, url };
      } catch (error) {
        lastError = error;
        console.warn(`Overpass selhal (${url}, pokus ${attempt}): ${error.message}`);
      }
    }
    const wait = 5000 * attempt;
    console.warn(`Čekám ${wait / 1000}s a zkusím Overpass znovu…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw lastError;
}

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('odpověď není JPEG');
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('JPEG bez rozměru');
}

async function downloadOrtho() {
  const lat0 = (bbox.south + bbox.north) / 2;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mLat = 110540;
  const widthM = (bbox.east - bbox.west) * mLon;
  const heightM = (bbox.north - bbox.south) * mLat;
  const attempts = [0.55, 0.75, 1.05];
  let lastError = null;
  for (const mpp of attempts) {
    let widthPx = Math.max(64, Math.round(widthM / mpp));
    let heightPx = Math.max(64, Math.round(heightM / mpp));
    const cap = 4000;
    const scale = Math.min(1, cap / Math.max(widthPx, heightPx));
    widthPx = Math.round(widthPx * scale);
    heightPx = Math.round(heightPx * scale);
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      REQUEST: 'GetMap',
      VERSION: '1.3.0',
      LAYERS: '0',
      STYLES: '',
      CRS: 'EPSG:4326',
      BBOX: `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`,
      WIDTH: String(widthPx),
      HEIGHT: String(heightPx),
      FORMAT: 'image/jpeg',
      TRANSPARENT: 'FALSE',
    });
    const url = `https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?${params}`;
    console.log(`Ortofoto ${widthPx}×${heightPx} px (~${mpp} m/px)…`);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'image/jpeg' },
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error(`WMS HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 40 * 1024 * 1024) throw new Error(`JPEG má ${buf.length} B, limit je 40 MB`);
      const size = jpegSize(buf);
      const file = path.join(dataDir, 'ortho.jpg');
      fs.writeFileSync(file, buf);
      const pxW = (bbox.east - bbox.west) / size.width;
      const pxH = (bbox.north - bbox.south) / size.height;
      const world = [pxW, 0, 0, -pxH, bbox.west + pxW / 2, bbox.north - pxH / 2].join('\n') + '\n';
      fs.writeFileSync(path.join(dataDir, 'ortho.jgw'), world);
      const mobile = writeMobileOrtho(file);
      return {
        url,
        width: size.width,
        height: size.height,
        bytes: buf.length,
        metersPerPixelX: widthM / size.width,
        metersPerPixelY: heightM / size.height,
        mobile,
      };
    } catch (error) {
      lastError = error;
      console.warn(`Ortofoto selhalo: ${error.message}`);
    }
  }
  throw lastError;
}

function writeMobileOrtho(file) {
  const dest = path.join(dataDir, 'ortho-mobile.jpg');
  const result = spawnSync('ffmpeg', ['-y', '-i', file, '-vf', 'scale=2048:-2', '-q:v', '5', dest], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.warn(`Menší ortofoto se nepodařilo vytvořit: ${(result.stderr || '').slice(-240)}`);
    return null;
  }
  const buf = fs.readFileSync(dest);
  const size = jpegSize(buf);
  console.log(`Ortofoto pro slabší zařízení ${size.width}×${size.height} px, ${buf.length} B`);
  return { file: 'ortho-mobile.jpg', width: size.width, height: size.height, bytes: buf.length };
}

function writeTerrainBin(record) {
  const { width, height, elevMin, elevMax, heights } = record;
  const header = 20;
  const buf = Buffer.alloc(header + heights.length * 2);
  buf.write('HDEM', 0, 'ascii');
  buf.writeUInt16LE(width, 4);
  buf.writeUInt16LE(height, 6);
  buf.writeFloatLE(elevMin, 8);
  buf.writeFloatLE(elevMax, 12);
  buf.writeUInt16LE(1, 16);
  buf.writeUInt16LE(0, 18);
  const span = elevMax - elevMin || 1;
  for (let i = 0; i < heights.length; i++) {
    const t = (heights[i] - elevMin) / span;
    const q = Math.max(0, Math.min(65535, Math.round(t * 65535)));
    buf.writeUInt16LE(q, header + i * 2);
  }
  fs.writeFileSync(path.join(dataDir, 'terrain.bin'), buf);
  return buf.length;
}

function tiffValues(view, entry) {
  const { typ, count, val, at } = entry;
  const size = typ === 3 ? 2 : typ === 4 ? 4 : typ === 11 ? 4 : typ === 12 ? 8 : 0;
  if (!size) throw new Error(`Nepodporovaný TIFF typ ${typ}`);
  const start = size * count <= 4 ? at + 8 : val;
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = start + i * size;
    if (typ === 3) out.push(view.getUint16(p, true));
    else if (typ === 4) out.push(view.getUint32(p, true));
    else if (typ === 12) out.push(view.getFloat64(p, true));
    else out.push(view.getFloat32(p, true));
  }
  return out;
}

function readTiledFloat32(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x49 || buf[1] !== 0x49) throw new Error('DMR TIFF není little-endian');
  const ifd = view.getUint32(4, true);
  const n = view.getUint16(ifd, true);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    tags.set(view.getUint16(at, true), {
      typ: view.getUint16(at + 2, true),
      count: view.getUint32(at + 4, true),
      val: view.getUint32(at + 8, true),
      at,
    });
  }
  const width = tiffValues(view, tags.get(256))[0];
  const height = tiffValues(view, tags.get(257))[0];
  const bps = tiffValues(view, tags.get(258))[0];
  const compression = tiffValues(view, tags.get(259))[0];
  if (bps !== 32 || compression !== 1) throw new Error(`DMR TIFF má bps=${bps}, kompresi=${compression}`);
  const tw = tiffValues(view, tags.get(322))[0];
  const th = tiffValues(view, tags.get(323))[0];
  const offsets = tiffValues(view, tags.get(324));
  const counts = tiffValues(view, tags.get(325));
  const tilesX = Math.ceil(width / tw);
  const tilesY = Math.ceil(height / th);
  const vals = new Array(width * height);
  let tile = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const off = offsets[tile];
      const raw = buf.subarray(off, off + counts[tile]);
      const tileView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let row = 0; row < th; row++) {
        const gy = ty * th + row;
        if (gy >= height) break;
        for (let col = 0; col < tw; col++) {
          const gx = tx * tw + col;
          if (gx >= width) continue;
          vals[gy * width + gx] = tileView.getFloat32((row * tw + col) * 4, true);
        }
      }
      tile += 1;
    }
  }
  let geo = null;
  if (tags.get(33550) && tags.get(33922)) {
    const scale = tiffValues(view, tags.get(33550));
    const tie = tiffValues(view, tags.get(33922));
    if (scale[0] > 0 && scale[1] > 0) {
      geo = { scaleX: scale[0], scaleY: scale[1], tieLon: tie[3], tieLat: tie[4] };
    }
  }
  return { width, height, vals, geo };
}

function bilinearGrid(vals, width, height, col, row) {
  const c0 = Math.max(0, Math.min(width - 1, Math.floor(col)));
  const r0 = Math.max(0, Math.min(height - 1, Math.floor(row)));
  const c1 = Math.min(width - 1, c0 + 1);
  const r1 = Math.min(height - 1, r0 + 1);
  const tx = Math.min(1, Math.max(0, col - c0));
  const ty = Math.min(1, Math.max(0, row - r0));
  const at = (r, c) => vals[r * width + c];
  const a = at(r0, c0) * (1 - tx) + at(r0, c1) * tx;
  const b = at(r1, c0) * (1 - tx) + at(r1, c1) * tx;
  return a * (1 - ty) + b * ty;
}

// ArcGIS writes square degrees per pixel, so the TIFF is taller than the
// requested latitude span and its tiepoint sits north of the bbox. Sampling
// the file as if it filled the bbox squeezes outside hills into the city.
function resampleToBbox(grid, box, outW, outH) {
  const { width, height, vals, geo } = grid;
  const heights = new Array(outW * outH);
  for (let r = 0; r < outH; r++) {
    const lat = box.north - ((r + 0.5) / outH) * (box.north - box.south);
    for (let c = 0; c < outW; c++) {
      const lon = box.west + ((c + 0.5) / outW) * (box.east - box.west);
      let col;
      let row;
      if (geo) {
        col = (lon - geo.tieLon) / geo.scaleX - 0.5;
        row = (geo.tieLat - lat) / geo.scaleY - 0.5;
      } else {
        col = (c + 0.5) / outW * (width - 1);
        row = (r + 0.5) / outH * (height - 1);
      }
      heights[r * outW + c] = bilinearGrid(vals, width, height, col, row);
    }
  }
  return heights;
}

async function downloadTerrain() {
  const lat0 = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
  const widthM = (bbox.east - bbox.west) * 111320 * Math.cos(lat0);
  const heightM = (bbox.north - bbox.south) * 110540;
  const mppArg = process.argv.find((arg) => arg.startsWith('--terrain-mpp='));
  const terrainMpp = mppArg ? Number(mppArg.slice('--terrain-mpp='.length)) : 8;
  if (!(terrainMpp >= 3 && terrainMpp <= 16)) throw new Error(`Neplatné --terrain-mpp (${terrainMpp})`);
  const widthPx = Math.max(2, Math.round(widthM / terrainMpp));
  const heightPx = Math.max(2, Math.round(heightM / terrainMpp));
  const service = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage';
  const params = new URLSearchParams({
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${widthPx},${heightPx}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  const url = `${service}?${params}`;
  console.log(`DMR 5G ${widthPx}×${heightPx}…`);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`DMR 5G HTTP ${res.status} (${service})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const grid = readTiledFloat32(buf);
  const filled = grid.vals.map((value) => (Number.isFinite(value) && value > -50 && value < 3000 ? value : null));
  for (let pass = 0; pass < 6; pass++) {
    const next = filled.slice();
    for (let i = 0; i < filled.length; i++) {
      if (filled[i] != null) continue;
      const r = Math.floor(i / grid.width);
      const c = i % grid.width;
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= grid.height || cc >= grid.width) continue;
          const sample = filled[rr * grid.width + cc];
          if (sample == null) continue;
          sum += sample;
          n += 1;
        }
      }
      if (n) next[i] = sum / n;
    }
    filled.splice(0, filled.length, ...next);
  }
  if (filled.some((value) => value == null)) throw new Error('DMR 5G má díry, které nešly doplnit');
  const sampled = resampleToBbox({ ...grid, vals: filled }, bbox, widthPx, heightPx);
  const heights = sampled.map((value) => Math.round(value * 100) / 100);
  const elevMin = Math.min(...heights);
  const elevMax = Math.max(...heights);
  if (!(elevMin > 50 && elevMax < 1700 && elevMax > elevMin + 5)) {
    throw new Error(`DMR 5G vrátil nevěrohodný rozsah ${elevMin}–${elevMax}`);
  }
  const record = {
    source: 'ČÚZK DMR 5G',
    service,
    exportUrl: url,
    license: 'CC BY 4.0',
    attribution: '© ČÚZK',
    verticalDatum: 'Balt po vyrovnání (Bpv)',
    downloadedAt: new Date().toISOString(),
    bbox,
    width: widthPx,
    height: heightPx,
    rowOrder: 'north-first',
    alignedToBbox: true,
    sourceGeo: grid.geo,
    elevMin,
    elevMax,
    metersPerPixelX: Math.round((widthM / widthPx) * 1000) / 1000,
    metersPerPixelY: Math.round((heightM / heightPx) * 1000) / 1000,
    heights,
  };
  fs.writeFileSync(path.join(dataDir, 'terrain.json'), JSON.stringify(record));
  const binBytes = writeTerrainBin(record);
  console.log(`Terén binárně ${binBytes} B (${terrainMpp} m/px)`);
  return {
    file: 'terrain.json',
    service,
    exportUrl: url,
    width: widthPx,
    height: heightPx,
    elevMin,
    elevMax,
    verticalDatum: record.verticalDatum,
    metersPerPixelX: record.metersPerPixelX,
    metersPerPixelY: record.metersPerPixelY,
    license: 'Creative Commons Attribution 4.0 (CC BY 4.0), zdroj ČÚZK, DMR 5G',
  };
}

function writeCollection(name, features, copyright) {
  const collection = {
    type: 'FeatureCollection',
    name,
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL-1.0',
    copyright,
    features,
  };
  fs.writeFileSync(path.join(dataDir, `${name}.geojson`), JSON.stringify(collection));
  return collection;
}

async function downloadTerrainPatch(box, meters) {
  const lat0 = ((box.south + box.north) / 2) * (Math.PI / 180);
  const widthM = (box.east - box.west) * 111320 * Math.cos(lat0);
  const heightM = (box.north - box.south) * 110540;
  const widthPx = Math.max(2, Math.round(widthM / meters));
  const heightPx = Math.max(2, Math.round(heightM / meters));
  if (widthPx * heightPx > 80000) throw new Error(`Příliš jemný výřez ${widthPx}×${heightPx}`);
  const service = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage';
  const params = new URLSearchParams({
    bbox: `${box.west},${box.south},${box.east},${box.north}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${widthPx},${heightPx}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  const res = await fetch(`${service}?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`DMR 5G HTTP ${res.status} (${box.west},${box.south})`);
  const grid = readTiledFloat32(Buffer.from(await res.arrayBuffer()));
  const filled = grid.vals.map((value) => (Number.isFinite(value) && value > -50 && value < 3000 ? value : null));
  for (let pass = 0; pass < 6; pass++) {
    const next = filled.slice();
    for (let i = 0; i < filled.length; i++) {
      if (filled[i] != null) continue;
      const r = Math.floor(i / grid.width);
      const c = i % grid.width;
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= grid.height || cc >= grid.width) continue;
          const sample = filled[rr * grid.width + cc];
          if (sample == null) continue;
          sum += sample;
          n += 1;
        }
      }
      if (n) next[i] = sum / n;
    }
    filled.splice(0, filled.length, ...next);
  }
  if (filled.some((value) => value == null)) throw new Error('DMR 5G má díry v detailním výřezu');
  const sampled = resampleToBbox({ ...grid, vals: filled }, box, widthPx, heightPx);
  const heights = sampled.map((value) => Math.round(value * 100) / 100);
  const elevMin = Math.min(...heights);
  const elevMax = Math.max(...heights);
  if (!(elevMin > 50 && elevMax < 1700 && elevMax > elevMin + 1)) {
    throw new Error(`Detail DMR vrátil nevěrohodný rozsah ${elevMin}–${elevMax}`);
  }
  return { ...box, width: widthPx, height: heightPx, elevMin, elevMax, heights };
}

function writeTerrainDetail(patches) {
  let bytes = 8;
  for (const patch of patches) bytes += 28 + patch.heights.length * 2;
  const buf = Buffer.alloc(bytes);
  buf.write('HDET', 0, 'ascii');
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(patches.length, 6);
  let offset = 8;
  for (const patch of patches) {
    buf.writeFloatLE(patch.west, offset);
    buf.writeFloatLE(patch.south, offset + 4);
    buf.writeFloatLE(patch.east, offset + 8);
    buf.writeFloatLE(patch.north, offset + 12);
    buf.writeUInt16LE(patch.width, offset + 16);
    buf.writeUInt16LE(patch.height, offset + 18);
    buf.writeFloatLE(patch.elevMin, offset + 20);
    buf.writeFloatLE(patch.elevMax, offset + 24);
    offset += 28;
    const span = patch.elevMax - patch.elevMin || 1;
    for (let i = 0; i < patch.heights.length; i++) {
      const t = (patch.heights[i] - patch.elevMin) / span;
      buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(t * 65535))), offset);
      offset += 2;
    }
  }
  const file = path.join(dataDir, 'terrain-detail.bin');
  fs.writeFileSync(file, buf);
  return buf.length;
}

fs.mkdirSync(dataDir, { recursive: true });

if (process.argv.includes('--terrain-patches')) {
  const patches = [
    { west: 14.036, south: 50.6544, east: 14.0438, north: 50.6576 },
    { west: 14.0269, south: 50.6544, east: 14.0452, north: 50.6592 },
    { west: 14.041, south: 50.6544, east: 14.055, north: 50.6622 },
  ];
  const records = [];
  for (const patch of patches) {
    console.log(`Detail DMR ${patch.west},${patch.south}…`);
    records.push(await downloadTerrainPatch(patch, 4));
  }
  const bytes = writeTerrainDetail(records);
  console.log(JSON.stringify({ bytes, patches: records.map(({ west, south, east, north, width, height, elevMin, elevMax }) => ({ west, south, east, north, width, height, elevMin, elevMax })) }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--terrain-only')) {
  const terrain = await downloadTerrain();
  const metaPath = path.join(dataDir, 'meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { bbox };
  meta.terrain = terrain;
  meta.licenses = { ...(meta.licenses || {}), dmr5g: terrain.license };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(terrain, null, 2));
  process.exit(0);
}

console.log(`BBox WGS84: ${bbox.west}, ${bbox.south} – ${bbox.east}, ${bbox.north}`);

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;
const selectedThemes = only ? themes.filter(([name]) => only.includes(name)) : themes;
if (only && !selectedThemes.length) throw new Error(`Neznámé téma v --only (${only.join(', ')})`);

let osmTimestamp = null;
let osmCopyright = null;
let overpassUrl = null;
const counts = {};
const skipped = {};

for (const [name, body] of selectedThemes) {
  const query = `[out:json][timeout:120];(${body});out geom;`;
  console.log(`OSM ${name}…`);
  try {
    const { json, url } = await overpass(query);
    overpassUrl = url;
    osmTimestamp = json.osm3s?.timestamp_osm_base || osmTimestamp;
    osmCopyright = json.osm3s?.copyright || osmCopyright;
    const converted = name === 'routes' ? convertRoutes(json.elements) : convertTheme(name, json.elements);
    writeCollection(name, converted.features, osmCopyright);
    counts[name] = converted.features.length;
    skipped[name] = converted.skipped;
    console.log(`  ${converted.features.length} prvků, přeskočeno ${converted.skipped}, surových ${json.elements.length}`);
  } catch (error) {
    if (name !== 'furniture' && name !== 'routes') throw error;
    console.warn(`OSM ${name} se nepodařilo stáhnout (${error.message}). Soubor zůstane prázdný.`);
    writeCollection(name, [], osmCopyright);
    counts[name] = 0;
    skipped[name] = 0;
  }
}

if (!only && (counts.buildings || 0) < 50) {
  throw new Error('Příliš málo budov — bbox nebo Overpass nevrátil centrum.');
}

if (only) {
  const metaPath = path.join(dataDir, 'meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { bbox };
  meta.counts = { ...(meta.counts || {}), ...counts };
  meta.skipped = { ...(meta.skipped || {}), ...skipped };
  if (osmTimestamp) {
    meta.themeTimestamps = { ...(meta.themeTimestamps || {}) };
    for (const name of only) meta.themeTimestamps[name] = osmTimestamp;
  }
  if (osmCopyright) meta.osmCopyright = osmCopyright;
  if (overpassUrl) meta.overpassUrl = overpassUrl;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ counts, skipped }, null, 2));
  process.exit(0);
}

const ortho = await downloadOrtho();
const terrain = await downloadTerrain();
const meta = {
  downloadedAt: new Date().toISOString(),
  bbox,
  startHint: config.startHint,
  origin: {
    lon: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  },
  osmTimestamp,
  osmCopyright,
  overpassUrl,
  wmsUrl: ortho.url,
  counts,
  skipped,
  ortho: {
    file: 'ortho.jpg',
    worldFile: 'ortho.jgw',
    width: ortho.width,
    height: ortho.height,
    bytes: ortho.bytes,
    metersPerPixelX: ortho.metersPerPixelX,
    metersPerPixelY: ortho.metersPerPixelY,
    crs: 'EPSG:4326',
    mobile: ortho.mobile,
  },
  terrain,
  licenses: {
    osm: 'Open Database License (ODbL) 1.0',
    ortofoto: 'Creative Commons Attribution 4.0 (CC BY 4.0), zdroj ČÚZK',
    dmr5g: terrain.license,
  },
};
fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ counts, ortho: meta.ortho, osmTimestamp }, null, 2));
