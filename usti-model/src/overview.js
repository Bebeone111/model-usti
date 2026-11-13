function roadStyle(key) {
  const name = String(key || '').replace(/_link$/, '');
  if (name === 'footway' || name === 'path' || name === 'steps' || name === 'pedestrian' || name === 'cycleway') {
    return { color: '#e6dcc8', width: 1.2 };
  }
  if (name === 'primary' || name === 'secondary' || name === 'trunk' || name === 'motorway') return { color: '#d5dbe2', width: 2.4 };
  if (name === 'tertiary' || name === 'residential' || name === 'living_street' || name === 'unclassified') {
    return { color: '#b7c0c8', width: 1.6 };
  }
  return null;
}

export function collectMapGeometry(highways, water, projector, railways = null) {
  const lines = [];
  for (const feature of highways?.features || []) {
    if (feature.geometry?.type !== 'LineString') continue;
    const style = roadStyle(feature.properties?.highway);
    if (!style) continue;
    const pts = [];
    for (const [lon, lat] of feature.geometry.coordinates) {
      const [x, z] = projector.toLocal(lon, lat);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(x - last[0], z - last[1]) > 8) pts.push([x, z]);
    }
    if (pts.length >= 2) lines.push({ pts, ...style });
  }
  for (const feature of railways?.features || []) {
    if (feature.geometry?.type !== 'LineString') continue;
    const pts = [];
    for (const [lon, lat] of feature.geometry.coordinates) {
      const [x, z] = projector.toLocal(lon, lat);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(x - last[0], z - last[1]) > 10) pts.push([x, z]);
    }
    if (pts.length >= 2) lines.push({ pts, color: '#6a6460', width: 1.8 });
  }
  const rivers = [];
  const pushRing = (ring) => {
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) {
      const [x, z] = projector.toLocal(ring[i][0], ring[i][1]);
      pts.push([x, z]);
    }
    if (pts.length >= 3) rivers.push(pts);
  };
  for (const feature of water?.features || []) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'Polygon') pushRing(geometry.coordinates[0]);
    else if (geometry.type === 'MultiPolygon') {
      for (const poly of geometry.coordinates) pushRing(poly[0]);
    }
  }
  return { lines, rivers };
}

