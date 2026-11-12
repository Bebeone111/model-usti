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
    // Match the two triangles used by the ground mesh. Bilinear height
    // cuts across that diagonal and sinks roads under a steep hillside.
    let col = u * (width - 1);
    let row = (1 - vNorth) * (height - 1);
    col = Math.min(width - 1 - 1e-6, Math.max(0, col));
    row = Math.min(height - 1 - 1e-6, Math.max(0, row));
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
