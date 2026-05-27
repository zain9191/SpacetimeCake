// GLSL shaders for the spacetime cube. Three.js will compile these as
// fragment shaders for WebGL2. The mask helper is shared by every shader
// that samples the volume.

// Reusable mask helper — checks if a volume voxel is inside the
// tracked object's silhouette. uMaskEnabled gates the check (so when
// no track is active, every voxel passes).
export const maskHelperGLSL = /* glsl */ `
  uniform highp sampler3D uMaskTex;
  uniform bool uMaskEnabled;

  bool insideMask(float u, float v, float t) {
    if (!uMaskEnabled) return true;
    return texture(uMaskTex, vec3(u, v, clamp(t, 0.0, 1.0))).r > 0.5;
  }
`;

// Shared vertex shader (cube + slice plane): pass world and local position.
export const sharedVertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  void main() {
    vLocalPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Cube fragment — handles all three render modes (opaque, fog, path).
export const cubeFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolume;
  uniform int uMode;             // 0 = opaque, 1 = volume fog, 2 = path
  uniform vec3 uCubeSize;        // half-extents are uCubeSize * 0.5
  uniform float uOpacity;        // density in volume mode
  uniform float uPathSoftness;   // 0 = crisp MIP, 1 = soft fog (Path mode)
  uniform vec3 uCameraLocal;     // camera position in cube-local space

  ${maskHelperGLSL}

  varying vec3 vLocalPos;
  varying vec3 vWorldPos;

  vec2 rayBoxIntersect(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax) {
    vec3 invD = 1.0 / rd;
    vec3 t0 = (boxMin - ro) * invD;
    vec3 t1 = (boxMax - ro) * invD;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tNear = max(max(tmin.x, tmin.y), tmin.z);
    float tFar  = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(tNear, tFar);
  }

  vec3 localToVolumeUV(vec3 local) {
    return local / uCubeSize + 0.5;
  }

  void main() {
    if (uMode == 0) {
      vec3 uv = localToVolumeUV(vLocalPos);
      if (!insideMask(uv.x, uv.y, uv.z)) discard;
      vec4 col = texture(uVolume, uv);
      gl_FragColor = vec4(col.rgb, 1.0);
      return;
    }

    vec3 boxMin = -uCubeSize * 0.5;
    vec3 boxMax =  uCubeSize * 0.5;
    vec3 rayDir = normalize(vLocalPos - uCameraLocal);
    vec2 tHit = rayBoxIntersect(uCameraLocal, rayDir, boxMin, boxMax);
    float tStart = max(tHit.x, 0.0);
    float tEnd = tHit.y;
    if (tEnd <= tStart) discard;

    const int MAX_STEPS = 192;
    float stepSize = (tEnd - tStart) / float(MAX_STEPS);
    vec3 pos = uCameraLocal + rayDir * tStart;
    vec3 stepVec = rayDir * stepSize;

    if (uMode == 1) {
      vec4 acc = vec4(0.0);
      for (int i = 0; i < MAX_STEPS; i++) {
        vec3 uv = localToVolumeUV(pos);
        if (insideMask(uv.x, uv.y, uv.z)) {
          vec4 s = texture(uVolume, uv);
          float density = dot(s.rgb, vec3(0.299, 0.587, 0.114));
          float a = density * uOpacity * (stepSize * 4.0);
          a = clamp(a, 0.0, 1.0);
          acc.rgb += (1.0 - acc.a) * s.rgb * a;
          acc.a   += (1.0 - acc.a) * a;
          if (acc.a >= 0.99) break;
        }
        pos += stepVec;
      }
      if (acc.a < 0.001) discard;
      gl_FragColor = acc;
      return;
    }

    // Path mode (uMode == 2): blend MIP with sharper fog by uPathSoftness.
    vec3 mipCol = vec3(0.0);
    float mipBright = 0.0;
    vec4 fogAcc = vec4(0.0);
    float foundAny = 0.0;
    float fogDensity = mix(2.5, 0.6, uPathSoftness);

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 uv = localToVolumeUV(pos);
      if (insideMask(uv.x, uv.y, uv.z)) {
        vec3 c = texture(uVolume, uv).rgb;
        float bright = dot(c, vec3(0.299, 0.587, 0.114));
        foundAny = 1.0;

        if (bright > mipBright) {
          mipBright = bright;
          mipCol = c;
        }

        float a = max(bright, 0.15) * fogDensity * (stepSize * 4.0);
        a = clamp(a, 0.0, 1.0);
        fogAcc.rgb += (1.0 - fogAcc.a) * c * a;
        fogAcc.a   += (1.0 - fogAcc.a) * a;
        if (fogAcc.a >= 0.99 && uPathSoftness > 0.5) break;
      }
      pos += stepVec;
    }

    if (foundAny < 0.5) discard;

    vec3 finalCol = mix(mipCol, fogAcc.rgb, uPathSoftness);
    float finalA  = mix(1.0,     fogAcc.a,  uPathSoftness);
    if (finalA < 0.001) discard;
    gl_FragColor = vec4(finalCol, finalA);
  }
