// Three little WebGL contexts for the XY / XT / YT cross-section previews
// shown in the top-right panel. Each one renders a full-screen quad with a
// shader that does a single axis-aligned slice through the volume.
import * as THREE from 'three';
import {
  orthoVertexShader,
  xyFragmentShader, xtFragmentShader, ytFragmentShader,
} from './shaders.js';

const PREVIEW_WIDTH = 232;

function makeOrthoView(canvasId, fragmentShader) {
  const canvas = document.getElementById(canvasId);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

  return { canvas, renderer, scene, camera, fragmentShader, material: null, quad: null, aspect: 1 };
}

export const orthoXY = makeOrthoView('canvas-xy', xyFragmentShader);
export const orthoXT = makeOrthoView('canvas-xt', xtFragmentShader);
export const orthoYT = makeOrthoView('canvas-yt', ytFragmentShader);
export const orthoViews = [orthoXY, orthoXT, orthoYT];

export function sizeOrthoCanvas(view, aspect) {
  const w = PREVIEW_WIDTH;
  const h = Math.max(24, Math.round(w / aspect));
  view.aspect = aspect;
  view.canvas.style.width = w + 'px';
  view.canvas.style.height = h + 'px';
  view.renderer.setSize(w, h, false);
}

export function buildOrthoMaterials(tex, maskTex, maskEnabled) {
  function setup(view, extraUniforms) {
    if (view.quad) {
      view.scene.remove(view.quad);
      view.quad.material.dispose();
      view.quad.geometry.dispose();
    }
    view.material = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uVolume: { value: tex } }, extraUniforms),
      vertexShader: orthoVertexShader,
      fragmentShader: view.fragmentShader,
    });
    view.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), view.material);
    view.scene.add(view.quad);
  }

  const maskUniforms = () => ({
    uMaskTex:     { value: maskTex },
    uMaskEnabled: { value: maskEnabled },
  });

  setup(orthoXY, Object.assign({
    uPos:    { value: 0.5 },
    uCrossX: { value: 0.5 },
    uCrossY: { value: 0.5 },
  }, maskUniforms()));
  setup(orthoXT, Object.assign({
    uPos:    { value: 0.5 },
    uCrossX: { value: 0.5 },
    uCrossT: { value: 0.5 },
  }, maskUniforms()));
  setup(orthoYT, Object.assign({
    uPos:    { value: 0.5 },
    uCrossY: { value: 0.5 },
    uCrossT: { value: 0.5 },
  }, maskUniforms()));
}
