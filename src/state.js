// Shared mutable app state. Modules import this object and mutate its fields.
// Three.js objects are created lazily once a video has been loaded.
import * as THREE from 'three';

export const state = {
  // Volume
  volumeTexture: null,
  cubeSize: new THREE.Vector3(1, 1, 1), // x = width, y = video aspect, z = configurable depth
  numFrames: 0,
  frameW: 0,
  frameH: 0,

  // Scene objects (set by cube.js after a video loads)
  cube: null,
  slicePlane: null,
  sliceClippingPlane: null,

  // Rendering modes
  renderMode: 0,      // 0 = opaque, 1 = volume fog, 2 = path
  volumeOpacity: 0.5, // density slider [0, 1]
  pathSoftness: 0.3,  // 0 = crisp MIP, 1 = soft fog

  // Selection / tools
  selectedTarget: 'slice', // 'slice' | 'cube'

  // Detection state
  detectionsPerFrame: [], // [{bbox, class, score, mask, maskW, maskH}, ...] per frame
  tracks: [],              // computed object tracks
  activeTrackIdx: -1,      // currently followed track index
  maskTexture: null,       // Data3DTexture (R8, W × H × numFrames)
  maskData: null,          // Uint8Array backing maskTexture
  isBuildingMask: false,
};