`;

// Slice plane fragment — samples the volume at the plane's intersection.
export const sliceFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolume;
  uniform vec3 uCubeSize;
  uniform mat4 uCubeWorldInverse;

  ${maskHelperGLSL}

  varying vec3 vWorldPos;

  void main() {
    vec3 local = (uCubeWorldInverse * vec4(vWorldPos, 1.0)).xyz;
    vec3 uv = local / uCubeSize + 0.5;

    if (any(lessThan(uv, vec3(0.0))) || any(greaterThan(uv, vec3(1.0)))) {
      discard;
    }
    if (!insideMask(uv.x, uv.y, uv.z)) discard;

    vec4 col = texture(uVolume, uv);
    gl_FragColor = vec4(col.rgb, 1.0);
  }
`;

// Orthogonal-view shaders share this simple full-screen vertex shader.
export const orthoVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// XY — fixed Z (time). The preview looks like a single video frame.
export const xyFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform float uPos;
  uniform float uCrossX;
  uniform float uCrossY;

  ${maskHelperGLSL}

  varying vec2 vUv;

  void main() {
    float z = clamp(uPos, 0.0, 1.0);
    if (!insideMask(vUv.x, vUv.y, z)) discard;
    vec4 col = texture(uVolume, vec3(vUv.x, vUv.y, z));
    float dx = abs(vUv.x - uCrossX);
    float dy = abs(vUv.y - uCrossY);
    float lineW = 0.0015;
    float line = step(dx, lineW) + step(dy, lineW);
    vec3 outCol = mix(col.rgb, vec3(1.0, 0.541, 0.298), clamp(line, 0.0, 1.0) * 0.6);
    gl_FragColor = vec4(outCol, 1.0);
  }
`;

// XT — X horizontal, Time vertical, fixed Y.
export const xtFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform float uPos;
  uniform float uCrossX;
  uniform float uCrossT;

  ${maskHelperGLSL}

  varying vec2 vUv;

  void main() {
    float y = clamp(uPos, 0.0, 1.0);
    if (!insideMask(vUv.x, y, vUv.y)) discard;
    vec4 col = texture(uVolume, vec3(vUv.x, y, vUv.y));
    float dx = abs(vUv.x - uCrossX);
    float dt = abs(vUv.y - uCrossT);
    float lineW = 0.0015;
    float line = step(dx, lineW) + step(dt, lineW);
    vec3 outCol = mix(col.rgb, vec3(1.0, 0.541, 0.298), clamp(line, 0.0, 1.0) * 0.6);
    gl_FragColor = vec4(outCol, 1.0);
  }
`;

// YT — Y horizontal, Time vertical, fixed X.
export const ytFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform float uPos;
  uniform float uCrossY;
  uniform float uCrossT;

  ${maskHelperGLSL}

  varying vec2 vUv;

  void main() {
    float x = clamp(uPos, 0.0, 1.0);
    if (!insideMask(x, vUv.x, vUv.y)) discard;
    vec4 col = texture(uVolume, vec3(x, vUv.x, vUv.y));
    float dy = abs(vUv.x - uCrossY);
    float dt = abs(vUv.y - uCrossT);
    float lineW = 0.0015;
    float line = step(dy, lineW) + step(dt, lineW);
    vec3 outCol = mix(col.rgb, vec3(1.0, 0.541, 0.298), clamp(line, 0.0, 1.0) * 0.6);
    gl_FragColor = vec4(outCol, 1.0);
  }
`;
