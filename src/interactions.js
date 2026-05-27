// TransformControls (the orange gizmo) and direct click-and-drag on the
// slice plane / cube. Each module mutates state.selectedTarget so the
// UI badges and gizmo target stay in sync.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';
import { scene, camera, renderer, orbit } from './scene.js';

export const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setSize(0.8);
scene.add(transformControls);

transformControls.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
});

export function applySelection() {
  if (state.selectedTarget === 'slice' && state.slicePlane) {
    transformControls.attach(state.slicePlane);
  } else if (state.selectedTarget === 'cube' && state.cube) {
    transformControls.attach(state.cube);
  }
}

export function syncSelectionButtons() {
  const sliceBtn = document.getElementById('select-slice');
  const cubeBtn = document.getElementById('select-cube');
  if (sliceBtn) sliceBtn.classList.toggle('active', state.selectedTarget === 'slice');
  if (cubeBtn) cubeBtn.classList.toggle('active', state.selectedTarget === 'cube');
}

// ---- Direct drag (click + drag the slice plane or cube freely) ----
const dragRaycaster = new THREE.Raycaster();
const dragPointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const dragOffset = new THREE.Vector3();
const dragCameraDir = new THREE.Vector3();
const dragCubeInverse = new THREE.Matrix4();
const dragLocalPos = new THREE.Vector3();
let dragTarget = null;

function setPointerNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  dragPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  dragPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (transformControls.dragging) return;
  if (!state.cube || !state.slicePlane) return;

  setPointerNDC(e);
  dragRaycaster.setFromCamera(dragPointer, camera);

  const allHits = dragRaycaster.intersectObjects([state.slicePlane, state.cube], false);
  if (allHits.length === 0) return;

  dragCubeInverse.copy(state.cube.matrixWorld).invert();

  // Skip hits that wouldn't be visible: clipped cube faces in opaque mode,
  // or parts of the slice plane outside the cube (transparent).
  let hit = null;
  for (const h of allHits) {
    if (h.object === state.cube) {
      if (state.renderMode === 0 && state.sliceClippingPlane.distanceToPoint(h.point) > 0) continue;
      hit = h; break;
    } else if (h.object === state.slicePlane) {
      dragLocalPos.copy(h.point).applyMatrix4(dragCubeInverse);
      if (Math.abs(dragLocalPos.x) > state.cubeSize.x * 0.5 + 1e-4 ||
          Math.abs(dragLocalPos.y) > state.cubeSize.y * 0.5 + 1e-4 ||
          Math.abs(dragLocalPos.z) > state.cubeSize.z * 0.5 + 1e-4) continue;
      hit = h; break;
    }
  }
  if (!hit) return;

  dragTarget = hit.object;

  const newSel = (dragTarget === state.slicePlane) ? 'slice' : 'cube';
  if (newSel !== state.selectedTarget) {
    state.selectedTarget = newSel;
    applySelection();
    syncSelectionButtons();
  }

  // Drag in a plane perpendicular to the camera, through the target's center.
  camera.getWorldDirection(dragCameraDir);
  dragPlane.setFromNormalAndCoplanarPoint(dragCameraDir, dragTarget.position);
  dragOffset.copy(hit.point).sub(dragTarget.position);

  orbit.enabled = false;
  renderer.domElement.style.cursor = 'grabbing';
});

window.addEventListener('pointermove', (e) => {
  if (!dragTarget) return;
  setPointerNDC(e);
  dragRaycaster.setFromCamera(dragPointer, camera);
  const hit = new THREE.Vector3();
  if (dragRaycaster.ray.intersectPlane(dragPlane, hit)) {
    dragTarget.position.copy(hit.sub(dragOffset));
  }
});

window.addEventListener('pointerup', () => {
  if (dragTarget) {
    dragTarget = null;
    orbit.enabled = true;
    renderer.domElement.style.cursor = '';
  }
});

// Hover cursor — show 'grab' when over a draggable target.
renderer.domElement.addEventListener('pointermove', (e) => {
  if (dragTarget || transformControls.dragging || !state.cube || !state.slicePlane) return;
  setPointerNDC(e);
  dragRaycaster.setFromCamera(dragPointer, camera);
  const hits = dragRaycaster.intersectObjects([state.slicePlane, state.cube], false);
  if (hits.length === 0) {
    renderer.domElement.style.cursor = '';
    return;
  }
  dragCubeInverse.copy(state.cube.matrixWorld).invert();
  let canGrab = false;
  for (const h of hits) {
    if (h.object === state.cube) {
      if (state.renderMode === 0 && state.sliceClippingPlane.distanceToPoint(h.point) > 0) continue;
      canGrab = true; break;
    } else {
      dragLocalPos.copy(h.point).applyMatrix4(dragCubeInverse);
      if (Math.abs(dragLocalPos.x) > state.cubeSize.x * 0.5 ||
          Math.abs(dragLocalPos.y) > state.cubeSize.y * 0.5 ||
          Math.abs(dragLocalPos.z) > state.cubeSize.z * 0.5) continue;
      canGrab = true; break;
    }
  }
  renderer.domElement.style.cursor = canGrab ? 'grab' : '';
});
