// Three.js renderer, camera, scene, orbit controls, and the placeholder
// 1×1×1 mask texture used before a real video is loaded.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const canvasEl = document.getElementById('three');
export const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

export const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(2.2, 1.8, 2.6);
camera.lookAt(0, 0, 0);

export const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 0, 0);

const grid = new THREE.GridHelper(4, 16, 0x222633, 0x1a1d24);
grid.position.y = -0.8;
scene.add(grid);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 1×1×1 placeholder mask texture used until a real video is loaded.
function makeDummyMaskTexture() {
  const tex = new THREE.Data3DTexture(new Uint8Array([0]), 1, 1, 1);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
export const dummyMaskTexture = makeDummyMaskTexture();
