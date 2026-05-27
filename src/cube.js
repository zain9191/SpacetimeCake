// Builds the spacetime cube + slice plane after a video's volume texture
// is ready. Also handles the per-frame uniform updates (clipping plane,
// camera-in-cube-local, ortho preview cursor).
import * as THREE from 'three';
import { sharedVertexShader, cubeFragmentShader, sliceFragmentShader } from './shaders.js';
import { state } from './state.js';
import { scene, camera, dummyMaskTexture } from './scene.js';
import { orthoXY, orthoXT, orthoYT, buildOrthoMaterials, sizeOrthoCanvas } from './orthoPreviews.js';

function getMaskTexture() { return state.maskTexture || dummyMaskTexture; }
function getMaskEnabled() { return state.activeTrackIdx >= 0; }

// Apply the (possibly new) mask uniforms to every material that uses them.
export function applyMaskUniforms() {
  const mats = [];
  if (state.cube) mats.push(state.cube.material);
  if (state.slicePlane) mats.push(state.slicePlane.material);
  if (orthoXY.material) mats.push(orthoXY.material);
  if (orthoXT.material) mats.push(orthoXT.material);
  if (orthoYT.material) mats.push(orthoYT.material);
  for (const m of mats) {
    if (m.uniforms.uMaskTex)     m.uniforms.uMaskTex.value     = getMaskTexture();
    if (m.uniforms.uMaskEnabled) m.uniforms.uMaskEnabled.value = getMaskEnabled();
  }
}

// Build (or rebuild) the cube + slice plane + ortho previews for a new
// volume texture of size W × H × depth.
// Dispose all geometries + materials of an Object3D's children before removing
// it. The cube and slice plane each carry a child LineSegments (wireframe)
// whose own geometry/material would otherwise leak on every video reload.
function disposeWithChildren(obj) {
  if (!obj) return;
  obj.traverse(o => {
    if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (typeof m.dispose === 'function') m.dispose();
    }
  });
}

export function buildSceneFromVolume(tex, w, h, depth) {
  if (state.cube) {
    scene.remove(state.cube);
    disposeWithChildren(state.cube);
  }
  if (state.slicePlane) {
    scene.remove(state.slicePlane);
    disposeWithChildren(state.slicePlane);
  }

  state.numFrames = depth;
  state.frameW = w;
  state.frameH = h;

  if (state.maskTexture) state.maskTexture.dispose();
  state.maskData = new Uint8Array(w * h * depth);
  state.maskTexture = new THREE.Data3DTexture(state.maskData, w, h, depth);
  state.maskTexture.format = THREE.RedFormat;
  state.maskTexture.type = THREE.UnsignedByteType;
  state.maskTexture.minFilter = THREE.LinearFilter;
  state.maskTexture.magFilter = THREE.LinearFilter;
  state.maskTexture.unpackAlignment = 1;
  state.maskTexture.needsUpdate = true;

  state.detectionsPerFrame = [];
  state.tracks = [];
  state.activeTrackIdx = -1;
  // The clear-track button should never linger across reloads
  const clearBtn = document.getElementById('clear-track-btn');
  if (clearBtn) clearBtn.style.display = 'none';

  const aspectY = h / w;
  const depthSliderEl = document.getElementById('depth');
  const depthScale = depthSliderEl ? parseInt(depthSliderEl.value, 10) / 100 : 1;
  state.cubeSize.set(1.0, aspectY, depthScale);

  const boxGeom = new THREE.BoxGeometry(state.cubeSize.x, state.cubeSize.y, state.cubeSize.z);

  state.sliceClippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  // Material flags depend on render mode — opaque uses clipping + depth write,
  // fog/path are transparent ray-marched with no clipping.
  const isOpaque = state.renderMode === 0;
  const cubeMat = new THREE.ShaderMaterial({
    uniforms: {
      uVolume:        { value: tex },
      uMode:          { value: state.renderMode },
      uCubeSize:      { value: state.cubeSize.clone() },
      uOpacity:       { value: state.volumeOpacity },
      uPathSoftness:  { value: state.pathSoftness },
      uCameraLocal:   { value: new THREE.Vector3() },
      uMaskTex:       { value: getMaskTexture() },
      uMaskEnabled:   { value: getMaskEnabled() },
    },
    vertexShader: sharedVertexShader,
    fragmentShader: cubeFragmentShader,
    side: THREE.DoubleSide,
    clippingPlanes: isOpaque ? [state.sliceClippingPlane] : [],
    transparent: !isOpaque,
    depthWrite: isOpaque,
  });

  state.cube = new THREE.Mesh(boxGeom, cubeMat);
  scene.add(state.cube);

  const edges = new THREE.EdgesGeometry(boxGeom);
  const wire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4a5260 }));
  state.cube.add(wire);

  // Slice plane — large enough to fit any orientation through the cube
  const planeSize = Math.max(state.cubeSize.x, state.cubeSize.y, state.cubeSize.z) * 2.0;
  const sliceGeom = new THREE.PlaneGeometry(planeSize, planeSize);

  const sliceMat = new THREE.ShaderMaterial({
    uniforms: {
      uVolume:           { value: tex },
      uCubeSize:         { value: state.cubeSize.clone() },
      uCubeWorldInverse: { value: new THREE.Matrix4() },
      uMaskTex:          { value: getMaskTexture() },
      uMaskEnabled:      { value: getMaskEnabled() },
    },
    vertexShader: sharedVertexShader,
    fragmentShader: sliceFragmentShader,
    side: THREE.DoubleSide,
  });

  state.slicePlane = new THREE.Mesh(sliceGeom, sliceMat);
  state.slicePlane.rotation.set(0, 0, 0);
  state.slicePlane.position.set(0, 0, 0);
  scene.add(state.slicePlane);

  const sliceEdges = new THREE.EdgesGeometry(sliceGeom);
  const sliceWire = new THREE.LineSegments(
    sliceEdges,
    new THREE.LineBasicMaterial({ color: 0xff8a4c, transparent: true, opacity: 0.4 })
  );
  state.slicePlane.add(sliceWire);

  buildOrthoMaterials(tex, getMaskTexture(), getMaskEnabled());
  sizeOrthoCanvas(orthoXY, w / h);
  sizeOrthoCanvas(orthoXT, w / depth);
  sizeOrthoCanvas(orthoYT, h / depth);
}

