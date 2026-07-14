/* i am — album home. A live three.js rebuild of Flower_v9.blend (Eevee).
   The GLB is Blender→glTF (Y-up); rotating the flower group +90° about X
   cancels that conversion, so world coordinates equal Blender coordinates —
   every light/camera/petal position below is copied verbatim from the .blend.
   The camera ORBITS the flower's heart (never translates), so the parallax
   reads as real depth; pollen drifts upward; the song name floats outside
   the hovered petal. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

/* ================= tracks =================
   Petals, clockwise from the top: 1=top, 5=top-right, 4=bottom-right,
   3=bottom, 2=left. Album order maps clockwise from the top. Only "I Am"
   is live; the rest read "coming soon" until each video ships. Swap a url
   in and it goes live — nothing else to change. */
const TRACKS = {
  petal_1: { title: 'Insecure',        url: null },
  petal_5: { title: 'You Hurt Me',     url: null },
  petal_4: { title: 'I Miss You',      url: null },
  petal_3: { title: 'Memories of Me',  url: null },
  petal_2: { title: 'I Am',            url: 'https://clayandkelsy.com/i-am-i-am/' },
};

/* ================= tunables ================= */
const P = {
  exposure: 0.5,          // master multiplier on every light
  keyIntensity: 536,      // 2000W spot, cone-concentrated (W / 2π(1−cosθ))
  areaIntensity: 18.4,    // 1570W over 1×27.2m strip (W / area / π)
  pointScale: 0.0796,     // point W → intensity (W / 4π), Eevee-equivalent
  ambient: 0.09,

  bloomStrength: 0.05,    // subtle — the petals are near-white, so bloom easily
  bloomRadius: 0.7,
  bloomThreshold: 0.86,   // only the true speculars bloom, not the whole petal

  contrast: 1.14,
  pivot: 0.42,
  shoulder: 0.55,         // filmic highlight rolloff (keeps petal detail near white)
  grain: 0.014,           // tasteful — barely-there film texture
  vignette: 0.2,

  sssScale: 0.42,         // petal translucency (pointLights[i].color has intensity)
  sssDistortion: 0.5,
  sssPower: 2.2,
  sssAmbient: 0.004,
  breathe: 0.12,          // inner-light breathing depth

  zoom: 0.66,             // <1 = closer than the album framing (more 3D)
  composeY: -1.15,        // look a touch below the heart → bloom sits high
  maxYaw: 0.135,          // rad — orbit amplitude on the mouse X axis (~7.7°)
  maxPitch: 0.092,        // rad — orbit amplitude on the mouse Y axis (~5.3°)
  orbitSmooth: 0.55,      // seconds — critically-damped follow (buttery)
  driftYaw: 0.4,          // idle orbit, as a fraction of maxYaw
  driftPitch: 0.34,
  gyroDeg: 16,            // phone tilt (deg) for full gyro throw
  gyroThrow: 0.6,

  breezeNod: 0.02,        // rad — whole-flower nod (toward/away) in the breeze
  breezeYaw: 0.019,       // rad — whole-flower turn (shows petal sides)
  breezeRoll: 0.011,      // rad — slight roll
  petalWind: 0.085,       // scene units — petal-edge flutter (tips only, base anchored)
  pollenPull: 0.16,       // how much pollen leans toward the cursor (magnetic drift)

  dragSpeed: 0.0044,      // rad per pixel dragged (click-drag to look around)
  maxYawOrbit: 0.8,       // rad (~46°) — rich 3D sides, stays inside the (original) wall's edge
  maxPitchOrbit: 0.4,     // rad (~23°) — look over/under without exposing the wall edge
};

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = matchMedia('(pointer: coarse)').matches;

/* ================= renderer ================= */
const canvas = document.getElementById('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  document.getElementById('fallback').hidden = false;
  throw e;
}
renderer.toneMapping = THREE.NoToneMapping;   // Blender view transform was "Standard"; rolloff done in the grade
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;   // Eevee spot had radius 4 — very soft
// The shadow renders every frame (measured ~free). Freezing it was a false
// economy: it went stale/garbage after any GPU blip and snapped as the flower
// swayed — the "strange shadow popping in and out". Auto-updating self-heals.
let maxDpr = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(maxDpr);

// if the GPU ever drops the WebGL context, keep it (preventDefault lets the
// browser restore it) and redraw once it's back — the auto-updating shadow
// re-renders itself, so nothing stays corrupted
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
canvas.addEventListener('webglcontextrestored', () => { resize(); renderFrame(); }, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.014, 0.013, 0.012);

