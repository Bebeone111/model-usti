import * as THREE from 'three';

const world = new THREE.Vector3();
const ahead = new THREE.Vector3();
const camDir = new THREE.Vector3();
const MAX_VISIBLE = 24;

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}

export function hudRects(selectors) {
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  const rects = [];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    rects.push({
      left: (box.left / width) * 2 - 1,
      right: (box.right / width) * 2 - 1,
      top: 1 - (box.top / height) * 2,
      bottom: 1 - (box.bottom / height) * 2,
    });
  }
  return rects;
}

export function updateLabels(sprites, camera, { maxDist = 260, hide = false, blockers = [] } = {}) {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(camDir);
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const candidates = [];
  for (const sprite of sprites) {
    if (hide) {
      sprite.visible = false;
      continue;
    }
    sprite.getWorldPosition(world);
    const dist = camera.position.distanceTo(world);
    ahead.copy(world).sub(camera.position);
    const facing = ahead.dot(camDir);
    const height = Math.min(4.4, Math.max(1.15, dist * 0.016));
    const aspect = sprite.userData.aspect || 1;
    sprite.scale.set(-height * aspect, height, 1);
    let fade = 1;
    if (dist < 26) fade = Math.max(0, (dist - 11) / 15);
    else if (dist > maxDist) fade = 0;
    else if (dist > maxDist * 0.72) fade = (maxDist - dist) / (maxDist * 0.28);
    if (facing < 0.6 || fade <= 0.04) {
      sprite.visible = false;
      sprite.material.opacity = 0;
      continue;
    }
    const ndc = world.clone().project(camera);
    const depth = Math.max(0.5, -world.clone().applyMatrix4(camera.matrixWorldInverse).z);
    const pad = 1.22;
    const halfH = (pad * height) / (2 * depth * tan);
    const halfW = (pad * height * aspect) / (2 * depth * tan * camera.aspect);
    const margin = 0.045;
    const box = {
      left: ndc.x - halfW,
      right: ndc.x + halfW,
      bottom: ndc.y,
      top: ndc.y + halfH * 2,
    };
    const clipped =
      ndc.z < -1 ||
      ndc.z > 1 ||
      Math.abs(ndc.x) > 0.92 ||
      ndc.y > 0.84 ||
      ndc.y < -0.9 ||
      box.left < -1 + margin ||
      box.right > 1 - margin ||
      box.bottom < -1 + margin ||
      box.top > 1 - margin ||
      blockers.some((blocker) => {
        const pad = 0.06;
        return (
          box.left < blocker.right + pad
          && box.right > blocker.left - pad
          && box.bottom < blocker.top + pad
          && box.top > blocker.bottom - pad
        );
      });
    sprite.center.set(0.5, 0);
    if (clipped) {
      sprite.visible = false;
      sprite.material.opacity = 0;
      continue;
    }
    const text = sprite.userData.text || '';
    const rank = (sprite.userData.poi ? 40 : 0) + (text.length < 22 ? 6 : 0) - text.length * 0.08;
    candidates.push({ sprite, box, fade, dist, rank, text });
  }
  candidates.sort((a, b) => b.rank - a.rank || a.dist - b.dist);
  const kept = [];
  for (const candidate of candidates) {
    const duplicate = kept.some((other) => {
      const same = candidate.text && candidate.text === other.text;
      const cx = (candidate.box.left + candidate.box.right) / 2;
      const cy = (candidate.box.bottom + candidate.box.top) / 2;
      const ox = (other.box.left + other.box.right) / 2;
      const oy = (other.box.bottom + other.box.top) / 2;
      const near = Math.hypot(cx - ox, cy - oy) < (same ? 0.42 : 0.12);
      if (same && (near || rectsOverlap(candidate.box, other.box))) return true;
      if (!rectsOverlap(candidate.box, other.box) && !near) return false;
      const shorter = candidate.text.length <= other.text.length ? candidate.text : other.text;
      const longer = shorter === candidate.text ? other.text : candidate.text;
      return longer.includes(shorter);
    });
    const crowded = kept.some((other) => {
      const pad = 0.02;
      const a = candidate.box;
      const b = other.box;
      return a.left - pad < b.right && a.right + pad > b.left && a.bottom - pad < b.top && a.top + pad > b.bottom;
    });
    if (duplicate || crowded || kept.length >= MAX_VISIBLE) {
      candidate.sprite.visible = false;
      candidate.sprite.material.opacity = 0;
      continue;
    }
    kept.push(candidate);
    candidate.sprite.visible = true;
    candidate.sprite.material.opacity = candidate.fade;
  }
}