// Rebuild the slice plane's geometry when the cube grows enough that the
// existing 2× plane no longer spans an oblique cut through it.
export function resizeSlicePlaneToCube() {
  if (!state.slicePlane) return;
  const needed = Math.max(state.cubeSize.x, state.cubeSize.y, state.cubeSize.z) * 2.0;
  // Avoid pointless geometry churn — only rebuild when noticeably small.
  const sliceGeom = state.slicePlane.geometry;
  const params = sliceGeom && sliceGeom.parameters;
  const current = params ? params.width : 0;
  if (Math.abs(current - needed) < 1e-3) return;

  // Replace plane geometry
  sliceGeom.dispose();
  state.slicePlane.geometry = new THREE.PlaneGeometry(needed, needed);

  // Rebuild the outline wireframe child
  const wire = state.slicePlane.children[0];
  if (wire) {
    wire.geometry.dispose();
    wire.geometry = new THREE.EdgesGeometry(state.slicePlane.geometry);
  }
}

// ---- Per-frame uniform updates ----
const tmpNormal = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpCamLocal = new THREE.Vector3();
const tmpMatInv = new THREE.Matrix4();
const tmpCenter = new THREE.Vector3();
const tmpCamWorldToSlice = new THREE.Vector3();

export function updateUniforms() {
  if (!state.cube || !state.slicePlane) return;

  // Slice plane's normal in world space (its local +Z)
  tmpNormal.set(0, 0, 1).applyQuaternion(state.slicePlane.quaternion).normalize();
  tmpPos.copy(state.slicePlane.position);

  // Re-orient the clipping plane so the camera-side is the discarded one
  // (the back of the cube + the slice show through).
  tmpCamWorldToSlice.copy(camera.position).sub(tmpPos);
  const camDot = tmpNormal.dot(tmpCamWorldToSlice);
  const sign = camDot > 0 ? 1 : -1;
  state.sliceClippingPlane.normal.copy(tmpNormal).multiplyScalar(sign);
  state.sliceClippingPlane.constant = -state.sliceClippingPlane.normal.dot(tmpPos);

  // Camera in cube-local space (for volume / path ray-marching).
  tmpMatInv.copy(state.cube.matrixWorld).invert();
  tmpCamLocal.copy(camera.position).applyMatrix4(tmpMatInv);
  const cu = state.cube.material.uniforms;
  cu.uCameraLocal.value.copy(tmpCamLocal);
  cu.uMode.value = state.renderMode;
  cu.uOpacity.value = state.volumeOpacity;
  cu.uPathSoftness.value = state.pathSoftness;
  cu.uCubeSize.value.copy(state.cubeSize);

  state.slicePlane.material.uniforms.uCubeWorldInverse.value.copy(tmpMatInv);
  state.slicePlane.material.uniforms.uCubeSize.value.copy(state.cubeSize);

  // Drive the ortho cross-section "cursors" from the slice plane's center.
  if (orthoXY.material) {
    state.slicePlane.updateMatrixWorld();
    tmpCenter.setFromMatrixPosition(state.slicePlane.matrixWorld).applyMatrix4(tmpMatInv);
    const u = tmpCenter.x / state.cubeSize.x + 0.5;
    const v = tmpCenter.y / state.cubeSize.y + 0.5;
    const t = tmpCenter.z / state.cubeSize.z + 0.5;

    orthoXY.material.uniforms.uPos.value = t;
    orthoXY.material.uniforms.uCrossX.value = u;
    orthoXY.material.uniforms.uCrossY.value = v;

    orthoXT.material.uniforms.uPos.value = v;
    orthoXT.material.uniforms.uCrossX.value = u;
    orthoXT.material.uniforms.uCrossT.value = t;

    orthoYT.material.uniforms.uPos.value = u;
    orthoYT.material.uniforms.uCrossY.value = v;
    orthoYT.material.uniforms.uCrossT.value = t;
  }
}