/* camera: 50mm / 36mm sensor (square vfov = 39.6°) */
const CAM = { vfovSquare: 2 * Math.atan(18 / 50) };
const camera = new THREE.PerspectiveCamera(39.6, 1, 0.5, 140);

/* orbit rig: the flower's heart is world-origin (center_disc sits at 0,0,0) */
const PIVOT = new THREE.Vector3(0, 0, 0);
const REST = new THREE.Vector3(0.086222, -1.845463, 37.647198);  // Blender camera == world
const baseOffset = REST.clone().sub(PIVOT).multiplyScalar(P.zoom);
const lookTarget = new THREE.Vector3();
const _off = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function frameCamera() {
  const w = canvas.clientWidth || innerWidth || 1;
  const h = canvas.clientHeight || innerHeight || 1;
  const aspect = w / h;
  const t = Math.tan(CAM.vfovSquare / 2) * 1.02;
  const vt = aspect >= 1 ? t : t / aspect;   // portrait: lock horizontal framing
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(vt));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

function placeCamera(yaw, pitch) {
  _off.copy(baseOffset);
  _euler.set(pitch, yaw, 0);
  _off.applyEuler(_euler);
  camera.position.copy(PIVOT).add(_off);
  lookTarget.set(PIVOT.x, PIVOT.y + P.composeY, PIVOT.z);
  camera.lookAt(lookTarget);
}

/* flower rig: an outer sway group pivots the whole bloom around a point
   down the stem (so the breeze reads as the stem flexing, not a spin in
   place); the inner group's +90° about X cancels the glTF Y-up conversion */
const SWAY_PIVOT_Y = -5;
const swayGroup = new THREE.Group();
swayGroup.position.set(0, SWAY_PIVOT_Y, 0);
scene.add(swayGroup);
const flower = new THREE.Group();
flower.rotation.x = Math.PI / 2;
flower.position.set(0, -SWAY_PIVOT_Y, 0);   // returns the bloom's heart to world origin
swayGroup.add(flower);

/* ================= lights (verbatim from the .blend) ================= */
RectAreaLightUniformsLib.init();
const lights = {};

const key = new THREE.SpotLight(0xffffff, P.keyIntensity, 0, 2.30690 / 2, 0.43602, 2);
key.position.set(2.877, 4.619, 13.629);
key.target.position.set(1.764, 6.114, 3.804);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.04;
key.shadow.radius = 9;
key.shadow.blurSamples = 16;
key.shadow.camera.near = 5; key.shadow.camera.far = 45;
scene.add(key, key.target);
lights.key = key;

const area = new THREE.RectAreaLight(0xffffff, P.areaIntensity, 1.0, 27.228);
area.position.set(-0.269, 0.122, 24.044);
area.lookAt(-0.269, 0.122, 0);
scene.add(area);
lights.area = area;

/* the bioluminescence: seven tinted points tucked behind/under the petals */
const INNER = [
  { p: [ 2.296,  0.471, -1.437], c: [1, 1, 1],                E: 60, rate: 0.23, ph: 0.0 },
  { p: [-0.478,  2.709, -1.514], c: [0.852254, 1, 0.971094],  E: 20, rate: 0.31, ph: 1.7 },
  { p: [ 1.914, -3.725,  0.458], c: [0.959693, 1, 0.760147],  E: 10, rate: 0.27, ph: 3.1 },
  { p: [-3.659, -0.299, -1.452], c: [1, 1, 1],                E: 10, rate: 0.21, ph: 4.4 },
  { p: [-1.941, -2.031, -1.141], c: [1, 1, 1],                E: 45, rate: 0.29, ph: 2.2 },
  { p: [ 1.910, -2.475, -1.982], c: [0.827571, 1, 1],         E: 20, rate: 0.25, ph: 5.3 },
  { p: [-0.552, -2.941, -1.009], c: [1, 1, 1],                E: 20, rate: 0.33, ph: 0.9 },
];
lights.inner = INNER.map((d) => {
  const L = new THREE.PointLight(new THREE.Color().setRGB(...d.c), 0, 0, 2);
  L.position.set(...d.p);
  L.userData = { base: d.E * P.pointScale, rate: d.rate, ph: d.ph };
  scene.add(L);
  return L;
});

const amb = new THREE.AmbientLight(0xffffff, P.ambient);
scene.add(amb);
lights.ambient = amb;

