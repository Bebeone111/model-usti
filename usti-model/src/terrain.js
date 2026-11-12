export function makeTerrain(grid, projector) {
  const width = grid.width;
  const height = grid.height;
  const heights = grid.heights;
  const elevMin = grid.elevMin;

  function sampleAbsolute(x, z) {
    const spanX = projector.maxX - projector.minX || 1;
    const spanZ = projector.maxZ - projector.minZ || 1;
    const u = Math.min(1, Math.max(0, (x - projector.minX) / spanX));
    const vNorth = Math.min(1, Math.max(0, (z - projector.minZ) / spanZ));
    const col = u * (width - 1);
    const row = (1 - vNorth) * (height - 1);
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(width - 1, c0 + 1);
    const r1 = Math.min(height - 1, r0 + 1);
    const tx = col - c0;
    const ty = row - r0;
    const at = (r, c) => heights[r * width + c];
    const a = at(r0, c0) * (1 - tx) + at(r0, c1) * tx;
    const b = at(r1, c0) * (1 - tx) + at(r1, c1) * tx;
    return a * (1 - ty) + b * ty;
  }

  return {
    width,
    height,
    elevMin,
    elevMax: grid.elevMax,
    sample(x, z) {
      return sampleAbsolute(x, z) - elevMin;
    },
  };
}
