import * as THREE from 'three';

const world = new THREE.Vector3();
const ahead = new THREE.Vector3();
const camDir = new THREE.Vector3();

export function updateLabels(sprites, camera, { maxDist = 260, hide = false } = {}) {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(camDir);
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  for (const sprite of sprites) {
    if (hide) {
      sprite.visible = false;
      continue;
    }
    sprite.getWorldPosition(world);
    const dist = camera.position.distanceTo(world);
    ahead.copy(world).sub(camera.position);
    const facing = ahead.dot(camDir);
    const height = Math.min(7.2, Math.max(2.15, dist * 0.022));
    const aspect = sprite.userData.aspect || 1;
    sprite.scale.set(-height * aspect, height, 1);
    let fade = 1;
    if (dist < 20) fade = Math.max(0, (dist - 9) / 11);
    else if (dist > maxDist) fade = 0;
    else if (dist > maxDist * 0.72) fade = (maxDist - dist) / (maxDist * 0.28);
    if (facing < 0.6 || fade <= 0.04) {
      sprite.visible = false;
      sprite.material.opacity = 0;
      continue;
    }
    const ndc = world.clone().project(camera);
    const depth = Math.max(0.5, -world.clone().applyMatrix4(camera.matrixWorldInverse).z);
    const pad = 1.28;
    const halfH = (pad * height) / (2 * depth * tan);
    const halfW = (pad * height * aspect) / (2 * depth * tan * camera.aspect);
    const margin = 0.045;
    const left = ndc.x - halfW;
    const right = ndc.x + halfW;
    const bottom = ndc.y;
    const top = ndc.y + halfH * 2;
    const clipped =
      ndc.z < -1 ||
      ndc.z > 1 ||
      Math.abs(ndc.x) > 0.92 ||
      ndc.y > 0.84 ||
      ndc.y < -0.9 ||
      left < -1 + margin ||
      right > 1 - margin ||
      bottom < -1 + margin ||
      top > 1 - margin;
    sprite.center.set(0.5, 0);
    sprite.visible = !clipped;
    sprite.material.opacity = clipped ? 0 : fade;
  }
}