function applyLightExposure(wake = 1) {
  const e = P.exposure * wake;
  key.intensity = P.keyIntensity * e;
  area.intensity = P.areaIntensity * e;
  amb.intensity = P.ambient * e;
}

/* ================= materials ================= */
function C(r, g, b) { return new THREE.Color().setRGB(r, g, b); }
const petalShaders = {};

function makePetalMaterial(name) {
  const m = new THREE.MeshPhysicalMaterial({
    color: C(0.9849, 1.0, 0.96994),
    roughness: 0.85,
    specularIntensity: 0.32,
    side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSSSColor = { value: C(1.0, 0.86, 0.68) };
    shader.uniforms.uSSSScale = { value: P.sssScale };
    shader.uniforms.uSSSDistortion = { value: P.sssDistortion };
    shader.uniforms.uSSSPower = { value: P.sssPower };
    shader.uniforms.uSSSAmbient = { value: P.sssAmbient };
    shader.uniforms.uGlow = { value: 0 };
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWindAmp = { value: 0 };
    shader.uniforms.uWindDir = { value: new THREE.Vector3(0, 0, 1) };
    // wind: flutter the petal EDGES (weighted by distance from the flower's
    // heart, so the base stays anchored and the click target barely moves).
    // uWindDir is the object-space wind direction, precomputed per frame on
    // the CPU — a shared delta for coincident front/back rim verts (no split),
    // and no per-vertex matrix inverse (much cheaper than it looks).
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `uniform float uTime, uWindAmp;
uniform vec3 uWindDir;
void main() {`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  float w = smoothstep( 1.3, 5.2, length( wp.xy ) );
  float ph = wp.x * 0.6 + wp.y * 0.55;
  float flex = sin( uTime * 1.5 + ph ) + 0.5 * sin( uTime * 2.3 + ph * 1.7 );
  transformed += uWindDir * ( uWindAmp * w * flex );
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
#if NUM_POINT_LIGHTS > 0
{
  vec3 fragPos = - vViewPosition;
  vec3 V = normalize( vViewPosition );
  vec3 sssTotal = vec3( 0.0 );
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    vec3 lv = pointLights[ i ].position - fragPos;
    float lightDist = length( lv );
    vec3 L = lv / lightDist;
    float atten = getDistanceAttenuation( lightDist, pointLights[ i ].distance, pointLights[ i ].decay );
    vec3 Lt = normalize( L + normal * uSSSDistortion );
    float trans = pow( saturate( dot( V, -Lt ) ), uSSSPower );
    sssTotal += ( trans + uSSSAmbient ) * atten * pointLights[ i ].color;
  }
  sssTotal *= uSSSColor * uSSSScale * ( 1.0 + 2.0 * uGlow );
  reflectedLight.directDiffuse += sssTotal * diffuseColor.rgb;
  reflectedLight.indirectDiffuse += uGlow * uSSSColor * 0.05;
}
#endif`)
      .replace('void main() {', `uniform vec3 uSSSColor;
uniform float uSSSScale, uSSSDistortion, uSSSPower, uSSSAmbient, uGlow;
void main() {`);
    petalShaders[name] = shader;
  };
  m.userData.glow = 0;
  m.userData.glowTarget = 0;
  return m;
}

const MATS = {
  'Material':     () => Object.assign(new THREE.MeshStandardMaterial({ color: C(0.8, 0.60817, 0), roughness: 1 }),
                        { emissive: C(1, 0.49008, 0), emissiveIntensity: 9 }),
  'Material.005': () => Object.assign(new THREE.MeshStandardMaterial({ color: C(1, 0.90841, 0.08731), roughness: 1, side: THREE.DoubleSide }),
                        { emissive: C(0.44792, 0.42757, 0.18255), emissiveIntensity: 1 }),
  'Material.006': () => Object.assign(new THREE.MeshStandardMaterial({ color: C(0.8, 0.75131, 0.09842), roughness: 1 }),
                        { emissive: C(1, 0.86411, 0.12548), emissiveIntensity: 1 }),
  'Stamen':       () => new THREE.MeshStandardMaterial({ color: C(0.01885, 0.01885, 0.01885), roughness: 0.9326 }),
  'StamenHair':   () => new THREE.MeshStandardMaterial({ color: C(0.18446, 0.18446, 0.18446), roughness: 1, side: THREE.DoubleSide }),
  'Stem':         () => new THREE.MeshStandardMaterial({ color: C(0.17886, 0.17886, 0.17886), roughness: 0.5 }),
  'Background':   () => new THREE.MeshStandardMaterial({ color: C(0.17335, 0.16117, 0.14908), roughness: 0.7534 }),
};