function paintBase(geometry, bounds) {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a3142';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;
  const to = (x, z) => [((x - bounds.minX) / spanX) * canvas.width, (1 - (z - bounds.minZ) / spanZ) * canvas.height];
  ctx.fillStyle = '#1d6f8c';
  for (const ring of geometry.rivers) {
    ctx.beginPath();
    ring.forEach((point, index) => {
      const [sx, sy] = to(point[0], point[1]);
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.fill();
  }
  for (const line of geometry.lines) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    line.pts.forEach((point, index) => {
      const [sx, sy] = to(point[0], point[1]);
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }
  return { canvas };
}

export function createOverview({ mini, canvas, panel, geometry, bounds, getPlayer, getWhere, getPois, getLabels = () => [], getGoal = () => null, search, onTeleport, onPoi, onHome, onTour }) {
  const base = paintBase(geometry, bounds);
  const miniCtx = mini.getContext('2d');
  const ctx = canvas.getContext('2d');
  const view = { x: 0, z: 0, ppm: 1.4 };
  let open = false;
  let drag = null;
  const pointers = new Map();
  const searchInput = panel.querySelector('#map-search');
  const results = panel.querySelector('#map-results');
  const here = panel.querySelector('#map-here');
  const scale = panel.querySelector('#map-scale');
  const visited = panel.querySelector('#map-visited');

  function worldFrom(px, py) {
    const rect = canvas.getBoundingClientRect();
    const x = view.x + (px - rect.width / 2) / view.ppm;
    const z = view.z - (py - rect.height / 2) / view.ppm;
    return { x, z };
  }

  function drawMap() {
    if (!open) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanZ = bounds.maxZ - bounds.minZ || 1;
    const player = getPlayer();
    ctx.drawImage(
      base.canvas,
      0,
      0,
      base.canvas.width,
      base.canvas.height,
      rect.width / 2 + (bounds.minX - view.x) * view.ppm,
      rect.height / 2 - (bounds.maxZ - view.z) * view.ppm,
      spanX * view.ppm,
      spanZ * view.ppm,
    );
    for (const poi of getPois()) {
      const sx = rect.width / 2 + (poi.x - view.x) * view.ppm;
      const sy = rect.height / 2 - (poi.z - view.z) * view.ppm;
      ctx.beginPath();
      ctx.fillStyle = poi.visited ? '#f0d78c' : '#f7f3ea';
      ctx.strokeStyle = '#1a140c';
      ctx.lineWidth = 2;
      ctx.arc(sx, sy, view.ppm > 1.1 ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (view.ppm > 0.85) {
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillStyle = '#f7f3ea';
        ctx.fillText(poi.name, sx + 10, sy + 4);
      }
    }
    if (view.ppm > 2.1) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(247, 243, 234, 0.86)';
      const seen = [];
      for (const label of getLabels()) {
        if (label.kind !== 'street') continue;
        const sx = rect.width / 2 + (label.x - view.x) * view.ppm;
        const sy = rect.height / 2 - (label.z - view.z) * view.ppm;
        if (sx < 8 || sy < 8 || sx > rect.width - 8 || sy > rect.height - 8) continue;
        if (seen.some((item) => Math.hypot(item.sx - sx, item.sy - sy) < 70)) continue;
        seen.push({ sx, sy });
        ctx.fillText(label.text, sx, sy);
      }
    }
    const goal = getGoal();
    if (goal) {
      const sx = rect.width / 2 + (goal.x - view.x) * view.ppm;
      const sy = rect.height / 2 - (goal.z - view.z) * view.ppm;
      ctx.fillStyle = '#f0c14e';
      ctx.fillRect(sx - 4, sy - 10, 8, 8);
    }
    drawArrow(ctx, rect.width / 2 + (player.x - view.x) * view.ppm, rect.height / 2 - (player.z - view.z) * view.ppm, player.yaw, 11);
    const meters = niceScale(110 / view.ppm);
    const bar = meters * view.ppm;
    scale.textContent = `${meters} m`;
    scale.style.setProperty('--bar', `${bar}px`);
    here.textContent = `Jsi tady: ${getWhere()}`;
  }

  function drawMini() {
    const player = getPlayer();
    const width = mini.width;
    const height = mini.height;
    const ppm = width / 220;
    miniCtx.setTransform(1, 0, 0, 1, 0, 0);
    miniCtx.clearRect(0, 0, width, height);
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanZ = bounds.maxZ - bounds.minZ || 1;
    miniCtx.drawImage(
      base.canvas,
      0,
      0,
      base.canvas.width,
      base.canvas.height,
      width / 2 + (bounds.minX - player.x) * ppm,
      height / 2 - (bounds.maxZ - player.z) * ppm,
      spanX * ppm,
      spanZ * ppm,
    );
    for (const poi of getPois()) {
      const sx = width / 2 + (poi.x - player.x) * ppm;
      const sy = height / 2 - (poi.z - player.z) * ppm;
      if (sx < 2 || sy < 2 || sx > width - 2 || sy > height - 2) continue;
      miniCtx.fillStyle = poi.visited ? '#f0d78c' : '#f7f3ea';
      miniCtx.fillRect(sx - 2, sy - 2, 4, 4);
    }
    const goal = getGoal();
    if (goal) {
      const sx = width / 2 + (goal.x - player.x) * ppm;
      const sy = height / 2 - (goal.z - player.z) * ppm;
      if (sx > 4 && sy > 4 && sx < width - 4 && sy < height - 4) {
        miniCtx.fillStyle = '#f0c14e';
        miniCtx.beginPath();
        miniCtx.arc(sx, sy, 4, 0, Math.PI * 2);
        miniCtx.fill();
      }
    }
    drawArrow(miniCtx, width / 2, height / 2, player.yaw, 8);
    miniCtx.fillStyle = '#f7f3ea';
    miniCtx.font = '12px system-ui, sans-serif';
    miniCtx.fillText('S', width / 2 - 4, 14);
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    if (open) {
      const player = getPlayer();
      view.x = player.x;
      view.z = player.z;
      drawMap();
    }
  }

  function centerOnPlayer() {
    const player = getPlayer();
    view.x = player.x;
    view.z = player.z;
    drawMap();
  }

  canvas.addEventListener('wheel', (event) => {
    if (!open) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    view.ppm = Math.min(8, Math.max(0.35, view.ppm * factor));
    drawMap();
  }, { passive: false });

  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, ox: event.offsetX, oy: event.offsetY });
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vz: view.z, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, ox: event.offsetX, oy: event.offsetY });
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (!drag.pinch) drag.pinch = dist;
      view.ppm = Math.min(8, Math.max(0.35, view.ppm * (dist / drag.pinch)));
      drag.pinch = dist;
      drag.moved = true;
      drawMap();
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    view.x = drag.vx - dx / view.ppm;
    view.z = drag.vz + dy / view.ppm;
    drawMap();
  });
  function endPointer(event) {
    const start = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (pointers.size === 0 && drag && !drag.moved && start) {
      const hit = worldFrom(start.ox, start.oy);
      const poi = getPois().find((item) => Math.hypot(item.x - hit.x, item.z - hit.z) < 14 / view.ppm);
      if (poi) onPoi(poi);
      else onTeleport(hit.x, hit.z);
    }
    if (pointers.size === 0) drag = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  searchInput?.addEventListener('input', () => {
    const found = search(searchInput.value);
    results.innerHTML = '';
    for (const item of found) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${item.name} · jít sem`;
      button.addEventListener('click', () => {
        onTeleport(item.x, item.z, item.poi);
        results.innerHTML = '';
        searchInput.value = '';
      });
      li.appendChild(button);
      results.appendChild(li);
    }
  });
  panel.querySelector('#map-close')?.addEventListener('click', () => setOpen(false));
  panel.querySelector('#map-home')?.addEventListener('click', () => onHome());
  panel.querySelector('#map-me')?.addEventListener('click', () => centerOnPlayer());
  panel.querySelector('#map-tour')?.addEventListener('click', () => onTour());

  return {
    isOpen: () => open,
    setOpen,
    toggle() {
      setOpen(!open);
    },
    centerOnPlayer,
    drawMini,
    drawMap,
    setVisited(text) {
      if (visited) visited.textContent = text;
    },
    focusSearch() {
      searchInput?.focus();
    },
  };
}

function niceScale(meters) {
  const steps = [20, 50, 100, 200, 500, 1000];
  return steps.find((step) => step >= meters) || 1000;
}

function drawArrow(ctx, x, y, yaw, size) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const angle = Math.atan2(fx, fz);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.55, size * 0.7);
  ctx.lineTo(0, size * 0.3);
  ctx.lineTo(-size * 0.55, size * 0.7);
  ctx.closePath();
  ctx.fillStyle = '#f2c14e';
  ctx.strokeStyle = '#1a140c';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
