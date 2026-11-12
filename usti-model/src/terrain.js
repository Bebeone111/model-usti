export function terrainFromBin(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'HDEM') throw new Error('Soubor terénu není ve známém formátu.');
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const elevMin = view.getFloat32(8, true);
  const elevMax = view.getFloat32(12, true);
  const count = width * height;
  const heights = new Float32Array(count);
  const span = elevMax - elevMin || 1;
  const header = 20;
  for (let i = 0; i < count; i++) heights[i] = elevMin + (view.getUint16(header + i * 2, true) / 65535) * span;
  return { width, height, elevMin, elevMax, heights, source: 'ČÚZK DMR 5G' };
}

export function terrainDetailFromBin(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'HDET') throw new Error('Doplňkový terén není ve známém formátu.');
  const count = view.getUint16(6, true);
  let offset = 8;
  const patches = [];
  for (let i = 0; i < count; i++) {
    const west = view.getFloat32(offset, true);
    const south = view.getFloat32(offset + 4, true);
    const east = view.getFloat32(offset + 8, true);
    const north = view.getFloat32(offset + 12, true);
    const width = view.getUint16(offset + 16, true);
    const height = view.getUint16(offset + 18, true);
    const elevMin = view.getFloat32(offset + 20, true);
    const elevMax = view.getFloat32(offset + 24, true);
    offset += 28;
    const heights = new Float32Array(width * height);
    const span = elevMax - elevMin || 1;
    for (let k = 0; k < heights.length; k++) {
      heights[k] = elevMin + (view.getUint16(offset, true) / 65535) * span;
      offset += 2;
    }
    patches.push({ west, south, east, north, width, height, heights });
  }
  return { patches };
}

function pointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function buildWeight(grid, projector, detail) {
  const { width, height } = grid;
  const weights = new Float32Array(width * height);
  if (!detail?.patches?.length) return weights;
  const segments = detail.segments || [];
  const slope = detail.slope;
  const spanX = projector.maxX - projector.minX || 1;
  const spanZ = projector.maxZ - projector.minZ || 1;
  for (let r = 0; r < height; r++) {
    const z = projector.minZ + (1 - r / (height - 1)) * spanZ;
    for (let c = 0; c < width; c++) {
      const x = projector.minX + (c / (width - 1)) * spanX;
      let w = 0;
      if (slope && x >= slope.minX && x <= slope.maxX && z >= slope.minZ && z <= slope.maxZ) {
        const edge = Math.min(x - slope.minX, slope.maxX - x, z - slope.minZ, slope.maxZ - z);
        w = Math.min(1, edge / 16);
      }
      if (w < 1 && segments.length) {
        let best = 64;
        for (let i = 0; i < segments.length; i += 4) {
          const dist = pointSeg(x, z, segments[i], segments[i + 1], segments[i + 2], segments[i + 3]);
          if (dist < best) best = dist;
          if (best < 18) break;
        }
        if (best < 22) w = 1;
        else if (best < 40) w = Math.max(w, 1 - (best - 22) / 18);
      }
      weights[r * width + c] = w;
    }
  }
  return weights;
}

function samplePatch(patch, lon, lat) {
  if (lon < patch.west || lon > patch.east || lat < patch.south || lat > patch.north) return null;
  const u = (lon - patch.west) / (patch.east - patch.west || 1);
  const vNorth = (lat - patch.south) / (patch.north - patch.south || 1);
  let col = u * (patch.width - 1);
  let row = (1 - vNorth) * (patch.height - 1);
  col = Math.min(patch.width - 1 - 1e-6, Math.max(0, col));
  row = Math.min(patch.height - 1 - 1e-6, Math.max(0, row));
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(patch.width - 1, c0 + 1);
  const r1 = Math.min(patch.height - 1, r0 + 1);
  const tx = col - c0;
  const ty = row - r0;
  const at = (r, c) => patch.heights[r * patch.width + c];
  const a = at(r0, c0) * (1 - tx) + at(r0, c1) * tx;
  const b = at(r1, c0) * (1 - tx) + at(r1, c1) * tx;
  return a * (1 - ty) + b * ty;
}

export function makeTerrain(grid, projector, detail = null) {
  const width = grid.width;
  const height = grid.height;
  const heights = grid.heights;
  const elevMin = grid.elevMin;
  const weights = buildWeight(grid, projector, detail);

  function locate(x, z) {
    const spanX = projector.maxX - projector.minX || 1;
    const spanZ = projector.maxZ - projector.minZ || 1;
    const u = Math.min(1, Math.max(0, (x - projector.minX) / spanX));
    const vNorth = Math.min(1, Math.max(0, (z - projector.minZ) / spanZ));
    let col = u * (width - 1);
    let row = (1 - vNorth) * (height - 1);
    col = Math.min(width - 1 - 1e-6, Math.max(0, col));
    row = Math.min(height - 1 - 1e-6, Math.max(0, row));
    return { col, row };
  }

  function sampleAbsolute(x, z) {
    const { col, row } = locate(x, z);
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(width - 1, c0 + 1);
    const r1 = Math.min(height - 1, r0 + 1);
    const tx = col - c0;
    const ty = row - r0;
    const at = (r, c) => heights[r * width + c];
    const h00 = at(r0, c0);
    const h10 = at(r0, c1);
    const h01 = at(r1, c0);
    const h11 = at(r1, c1);
    if (tx + ty <= 1) return h00 * (1 - tx - ty) + h10 * tx + h01 * ty;
    return h10 * (1 - ty) + h01 * (1 - tx) + h11 * (tx + ty - 1);
  }

  function sampleWeight(x, z) {
    const { col, row } = locate(x, z);
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(width - 1, c0 + 1);
    const r1 = Math.min(height - 1, r0 + 1);
    const tx = col - c0;
    const ty = row - r0;
    const at = (r, c) => weights[r * width + c];
    const a = at(r0, c0) * (1 - tx) + at(r0, c1) * tx;
    const b = at(r1, c0) * (1 - tx) + at(r1, c1) * tx;
    return a * (1 - ty) + b * ty;
  }

  return {
    width,
    height,
    elevMin,
    elevMax: grid.elevMax,
    weight(x, z) {
      return detail ? sampleWeight(x, z) : 0;
    },
    sample(x, z) {
      const coarse = sampleAbsolute(x, z);
      const blend = detail ? sampleWeight(x, z) : 0;
      if (blend < 0.02) return coarse - elevMin;
      const [lon, lat] = projector.toLonLat(x, z);
      let fine = null;
      for (const patch of detail.patches) {
        fine = samplePatch(patch, lon, lat);
        if (fine != null) break;
      }
      if (fine == null) return coarse - elevMin;
      return (coarse * (1 - blend) + fine * blend) - elevMin;
    },
  };
}