/* ================= pollen (GPU points, drifting upward) ================= */
const POLLEN_N = COARSE ? 60 : 96;
const POLLEN_H = 21, POLLEN_HALF = 7.5;   // recycle band: y ∈ [-7.5, 13.5]
let pollen = null, pollenMat = null;

function makePollen() {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(POLLEN_N * 3);
  const speed = new Float32Array(POLLEN_N);
  const phase = new Float32Array(POLLEN_N);
  const amp = new Float32Array(POLLEN_N);
  const scale = new Float32Array(POLLEN_N);
  for (let i = 0; i < POLLEN_N; i++) {
    pos[i * 3]     = (Math.random() * 2 - 1) * 9.5;
    pos[i * 3 + 1] = Math.random() * POLLEN_H;
    pos[i * 3 + 2] = -2 + Math.random() * 5.5;
    speed[i] = 0.35 + Math.random() * 0.7;
    phase[i] = Math.random() * Math.PI * 2;
    amp[i] = 0.25 + Math.random() * 0.7;
    scale[i] = 0.55 + Math.random() * 1.25;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aAmp', new THREE.BufferAttribute(amp, 1));
  g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));

  pollenMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uH: { value: POLLEN_H }, uHalf: { value: POLLEN_HALF },
      uDpr: { value: maxDpr }, uSize: { value: 46 },
      uColor: { value: C(1.0, 0.86, 0.55) }, uOpacity: { value: 0 },
      uAttract: { value: new THREE.Vector3(0, 0, 0) }, uPull: { value: 0 },
    },
    vertexShader: `
      attribute float aSpeed, aPhase, aAmp, aScale;
      uniform float uTime, uH, uHalf, uDpr, uSize, uPull;
      uniform vec3 uAttract;
      varying float vTw;
      void main() {
        vec3 p = position;
        float y = mod(p.y + uTime * aSpeed, uH);
        p.y = y - uHalf;
        p.x += aAmp * sin(uTime * 0.24 + aPhase);
        p.z += aAmp * 0.6 * cos(uTime * 0.19 + aPhase * 1.3);
        // gentle lean toward the cursor — only motes nearby feel the pull
        vec2 toC = uAttract.xy - p.xy;
        p.xy += toC * (uPull * exp(-dot(toC, toC) * 0.028));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * aScale * uDpr / max(-mv.z, 0.001);
        float f = y / uH;
        float edge = smoothstep(0.0, 0.14, f) * (1.0 - smoothstep(0.82, 1.0, f));
        vTw = (0.4 + 0.6 * sin(uTime * aSpeed * 3.0 + aPhase * 2.1)) * edge;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying float vTw;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, r);
        a *= a;
        gl_FragColor = vec4(uColor, a * vTw * uOpacity);
      }`,
  });
  pollen = new THREE.Points(g, pollenMat);
  pollen.frustumCulled = false;
  scene.add(pollen);
}
makePollen();

/* ================= load ================= */
const petals = [];
const _box = new THREE.Box3();
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

loader.load('assets/flower.glb?v=2', (gltf) => {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const matName = o.material?.name || '';
    if (o.name.startsWith('petal_')) {
      o.material = makePetalMaterial(o.name);
      o.castShadow = true;
      o.receiveShadow = true;
      petals.push(o);
    } else if (MATS[matName]) {
      o.material = MATS[matName]();
    }
    if (o.name === 'center_disc' || o.name === 'stem') { o.castShadow = true; o.receiveShadow = true; }
    if (o.name === 'backdrop') o.receiveShadow = true;
  });
  flower.add(gltf.scene);
  flower.updateWorldMatrix(true, true);

  // per-petal 3D anchor for the floating label: push the petal's world
  // centroid outward (in the flower plane) so the name sits just past the tip
  for (const p of petals) {
    _box.setFromObject(p);
    const c = _box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector2(c.x, c.y);
    if (dir.lengthSq() < 1e-4) dir.set(0, 1);
    dir.normalize();
    p.userData.anchor = new THREE.Vector3(dir.x * 7.8, dir.y * 7.8, 1.0);

    // one floating song name per petal
    const el = document.createElement('div');
    el.className = 'song-label';
    el.textContent = TRACKS[p.name]?.title || '';
    el.addEventListener('click', (ev) => { ev.stopPropagation(); navigate(p); });   // tapping the name (mobile) navigates
    labelsWrap.appendChild(el);
    p.userData.labelEl = el;
  }
  updateLabelMode();
  wake();
}, undefined, (err) => {
  console.error('GLB load failed', err);
  document.getElementById('fallback').hidden = false;
});

/* ================= composer ================= */
const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: COARSE ? 0 : 2 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), P.bloomStrength, P.bloomRadius, P.bloomThreshold);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uContrast: { value: P.contrast },
    uPivot: { value: P.pivot },
    uShoulder: { value: P.shoulder },
    uGrain: { value: P.grain },
    uVig: { value: P.vignette },
  },
  vertexShader: `varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uContrast, uPivot, uShoulder, uGrain, uVig;
    uniform vec2 uRes;
    float hash(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }
    // soft filmic shoulder above 0.75 so near-white petals keep their gradient
    vec3 shoulder(vec3 c, float amt){
      vec3 k = max(c - 0.75, 0.0);
      return c - k + (1.0 - exp(-k * 3.2)) * 0.25 * amt + k * (1.0 - amt);
    }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = (c - uPivot) * uContrast + uPivot;
      c = shoulder(clamp(c, 0.0, 4.0), uShoulder);
      float d = distance(vUv * vec2(uRes.x/uRes.y, 1.0), vec2(0.5 * uRes.x/uRes.y, 0.5));
      c *= 1.0 - uVig * smoothstep(0.34, 0.98, d);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float g = hash(vUv * uRes + mod(uTime, 97.0)) - 0.5;      // grain, shadow-weighted
      c += g * uGrain * (0.35 + 0.65 * (1.0 - clamp(l, 0.0, 1.0)));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};
const grade = new ShaderPass(GradeShader);
composer.addPass(grade);

/* ================= interaction ================= */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2(-2, -2);
const labelsWrap = document.getElementById('labels');
const flashEl = document.getElementById('flash');
let hovered = null;

// orbit input, in -1..1 (hover/gyro parallax — a small overlay on the drag)
const aim = { tx: 0, ty: 0 };
let yaw = 0, pitch = 0;               // smoothed camera angles
const yawVel = { v: 0 }, pitchVel = { v: 0 };
let dragYaw = 0, dragPitch = 0;      // accumulated by click-drag (yaw spins a full 360°)
let lastInput = -10;

// drag vs. click
let dragId = null, dragMoved = false, dragPX = 0, dragPY = 0;
const DRAG_THRESH = 6;   // px of movement before a press becomes a drag (not a click)

function setPointer(clientX, clientY) {
  const w = innerWidth || canvas.clientWidth || 1;
  const h = innerHeight || canvas.clientHeight || 1;
  aim.tx = (clientX / w) * 2 - 1;
  aim.ty = (clientY / h) * 2 - 1;
  ndc.set(aim.tx, -aim.ty);
  lastInput = clock.elapsedTime;
}

/* gyroscope: phone tilt orbits the camera (iOS asks permission on first tap) */
let gyroBase = null, gyroArmed = false;
function onGyro(e) {
  if (e.gamma == null || e.beta == null) return;
  if (gyroBase === null) gyroBase = { g: e.gamma, b: e.beta };
  aim.tx = THREE.MathUtils.clamp((e.gamma - gyroBase.g) / P.gyroDeg, -1, 1) * P.gyroThrow;
  aim.ty = THREE.MathUtils.clamp((e.beta - gyroBase.b) / P.gyroDeg, -1, 1) * P.gyroThrow;
  lastInput = clock.elapsedTime;
}
function armGyro() {
  if (gyroArmed || !COARSE) return;
  gyroArmed = true;
  const DOE = window.DeviceOrientationEvent;
  if (DOE?.requestPermission) {
    DOE.requestPermission().then((s) => { if (s === 'granted') addEventListener('deviceorientation', onGyro); }).catch(() => {});
  } else if (DOE) {
    addEventListener('deviceorientation', onGyro);
  }
}

function petalAt() {
  if (!petals.length) return null;
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(petals, false)[0];
  return hit ? hit.object : null;
}

/* label "menu mode": on touch devices OR narrow windows every song name is
   shown (and tappable) — people without a mouse can see and pick. On a wide
   desktop the names reveal on hover. Recomputed live on every resize. */
let labelMenu = false;
function updateLabelMode() {
  labelMenu = COARSE || (innerWidth || 1) < 820;
  document.body.classList.toggle('labels-menu', labelMenu);
  for (const p of petals) p.userData.labelEl?.classList.toggle('show', labelMenu || p === hovered);
}

// desktop hover: glow the petal + reveal only its name (menu mode keeps all shown)
function setHover(petal) {
  if (COARSE || hovered === petal) return;
  if (hovered) { hovered.material.userData.glowTarget = 0; if (!labelMenu) hovered.userData.labelEl?.classList.remove('show'); }
  hovered = petal;
  if (petal) {
    petal.material.userData.glowTarget = 1;
    petal.userData.labelEl?.classList.add('show');
    document.body.classList.add('hovering', 'reading');   // let the chrome recede
  } else {
    document.body.classList.remove('hovering', 'reading');
  }
}

function navigate(petal) {
  const t = TRACKS[petal.name];
  if (!t?.url) return;
  if (REDUCE) { window.open(t.url, '_top'); return; }
  flashEl.classList.add('on');                       // white fade covers the load; i-am opens on white
  setTimeout(() => window.open(t.url, '_top'), 330);
}

addEventListener('pointerdown', (e) => {
  dragId = e.pointerId; dragMoved = false; dragPX = e.clientX; dragPY = e.clientY;
  setPointer(e.clientX, e.clientY);
  armGyro();
});

addEventListener('pointermove', (e) => {
  if (dragId === e.pointerId) {                       // dragging → orbit
    const dx = e.clientX - dragPX, dy = e.clientY - dragPY;
    if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESH) { dragMoved = true; setHover(null); document.body.classList.add('grabbing'); }
    if (dragMoved) {
      dragYaw = THREE.MathUtils.clamp(dragYaw - dx * P.dragSpeed, -P.maxYawOrbit, P.maxYawOrbit);
      dragPitch = THREE.MathUtils.clamp(dragPitch + dy * P.dragSpeed, -P.maxPitchOrbit, P.maxPitchOrbit);
      dragPX = e.clientX; dragPY = e.clientY;
      lastInput = clock.elapsedTime;
    }
    return;
  }
  setPointer(e.clientX, e.clientY);                   // not dragging → hover parallax + petal hover
  if (!COARSE) setHover(petalAt());
});

function endDrag(e) {
  if (dragId !== e.pointerId) return;
  const wasDrag = dragMoved;
  dragId = null; dragMoved = false;
  document.body.classList.remove('grabbing');
  if (!wasDrag) {                                     // a real click/tap → navigate the petal under it
    setPointer(e.clientX, e.clientY);
    const petal = petalAt();
    if (petal) navigate(petal);
  }
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', () => { dragId = null; dragMoved = false; document.body.classList.remove('grabbing'); });

/* ================= math ================= */
// Unity-style critically-damped smoothing — no overshoot, frame-rate independent
function smoothDamp(cur, target, velRef, smoothTime, dt) {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (velRef.v + omega * change) * dt;
  velRef.v = (velRef.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/* ================= life ================= */
const clock = new THREE.Clock();
let wakeT = REDUCE ? 1 : 0;
let awake = false;
const _proj = new THREE.Vector3();
const _attract = new THREE.Vector3();
const _flowerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);   // z=0, the bloom's plane
const _m3 = new THREE.Matrix3();
const _wdir = new THREE.Vector3();
const WORLD_WIND = new THREE.Vector3(0.22, 0.14, 1.0);   // world-space flutter direction (toward camera + a little lateral)

function wake() {
  // No dark "wake-in" ramp: render the first frame FULLY lit (shadow included)
  // BEFORE the loading veil fades, so the reveal is a clean crossfade onto the
  // finished scene — no black cut, no dim glitchy background easing in.
  awake = true;
  wakeT = 1;
  renderFrame();
  document.body.classList.add('awake');
}

function updateLabels() {
  const w = innerWidth || 1, h = innerHeight || 1;
  for (const p of petals) {
    const el = p.userData.labelEl;
    if (!el || !el.classList.contains('show')) continue;
    _proj.copy(p.userData.anchor).project(camera);
    if (_proj.z > 1) { el.style.visibility = 'hidden'; continue; }   // anchor swung behind the camera → hide
    el.style.visibility = '';
    el.style.left = THREE.MathUtils.clamp((_proj.x * 0.5 + 0.5) * w, 70, w - 70) + 'px';
    el.style.top  = THREE.MathUtils.clamp((-_proj.y * 0.5 + 0.5) * h, 118, h - 92) + 'px';   // 118: stay clear of the wordmark
  }
}

function tick(dt, t) {
  if (awake && wakeT < 1) wakeT = Math.min(1, wakeT + dt / 2.6);
  const ease = wakeT * wakeT * (3 - 2 * wakeT);

  applyLightExposure(0.25 + 0.75 * ease);
  for (const L of lights.inner) {
    const b = REDUCE ? 1 : 1 + P.breathe * Math.sin(t * L.userData.rate * Math.PI * 2 + L.userData.ph);
    L.intensity = L.userData.base * P.exposure * b * ease;
  }
  bloom.strength = P.bloomStrength * (REDUCE ? 1 : 1 + 0.08 * Math.sin(t * 0.11 * Math.PI * 2)) * ease;
  if (pollenMat) { pollenMat.uniforms.uTime.value = t; pollenMat.uniforms.uOpacity.value = ease; }

  // ---- gentle breeze: nod the whole bloom + flutter the petal edges ----
  const gust = REDUCE ? 0 : (0.72 + 0.28 * Math.sin(t * 0.047 + 0.6)) * ease;   // slow gust envelope
  swayGroup.rotation.set(
    P.breezeNod  * gust * (0.6 * Math.sin(t * 0.23)       + 0.4 * Math.sin(t * 0.41 + 1.3)),
    P.breezeYaw  * gust * (0.6 * Math.sin(t * 0.19 + 0.7) + 0.4 * Math.sin(t * 0.33 + 2.1)),
    P.breezeRoll * gust *  Math.sin(t * 0.21 + 0.5),
  );
  swayGroup.updateMatrixWorld(true);   // so each petal's matrixWorld is current for the wind-direction uniform below

  // orbit = accumulated drag (full 360°) + a small hover/gyro parallax + idle drift
  const overlay = dragId === null ? 1 : 0;   // no parallax while a drag is in progress
  const idle = REDUCE ? 0 : THREE.MathUtils.clamp((t - lastInput - 2.5) / 3, 0, 1);
  const driftY = overlay * idle * P.driftYaw * P.maxYaw * Math.sin(t * 0.16);
  const driftP = overlay * idle * P.driftPitch * P.maxPitch * Math.sin(t * 0.13 + 1.3);
  const yawT = THREE.MathUtils.clamp(dragYaw + overlay * aim.tx * P.maxYaw + driftY, -P.maxYawOrbit, P.maxYawOrbit);
  const pitchT = THREE.MathUtils.clamp(dragPitch + overlay * aim.ty * P.maxPitch + driftP, -P.maxPitchOrbit, P.maxPitchOrbit);
  if (REDUCE) { yaw = yawT; pitch = pitchT; }
  else {
    yaw = smoothDamp(yaw, yawT, yawVel, P.orbitSmooth, dt);
    pitch = smoothDamp(pitch, pitchT, pitchVel, P.orbitSmooth, dt);
  }
  placeCamera(yaw, pitch);

  const windAmp = P.petalWind * (0.6 + 0.4 * gust);
  for (const p of petals) {
    const ud = p.material.userData;
    ud.glow += (ud.glowTarget - ud.glow) * Math.min(1, dt * 6.5);
    const sh = petalShaders[p.name];
    if (sh) {
      sh.uniforms.uGlow.value = ud.glow;
      sh.uniforms.uTime.value = t;
      sh.uniforms.uWindAmp.value = windAmp;
      // object-space wind direction = inverse(rotation) * world direction (cheap, per petal)
      _wdir.copy(WORLD_WIND).applyMatrix3(_m3.setFromMatrix4(p.matrixWorld).invert());
      sh.uniforms.uWindDir.value.copy(_wdir);
    }
  }

  // ---- pollen leans toward the cursor (world point where the ray meets the bloom plane) ----
  if (pollenMat) {
    let pullTarget = 0;
    if (!COARSE) {
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(_flowerPlane, _attract)) {
        pollenMat.uniforms.uAttract.value.copy(_attract);
        pullTarget = P.pollenPull * (1 - 0.6 * idle);
      }
    }
    pollenMat.uniforms.uPull.value += (pullTarget - pollenMat.uniforms.uPull.value) * Math.min(1, dt * 2.5);
  }

  updateLabels();
  grade.uniforms.uTime.value = REDUCE ? 1 : t;
}

function renderFrame() {
  tick(1 / 60, clock.elapsedTime);
  composer.render();
}

/* adaptive resolution: drop pixel ratio if we can't hold framerate */
let slow = 0;
function adapt(dt) {
  if (dt > 0.024) slow++; else slow = Math.max(0, slow - 2);
  if (slow > 90 && maxDpr > 1) {
    maxDpr = Math.max(1, maxDpr - 0.5);
    renderer.setPixelRatio(maxDpr);
    if (pollenMat) pollenMat.uniforms.uDpr.value = maxDpr;
    resize();
    slow = 0;
  }
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  tick(dt, clock.elapsedTime);
  composer.render();
  adapt(dt);
});

/* ================= dynamic orbit clamp ================= */
/* The backdrop is a finite plane; how far you can orbit before its edge
   enters frame depends on the viewport's aspect. Rather than a fixed cap
   that's either edge-showing on wide screens or tiny on tall ones, we solve
   for the largest orbit (keeping the desired yaw:pitch ratio) where all four
   screen corners still land inside the wall — recomputed on every resize. */
const DESIRED_YAW = 0.8, DESIRED_PITCH = 0.4;   // rad — the most we'd ever want (~46° / 23°)
const WALL = { minx: -28.4, maxx: 28.3, miny: -28.3, maxy: 28.3, z: -1.96, margin: 1.6 };
const _corner = new THREE.Vector3();

function orbitCornersClear(scale) {
  for (const sy of [-1, 1]) for (const sp of [-1, 1]) {
    placeCamera(sy * scale * DESIRED_YAW, sp * scale * DESIRED_PITCH);
    camera.updateMatrixWorld(true);
    const o = camera.position;
    for (const nx of [-1, 1]) for (const ny of [-1, 1]) {
      _corner.set(nx, ny, 0.5).unproject(camera);
      const t = (WALL.z - o.z) / (_corner.z - o.z);
      if (t < 0) return false;                       // wall behind the camera → edge/void in view
      const hx = o.x + (_corner.x - o.x) * t;
      const hy = o.y + (_corner.y - o.y) * t;
      if (hx < WALL.minx + WALL.margin || hx > WALL.maxx - WALL.margin ||
          hy < WALL.miny + WALL.margin || hy > WALL.maxy - WALL.margin) return false;
    }
  }
  return true;
}

function computeOrbitCaps() {
  let lo = 0, hi = 1;
  if (orbitCornersClear(1)) lo = 1;                  // the full desired orbit already fits
  else for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (orbitCornersClear(mid)) lo = mid; else hi = mid; }
  P.maxYawOrbit = lo * DESIRED_YAW;
  P.maxPitchOrbit = lo * DESIRED_PITCH;
  placeCamera(yaw, pitch);                           // restore the live view
}

/* ================= resize ================= */
function resize() {
  const w = canvas.clientWidth || innerWidth || 1;
  const h = canvas.clientHeight || innerHeight || 1;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  grade.uniforms.uRes.value.set(w * maxDpr, h * maxDpr);
  frameCamera();
  computeOrbitCaps();
  updateLabelMode();
}
addEventListener('resize', () => { resize(); renderFrame(); });
new ResizeObserver(() => { resize(); renderFrame(); }).observe(canvas);
resize();

/* ================= debug hooks ================= */
window.__flower = {
  P, lights, camera, scene, bloom, grade, petals, petalShaders, renderer, pollenMat,
  renderOnce: renderFrame,
  reflow() {
    baseOffset.copy(REST).sub(PIVOT).multiplyScalar(P.zoom);
    bloom.threshold = P.bloomThreshold; bloom.strength = P.bloomStrength; bloom.radius = P.bloomRadius;
    grade.uniforms.uContrast.value = P.contrast; grade.uniforms.uShoulder.value = P.shoulder;
    grade.uniforms.uGrain.value = P.grain; grade.uniforms.uVig.value = P.vignette;
    for (const n in petalShaders) {
      const u = petalShaders[n].uniforms;
      u.uSSSScale.value = P.sssScale; u.uSSSDistortion.value = P.sssDistortion;
    }
    renderFrame();
  },
  setAim(x, y) { aim.tx = x; aim.ty = y; ndc.set(x, -y); renderFrame(); },
  setOrbit(yawDeg, pitchDeg = 0) { dragYaw = THREE.MathUtils.clamp(yawDeg * Math.PI / 180, -P.maxYawOrbit, P.maxYawOrbit); dragPitch = THREE.MathUtils.clamp(pitchDeg * Math.PI / 180, -P.maxPitchOrbit, P.maxPitchOrbit); yaw = dragYaw; pitch = dragPitch; renderFrame(); },
  hover(name) { const p = petals.find(q => q.name === name); if (p) setHover(p); renderFrame(); },
  wakeNow() { wakeT = 1; renderFrame(); },
};
