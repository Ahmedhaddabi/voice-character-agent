import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

if (import.meta.env.DEV) window.__THREE = THREE;

// The model is authored with her mouth CLOSED. Newer exports carry the three
// Blender mouth bones below; older models may still expose a MouthOpen morph.
// Both paths consume the same controller.mouth value, so realtime audio stays
// independent from locomotion and other baked animation clips.
//
// MAX_OPEN is how far she parts at peak volume.
const MAX_OPEN = 1.0;
const MOUTH_OPEN_BOOST = 1.22;
// Below this the mouth is treated as fully shut, so she rests closed instead
// of hovering a fraction open forever.
const SILENCE_DEADZONE = 0.025;
// Response curve on the amplitude. 1.0 is linear; higher keeps her closer to
// shut through ordinary speech and reserves a wide opening for loud syllables.
// Lower it if she starts to look tight-lipped.
const MOUTH_CURVE = 0.72;

// Exact open-pose deltas from the Blender drivers. These are local-X offsets
// composed on top of the exported closed/rest quaternions.
const MOUTH_BONE_X = {
  Mouth_Jaw: THREE.MathUtils.degToRad(4),
  Mouth_LowerLip: THREE.MathUtils.degToRad(2),
  Mouth_UpperLip: THREE.MathUtils.degToRad(-1),
};

function smooth01(value) {
  const x = Math.max(0, Math.min(1, value));
  // Quintic smootherstep: velocity and acceleration both reach zero at the
  // ends, similar to Blender's auto-clamped handles.
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// Critically damped motion with persistent velocity. Unlike a plain lerp it
// does not throw velocity away every frame, so bones accelerate into a pose
// and decelerate out of it without overshoot or a visible stop-start kink.
function smoothDamp(current, target, velocity, smoothTime, dt) {
  const safeTime = Math.max(0.0001, smoothTime);
  const step = Math.min(0.05, Math.max(0.0001, dt));
  const omega = 2 / safeTime;
  const x = omega * step;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * step;
  let value = target + (change + temp) * decay;
  let nextVelocity = (velocity - omega * temp) * decay;
  // A rapidly changing speech target can otherwise carry a tiny amount of
  // momentum beyond its destination. Clamp that overshoot so hands never pass
  // through a safe pose on the way to the next one.
  if ((target - current > 0) === (value > target)) {
    value = target;
    nextVelocity = 0;
  }
  return { value, velocity: nextVelocity };
}

function gestureEnvelope(p, attack = 0.18, release = 0.22) {
  if (p < attack) return smooth01(p / attack);
  if (p > 1 - release) return smooth01((1 - p) / release);
  return 1;
}

// Semantic gestures stay compact and rotate on more than one axis. This keeps
// the elbows and palms readable without the wide, mechanical arm swings the
// earlier single-axis poses produced.
const POSES = {
  wave: (p) => {
    const lift = gestureEnvelope(p, 0.20, 0.24);
    const wag = Math.sin(p * Math.PI * 6) * lift;
    return {
      rUpper: [-0.10 * lift, -0.34 * lift, -0.70 * lift],
      rLower: [0.08 * lift, 0.08 * lift, -1.55 * lift],
      // Local-Y wrist twist turns the palm toward the viewer; the smaller
      // local-Z oscillation makes the greeting wave without flipping it away.
      rHand: [1.65 * lift, 0.34 * wag, 0.10 * wag],
      rShoulder: [-0.015 * lift, -0.025 * lift, -0.035 * lift],
      chestY: -0.045 * lift,
      chestZ: -0.018 * lift,
      headY: 0.055 * lift,
      headZ: 0.018 * lift,
    };
  },
  nod: (p) => {
    const s = gestureEnvelope(p, 0.16, 0.24);
    const primary = Math.sin(p * Math.PI * 2) * 0.145 * s;
    const settle = Math.sin(p * Math.PI * 4) * 0.025 * s;
    return {
      headX: primary + settle,
      neckX: (primary + settle) * 0.28,
      chestX: Math.sin(p * Math.PI) * 0.022 * s,
    };
  },
  point: (p) => {
    const s = gestureEnvelope(p, 0.16, 0.26);
    // A presenter-style open-hand indication, held beside the body so the
    // hand is never hidden inside the dress or across the chest.
    return {
      rUpper: [-0.05 * s, -0.35 * s, -0.38 * s],
      rLower: [0.04 * s, 0.05 * s, -1.52 * s],
      rHand: [1.48 * s, 0.12 * s, -0.04 * s],
      rShoulder: [-0.012 * s, -0.02 * s, -0.028 * s],
      chestY: -0.065 * s,
      hipsY: 0.022 * s,
      headY: 0.05 * s,
      headZ: 0.012 * s,
    };
  },
  celebrate: (p) => {
    const s = gestureEnvelope(p, 0.16, 0.26);
    const b = Math.sin(p * Math.PI * 4) * 0.06 * s;
    return {
      rUpper: [-0.06 * s, -0.28 * s, -1.34 * s + b], lUpper: [0.06 * s, 0.28 * s, -1.34 * s + b],
      rLower: [0, 0.06 * s, -0.42 * s], lLower: [0, -0.06 * s, -0.42 * s],
      rHand: [1.20 * s, 0, 0], lHand: [-1.20 * s, 0, 0],
      rShoulder: [-0.025 * s, 0, -0.045 * s], lShoulder: [0.025 * s, 0, 0.045 * s],
      headX: -0.07 * s, chestX: -0.045 * s, hipsX: 0.018 * s,
    };
  },
};

// Automatic presenter motion is driven by speech onsets. A phrase holds one
// of three balanced poses; each stressed syllable briefly extends alternating
// hands. It is deterministic, restrained, and directly tied to the voice.
function speechPose(controller) {
  if (!controller.speaking) return {};
  const energy = controller.speechEnergy ?? 0;
  const beat = (controller.speechPulse ?? 0) * (0.55 + energy * 0.45);
  const side = controller.speechSide ?? 1;
  const mode = controller.speechMode ?? 0;
  const phrase = controller.speechAge ?? 0;
  const cadence = Math.sin(phrase * 2.35) * energy;
  const secondary = Math.sin(phrase * 1.17 + 0.8) * energy;

  const performance = {
    neckX: beat * 0.012 + cadence * 0.006,
    neckY: side * beat * 0.008,
    headZ: -side * beat * 0.009 + secondary * 0.004,
    chestX: -energy * 0.012 + beat * 0.009,
    chestY: side * beat * 0.012 + cadence * 0.008,
    chestZ: -side * cadence * 0.005,
    hipsY: -side * beat * 0.005,
  };

  if (mode === 0) {
    return {
      // Keep the active hand on the audience-facing side of the sleeve.
      // Negative forearm-Z is outward on this rig; positive values bury the
      // hand behind the torso. Each speech beat extends it a little farther.
      rUpper: [-0.04, -0.30, -(0.20 + beat * 0.10)],
      rLower: [0.03, 0.04, -(0.92 + beat * 0.24)],
      rHand: [1.36, 0.08 + beat * 0.10, 0.02],
      rShoulder: [-0.01 - beat * 0.008, -0.018, -0.022],
      lUpper: [0.02, 0.04, -0.06],
      headX: beat * 0.035, headY: side * beat * 0.018, spineY: -0.025,
      ...performance,
    };
  }
  if (mode === 1) {
    return {
      lUpper: [0.04, 0.30, -(0.20 + beat * 0.10)],
      lLower: [-0.03, -0.04, -(0.92 + beat * 0.24)],
      lHand: [-1.36, -(0.08 + beat * 0.10), 0.02],
      lShoulder: [0.01 + beat * 0.008, 0.018, 0.022],
      rUpper: [-0.02, -0.04, -0.06],
      headX: beat * 0.035, headY: side * beat * 0.018, spineY: 0.025,
      ...performance,
    };
  }
  return {
    rUpper: [-0.03, -0.25, -(0.16 + beat * 0.08)], lUpper: [0.03, 0.25, -(0.16 + beat * 0.08)],
    rLower: [0.02, 0.03, -(0.72 + beat * 0.18)], lLower: [-0.02, -0.03, -(0.72 + beat * 0.18)],
    rHand: [1.30, 0.08 + beat * 0.08, 0], lHand: [-1.30, -(0.08 + beat * 0.08), 0],
    rShoulder: [-0.008 - beat * 0.006, -0.012, -0.018], lShoulder: [0.008 + beat * 0.006, 0.012, 0.018],
    headX: beat * 0.035, headY: side * beat * 0.014,
    ...performance,
  };
}

const EMOTION_TO_VRM = { happy: 'happy', sad: 'sad', surprised: 'surprised', curious: 'relaxed', thoughtful: 'relaxed' };
const EMOTION_TINT = {
  neutral: 0xd8c3b4, happy: 0xf0cfa8, curious: 0xd6c9dd,
  thoughtful: 0xc4c0cf, surprised: 0xf2d6c4, sad: 0xb9c2cd,
};

function lerp(a, b, t) { return a + (b - a) * t; }

// A uniform dark shape — no matter how soft its edges — reads as a flat
// smudge glued onto her, because a real open mouth is not one uniform
// colour. Her base texture already has teeth painted at the crease (visible
// even before any of this was added); a solid plane sitting in front of it
// with depth-testing off just paints over that detail. The fix is to give
// the shadow internal structure instead of trying harder to hide its edges:
// bias the gradient's centre toward the BOTTOM of the shape, so the top
// (where the painted teeth are) stays close to fully transparent and shows
// through on its own, and only the lower cavity — which has no useful detail
// to preserve — actually goes dark. Built once and reused.
let _mouthGradientTexture = null;
function makeMouthGradientTexture() {
  if (_mouthGradientTexture) return _mouthGradientTexture;

  // Draw on a square canvas first — a radial gradient is only ever
  // circular, so getting a wide ellipse means squashing the finished image
  // afterward (drawImage into a wider-than-tall canvas), not fighting
  // canvas transform math to make the gradient itself elliptical. The
  // vertical bias (center pushed down) survives that squash unchanged,
  // since it is a uniform scale.
  const sq = 128;
  const square = document.createElement('canvas');
  square.width = sq; square.height = sq;
  const sctx = square.getContext('2d');
  // Bias down (cy > sq/2) so the top stays lighter than the bottom — but the
  // radius must be large enough that the bias doesn't push the far edge
  // outside the gradient entirely, which is what silently shrank this to a
  // thin line last time: a center at 0.68*sq with radius 0.58*sq put the
  // canvas top (distance 0.68*sq from center) *past* the gradient's own
  // edge, i.e. already at zero alpha before the "fade" even started. Keep
  // the bias modest and the radius comfortably larger than any point on the
  // canvas can be from the center.
  const cx = sq / 2, cy = sq * 0.55;
  const radius = sq * 0.5;
  const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0.0, 'rgba(20,5,5,0.95)');
  grad.addColorStop(0.3, 'rgba(20,5,5,0.85)');
  grad.addColorStop(0.6, 'rgba(20,5,5,0.55)');
  grad.addColorStop(0.85, 'rgba(20,5,5,0.15)');
  grad.addColorStop(1.0, 'rgba(20,5,5,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, sq, sq);

  const w = 128, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(square, 0, 0, sq, sq, 0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _mouthGradientTexture = tex;
  return tex;
}

const TARGET_HEIGHT = 1.65;

// Every character we load was exported by a different tool with its own
// notion of scale and pivot (the original generator, a from-scratch Blender
// rig, a future one). Rather than trust each export, measure the loaded
// scene's actual bounding box and normalize it: feet at y=0, centered on
// x/z, scaled to a consistent height. Without this, anything that was not
// authored at exactly "1.6m tall, feet at origin" renders off-screen.
function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (!isFinite(box.min.y)) return; // empty geometry, nothing to frame

  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
  object.scale.setScalar(scale);
  object.position.x -= center.x * scale;
  object.position.z -= center.z * scale;
  object.position.y -= box.min.y * scale;
}

export class Stage {
  constructor(canvas, controller) {
    this.controller = controller;
    this.vrm = null;
    this.placeholder = null;
    this.clock = new THREE.Clock();
    this.smoothed = {};
    this.poseVelocity = {};

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 40);
    this.camera.position.set(0, 1.28, 2.4);
    this.camera.lookAt(0, 1.18, 0);

    const key = new THREE.DirectionalLight(0xfff2e2, 2.1);
    key.position.set(1.4, 2.4, 2.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb9c9, 1.1);
    rim.position.set(-2, 1.4, -1.6);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0xb9a6ad, 1.0));

    this.buildPlaceholder();
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // A stand-in so the whole pipeline is visible before any asset exists.
  buildPlaceholder() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd8c3b4, roughness: 0.75 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x9e2a44, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2028, roughness: 0.6 });

    const root = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 6, 18), cloth);
    torso.position.y = 0.98;
    root.add(torso);

    const head = new THREE.Group();
    head.position.y = 1.42;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.17, 28, 24), skin);
    head.add(skull);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.185, 24, 20, 0, Math.PI * 2, 0, Math.PI * 0.6), dark);
    hair.position.y = 0.012;
    head.add(hair);

    const eyeGeo = new THREE.SphereGeometry(0.022, 14, 12);
    const eyeL = new THREE.Mesh(eyeGeo, dark);
    eyeL.position.set(-0.058, 0.026, 0.152);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.058;
    head.add(eyeL, eyeR);

    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.042, 18, 14), new THREE.MeshStandardMaterial({ color: 0x5c2230, roughness: 0.5 }));
    mouth.position.set(0, -0.062, 0.146);
    mouth.scale.set(1, 0.14, 0.5);
    head.add(mouth);
    root.add(head);

    const arm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.2 * side, 1.2, 0);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.2, 4, 12), cloth);
      upper.position.y = -0.14;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.26;
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.19, 4, 12), skin);
      fore.position.y = -0.13;
      elbow.add(fore);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 12), skin);
      hand.position.y = -0.26;
      hand.scale.set(1, 1.15, 0.6);
      elbow.add(hand);
      shoulder.add(elbow);
      root.add(shoulder);
      return { shoulder, elbow };
    };

    const legGeo = new THREE.CapsuleGeometry(0.07, 0.44, 4, 12);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, cloth);
      leg.position.set(0.1 * side, 0.42, 0);
      root.add(leg);
    }

    this.placeholder = { root, head, mouth, eyeL, eyeR, torso, skin, armR: arm(1), armL: arm(-1) };
    this.scene.add(root);
  }

  clearRig() {
    if (this.vrm) { this.scene.remove(this.vrm.scene); this.vrm = null; }
    if (this.riggedScene) { this.scene.remove(this.riggedScene); this.riggedScene = null; this.riggedMeshes = null; this.bones = null; this.restRot = null; this.hasMouthBones = false; this.useLegacyMouthBoneFallback = false; this.mouthDark = null; this.mouthTeeth = null; this.mouthTongue = null; this.mouthSeam = null; this.mouthMixer = null; this.mouthAction = null; this.mouthClipDuration = 0; this.mouthClipStart = 0; this.visemeMeshes = []; }
    if (this.staticModel) { this.scene.remove(this.staticModel); this.staticModel = null; }
    if (this.placeholder) { this.scene.remove(this.placeholder.root); this.placeholder = null; }
  }

  // Handles a VRM, a plain GLB rigged by hand (skeleton + morph targets but no
  // VRM humanoid metadata), and a fully static GLB. Returns which one it
  // found, so the UI can say honestly what will and will not move.
  async loadModel(url) {
    const loader = new GLTFLoader();

    loader.register((parser) => new VRMLoaderPlugin(parser));
    let gltf;
    try {
      gltf = await loader.loadAsync(url);
    } catch (err) {
      // Silent model failures cost hours to diagnose. Say what broke.
      const hint = /draco/i.test(String(err?.message ?? err))
        ? 'The Draco decoder failed to load — check that /draco/ is being served.'
        : 'Check that the model file exists and is a valid .glb.';
      console.error(`[stage] Could not load "${url}". ${hint}`, err);
      throw err;
    }
    const vrm = gltf.userData.vrm;

    if (vrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      vrm.scene.rotation.y = Math.PI; // VRM rigs face -Z by convention
      this.clearRig();
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      frameModel(vrm.scene);
      return 'vrm';
    }

    // A single mesh can be split into multiple primitives (e.g. one per
    // material) — that means multiple SkinnedMesh objects sharing one
    // skeleton, each potentially carrying its own copy of a morph target.
    // Collect all of them so nothing gets silently left un-animated.
    const skinnedMeshes = [];
    const bones = {};
    let mouthDark = null;
    let mouthTeeth = null;
    let mouthTongue = null;
    let mouthSeam = null;
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh) skinnedMeshes.push(o);
      if (o.isBone) bones[o.name] = o;
      // A small static "teeth bar" mesh tucked behind the lips (see
      // applyToRigged below) — it never moves on its own, it just fades in
      // as the jaw opens, so the closed-mouth look never depends on getting
      // its physical depth relative to the lips exactly right.
      if (o.name === 'MouthDark' || o.name === 'Mouth_Inner_FINAL' || o.name === 'Mouth_Inner_V2') mouthDark = o;
      if (o.name === 'Mouth_UpperTeeth_V2') mouthTeeth = o;
      if (o.name === 'Mouth_Tongue_V3') mouthTongue = o;
      if (o.name === 'Mouth_Seam_V2') mouthSeam = o;
    });

    if (skinnedMeshes.length) {
      this.clearRig();
      this.riggedScene = gltf.scene;
      this.riggedMeshes = skinnedMeshes;
      this.bones = bones;
      this.mouthDark = mouthDark;
      this.mouthTeeth = mouthTeeth;
      this.mouthTongue = mouthTongue;
      this.mouthSeam = mouthSeam;
      if (this.mouthDark) {
        // An authored MouthDark node shipped in this export — use it, same
        // opacity-driven reveal trick as the procedural fallback below.
        const mat = this.mouthDark.material;
        mat.transparent = true;
        mat.depthTest = this.mouthDark.name === 'Mouth_Inner_V2';
        mat.depthWrite = false;
        mat.opacity = 0;
        this.mouthDark.renderOrder = 999;
        this.mouthDark.visible = true;
      } else if (bones.Head) {
        // No authored mouth-cavity mesh has ever survived an export of this
        // character (checked every backup .glb — none contain a MouthDark
        // node). Rather than depend on cutting a real hole into her face in
        // Blender — which needs a working interior/back geometry to not show
        // through to nothing, and has repeatedly been the hard, fragile part
        // — build a small dark plane procedurally and park it just inside
        // the mouth, parented to the Head bone. It does not need to deform:
        // it only has to fade in as the jaw opens, so its own shape can be
        // static while the lip shape key does the moving around it.
        //
        // MOUTH_LOCAL is in Head-bone local space. Measured directly from
        // the live mesh, not guessed: found the vertices with the largest
        // MouthOpen morph displacement (the lip edge) and averaged their
        // true skinned world position (mesh.getVertexPosition, which
        // accounts for the skeleton — a naive geometry-attribute lookup
        // ignores skinning and is off by metres), then transformed into
        // Head-bone local space the same way this plane is parented.
        const MOUTH_LOCAL = { x: 0.0165, y: 0.1038, z: 0.0882, width: 0.04, height: 0.02 };
        const geo = new THREE.PlaneGeometry(MOUTH_LOCAL.width, MOUTH_LOCAL.height, 1, 1);
        const mat = new THREE.MeshBasicMaterial({
          map: makeMouthGradientTexture(),
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const dark = new THREE.Mesh(geo, mat);
        dark.position.set(MOUTH_LOCAL.x, MOUTH_LOCAL.y, MOUTH_LOCAL.z);
        dark.renderOrder = 999;
        dark.name = 'MouthDarkProcedural';
        bones.Head.add(dark);
        this.mouthDark = dark;
      }
      for (const [part, initialOpacity, order, depthTest] of [
        [this.mouthTongue, 0, 1000, true],
        [this.mouthTeeth, 0, 1001, true],
        [this.mouthSeam, 1, 1002, false],
      ]) {
        if (!part) continue;
        const materials = Array.isArray(part.material) ? part.material : [part.material];
        for (const mat of materials) {
          mat.transparent = true;
          mat.depthTest = depthTest;
          mat.depthWrite = false;
          mat.opacity = initialOpacity;
        }
        part.renderOrder = order;
        part.visible = true;
      }

      // Bone orientations here are not normalized like a VRM rig: her arms
      // rest at her sides, a compound rotation on every axis, not identity.
      // Capture each bone's authored rest orientation as a quaternion so
      // gesture offsets can be composed on top of it (quaternion multiply)
      // instead of overwritten as raw Euler angles, which would silently
      // no-op against a non-trivial rest pose.
      this.restRot = {};
      for (const name of Object.keys(bones)) this.restRot[name] = bones[name].quaternion.clone();
      this.hasMouthBones = Object.keys(MOUTH_BONE_X).every((name) => bones[name]);
      // Blender and glTF use different local bone bases. Applying an Euler-X
      // delta directly in Three.js made the upper lip orbit toward the nose.
      // The export now contains one mouth-only clip authored by Blender, so
      // scrub that clip with speech amplitude and let Blender's converted
      // quaternions drive the three mouth bones exactly.
      const mouthClip = gltf.animations.find((clip) =>
        clip.tracks.some((track) => /Mouth_(Jaw|LowerLip|UpperLip)/.test(track.name))
      );
      if (mouthClip) {
        this.mouthMixer = new THREE.AnimationMixer(gltf.scene);
        this.mouthAction = this.mouthMixer.clipAction(mouthClip);
        this.mouthAction.setLoop(THREE.LoopOnce, 1);
        this.mouthAction.clampWhenFinished = true;
        this.mouthAction.play();
        this.mouthAction.paused = false;
        this.mouthClipDuration = mouthClip.duration;
        this.mouthClipStart = Math.min(...mouthClip.tracks.map((track) => track.times[0] ?? 0));
        this.mouthMixer.setTime(this.mouthClipStart);
      }
      this.useLegacyMouthBoneFallback = this.hasMouthBones && !mouthClip && !gltf.scene.getObjectByName('Mouth_UpperLip_V2');
      this.scene.add(gltf.scene);
      frameModel(gltf.scene);
      this.collectMouthMeshes(gltf.scene);
      return 'rigged';
    }

    // No skeleton. She can still talk: the mouth shape key lives on a plain
    // mesh, not a skinned one, so it is collected separately below.
    this.clearRig();
    this.staticModel = gltf.scene;
    this.scene.add(gltf.scene);
    frameModel(gltf.scene);
    this.staticBaseY = gltf.scene.position.y;
    this.collectMouthMeshes(gltf.scene);
    return 'static';
  }

  // Find every mesh carrying a mouth shape key, skinned or not, and set it to
  // the resting (closed) position straight away so she never appears mid-word
  // before the first audio arrives.
  collectMouthMeshes(root) {
    this.mouthMeshes = [];
    this.visemeMeshes = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary) return;
      const ee = o.morphTargetDictionary.viseme_EE;
      const oo = o.morphTargetDictionary.viseme_OO;
      if (ee !== undefined || oo !== undefined) {
        this.visemeMeshes.push({ mesh: o, ee, oo });
        if (ee !== undefined) o.morphTargetInfluences[ee] = 0;
        if (oo !== undefined) o.morphTargetInfluences[oo] = 0;
      }
      const idx = o.morphTargetDictionary.MouthOpen
        ?? o.morphTargetDictionary.MouthClosed;
      if (idx === undefined) return;
      this.mouthMeshes.push({ mesh: o, idx });
      o.morphTargetInfluences[idx] = 0;
    });
    this._mouthSmoothed = 0;
    return this.mouthMeshes.length;
  }

  // Drive the mouth from the smoothed volume. Runs every frame regardless of
  // which rig branch is active.
  updateMouth(dt) {
    if (!this.mouthMeshes?.length && !this.hasMouthBones && !this.mouthAction) return;

    // Amplitude spends most of speech in the middle of its range, so feeding
    // it through linearly leaves her sitting half-open the whole time. The
    // exponent pushes quiet and mid-level moments back toward closed while
    // still letting loud syllables open fully — the gaps between words start
    // reading as gaps.
    // Jaw opening and lip shape are separate motions. Audio volume drives the
    // three mouth bones almost equally for every vowel; only a closed-lip BMP
    // consonant suppresses the opening. This keeps the lips from puckering as
    // one solid circle while the jaw appears frozen.
    const openness = {
      BMP: 0.04,
      EE: 0.95,
      OO: 1,
      AA: 1,
      neutral: 0,
    }[this.controller.viseme] ?? 0.92;
    const target = Math.pow(Math.max(0, this.controller.mouth * openness), MOUTH_CURVE);
    const prev = this._mouthSmoothed ?? 0;

    // The mouth stays deliberately faster than the body so consonants remain
    // synchronized, but uses frame-rate independent easing rather than a fixed
    // per-frame percentage. Closing is a little faster than opening.
    const speed = target > prev ? 21 : 32;
    const rate = 1 - Math.exp(-Math.max(0.001, dt) * speed);
    let v = lerp(prev, target, rate);

    // When she is not producing audio, drive hard to shut rather than waiting
    // for the smoothing to drift there. This is the difference between lips
    // that settle closed between phrases and lips that hang slightly apart.
    if (!this.controller.speaking) v = Math.min(v, prev * Math.exp(-Math.max(0.001, dt) * 36));

    // Both this and pushAmplitude smooth exponentially, so the value only
    // ever approaches zero — it never arrives. The old form also required the
    // incoming level to be under the threshold, which the response curve keeps
    // it just above at idle, so the snap never fired and she sat a few percent
    // open. Judge the smoothed value alone.
    if (v < SILENCE_DEADZONE) v = 0;

    this._mouthSmoothed = v;
    const w = Math.min(1, v * MOUTH_OPEN_BOOST) * MAX_OPEN;
    for (const { mesh, idx } of this.mouthMeshes) {
      mesh.morphTargetInfluences[idx] = w;
    }
    // The exported EE/OO morphs deform the complete overlay into a second,
    // circular mouth. Keep them explicitly disabled: the three authored mouth
    // bones provide one clean open/close motion and the audio still controls
    // its timing and strength.
    const eeWeight = 0;
    const ooWeight = 0;
    for (const { mesh, ee, oo } of this.visemeMeshes ?? []) {
      if (ee !== undefined) mesh.morphTargetInfluences[ee] = eeWeight;
      if (oo !== undefined) mesh.morphTargetInfluences[oo] = ooWeight;
    }

    // The Blender export has no MouthOpen morph: speech is a small compound
    // rotation across jaw, lower lip, and upper lip. Apply only those local
    // offsets; never play the bundled running clip to make the mouth move.
    if (this.mouthAction) {
      const end = this.mouthClipDuration * 0.999999;
      this.mouthMixer.setTime(this.mouthClipStart + (end - this.mouthClipStart) * w);
    } else if (this.useLegacyMouthBoneFallback) {
      const euler = this._mouthEuler ?? (this._mouthEuler = new THREE.Euler());
      const delta = this._mouthQuat ?? (this._mouthQuat = new THREE.Quaternion());
      for (const [name, openX] of Object.entries(MOUTH_BONE_X)) {
        const node = this.bones[name];
        const rest = this.restRot[name];
        euler.set(openX * w, 0, 0, 'XYZ');
        delta.setFromEuler(euler);
        node.quaternion.copy(rest).multiply(delta);
      }
    }

    // The dark cavity plane (authored or procedural — see loadModel) has no
    // shape key of its own; it just fades in over the same range the lips
    // travel. Held back until the mouth is genuinely open past a sliver, so
    // it doesn't read as a dark smudge at rest or at tiny amplitudes.
    if (this.mouthDark) {
      const reveal = Math.max(0, (w - 0.04) / 0.96);
      const materials = Array.isArray(this.mouthDark.material) ? this.mouthDark.material : [this.mouthDark.material];
      for (const mat of materials) mat.opacity = reveal;
    }
    if (this.mouthTeeth) {
      const reveal = Math.max(0, (w - 0.10) / 0.90);
      const materials = Array.isArray(this.mouthTeeth.material) ? this.mouthTeeth.material : [this.mouthTeeth.material];
      for (const mat of materials) mat.opacity = reveal;
    }
    if (this.mouthTongue) {
      const reveal = Math.max(0, (w - 0.24) / 0.76) * 0.92;
      const materials = Array.isArray(this.mouthTongue.material) ? this.mouthTongue.material : [this.mouthTongue.material];
      for (const mat of materials) mat.opacity = reveal;
    }
    if (this.mouthSeam) {
      const reveal = Math.max(0, 1 - w * 5);
      const materials = Array.isArray(this.mouthSeam.material) ? this.mouthSeam.material : [this.mouthSeam.material];
      for (const mat of materials) mat.opacity = reveal;
    }
  }

  // Blend the current gesture pose toward the rig, whichever rig that is.
  currentPose(t, dt) {
    const c = this.controller;
    const semantic = c.gesture && POSES[c.gesture] ? POSES[c.gesture](c.gesturePhase) : {};
    const automatic = c.gesture ? { headX: (c.speechPulse ?? 0) * 0.025 } : speechPose(c);

    // Ambient life is distributed through the skeleton instead of rotating
    // only the head and arms. Multiple low-frequency cycles keep the motion
    // from repeating as an obvious loop while remaining calm enough for a
    // conversational character.
    const breath = Math.sin(t * 1.32) * 0.018;
    const sway = Math.sin(t * 0.43) * 0.042;
    const weight = Math.sin(t * 0.31 + 0.7);
    const micro = Math.sin(t * 0.71 + 1.8);

    const base = {
      rUpper: [0, 0, breath * 0.6], lUpper: [0, 0, -breath * 0.6],
      rLower: [0, 0, 0], lLower: [0, 0, 0],
      rHand: [0, 0, 0], lHand: [0, 0, 0],
      rShoulder: [-breath * 0.16, 0, -breath * 0.18],
      lShoulder: [breath * 0.16, 0, breath * 0.18],
      headX: micro * 0.008,
      headY: sway,
      headZ: weight * 0.009,
      neckX: -micro * 0.004,
      neckY: sway * 0.24,
      neckZ: -weight * 0.004,
      spineX: breath * 0.20,
      spineY: sway * 0.11,
      spineZ: weight * 0.004,
      chestX: breath * 0.52,
      chestY: sway * 0.16,
      chestZ: weight * 0.006,
      hipsX: -breath * 0.08,
      hipsY: -sway * 0.10,
      hipsZ: -weight * 0.008,
    };

    const out = { ...base };
    for (const layer of [automatic, semantic]) {
      for (const key of Object.keys(layer)) {
        const v = layer[key];
        const prior = out[key] ?? (Array.isArray(v) ? [0, 0, 0] : 0);
        out[key] = Array.isArray(v) ? v.map((n, i) => n + (prior[i] ?? 0)) : v + prior;
      }
    }

    // The Blender action is densely sampled and preserves continuous motion.
    // Do the runtime equivalent with a critically damped velocity per channel.
    // Semantic gestures are a little quicker; speech and idle motion stay soft.
    const armChannels = new Set(['rUpper', 'lUpper', 'rLower', 'lLower', 'rHand', 'lHand']);
    for (const key of Object.keys(out)) {
      const v = out[key];
      const smoothTime = armChannels.has(key)
        ? (c.gesture ? 0.11 : (c.speaking ? 0.17 : 0.28))
        : (c.gesture ? 0.16 : (c.speaking ? 0.21 : 0.32));
      if (Array.isArray(v)) {
        const prev = this.smoothed[key] ?? [0, 0, 0];
        const velocity = this.poseVelocity[key] ?? [0, 0, 0];
        const next = v.map((n, i) => smoothDamp(prev[i], n, velocity[i] ?? 0, smoothTime, dt));
        this.smoothed[key] = next.map((item) => item.value);
        this.poseVelocity[key] = next.map((item) => item.velocity);
      } else {
        const next = smoothDamp(this.smoothed[key] ?? 0, v, this.poseVelocity[key] ?? 0, smoothTime, dt);
        this.smoothed[key] = next.value;
        this.poseVelocity[key] = next.velocity;
      }
    }
    return this.smoothed;
  }

  applyToVRM(pose, dt) {
    const c = this.controller;
    const vrm = this.vrm;
    const bone = (name) => vrm.humanoid.getNormalizedBoneNode(name);

    const set = (name, rot) => {
      const node = bone(name);
      if (node && rot) node.rotation.set(rot[0], rot[1], rot[2]);
    };
    set('rightUpperArm', pose.rUpper);
    set('leftUpperArm', pose.lUpper);
    set('rightLowerArm', pose.rLower);
    set('leftLowerArm', pose.lLower);
    set('rightHand', pose.rHand);
    set('leftHand', pose.lHand);
    set('rightShoulder', pose.rShoulder);
    set('leftShoulder', pose.lShoulder);

    const head = bone('head');
    if (head) head.rotation.set(pose.headX ?? 0, pose.headY ?? 0, pose.headZ ?? 0);
    const neck = bone('neck');
    if (neck) neck.rotation.set(pose.neckX ?? 0, pose.neckY ?? 0, pose.neckZ ?? 0);
    const spine = bone('spine');
    if (spine) spine.rotation.set(pose.spineX ?? 0, pose.spineY ?? 0, pose.spineZ ?? 0);
    const chest = bone('chest');
    if (chest) chest.rotation.set(pose.chestX ?? 0, pose.chestY ?? 0, pose.chestZ ?? 0);
    const upperChest = bone('upperChest');
    if (upperChest) upperChest.rotation.set((pose.chestX ?? 0) * 0.45, (pose.chestY ?? 0) * 0.55, (pose.chestZ ?? 0) * 0.55);
    const hips = bone('hips');
    if (hips) hips.rotation.set(pose.hipsX ?? 0, pose.hipsY ?? 0, pose.hipsZ ?? 0);

    const em = vrm.expressionManager;
    if (em) {
      const shaped = Math.max(c.visemeEE ?? 0, c.visemeOO ?? 0);
      em.setValue('aa', c.mouth * (0.85 - shaped * 0.45));
      em.setValue('ih', c.mouth * (c.visemeEE ?? 0) * 0.8);
      em.setValue('ou', c.mouth * (c.visemeOO ?? 0) * 0.85);
      em.setValue('blink', c.blink);
      for (const name of new Set(Object.values(EMOTION_TO_VRM))) em.setValue(name, 0);
      const mapped = EMOTION_TO_VRM[c.emotion];
      if (mapped) em.setValue(mapped, 0.7);
    }
    vrm.update(dt);
  }

  // A hand-rigged GLB: real bones, but authored with whatever rest rotation
  // Blender happened to save (arms hanging at her sides, not a T-pose), so
  // every gesture offset gets added onto that rest rotation rather than
  // overwriting it outright.
  applyToRigged(pose) {
    const c = this.controller;
    const b = this.bones;
    const rest = this.restRot;
    const euler = this._scratchEuler ?? (this._scratchEuler = new THREE.Euler());
    const delta = this._scratchQuat ?? (this._scratchQuat = new THREE.Quaternion());

    // Compose the gesture offset onto the bone's own rest orientation via
    // quaternion multiply, not raw Euler addition — the rest pose here is a
    // compound rotation (arms angled down at her sides), and adding Euler
    // components on top of that does not correspond to "rotate an extra
    // amount", so it silently produced no visible movement.
    //
    // Blender MCP measurement of this exact export shows that both arm bones
    // use positive local X to move from their authored T-pose to a relaxed
    // down pose. Forearm negative local X then bends the hand back up toward
    // the listener. The pose arrays keep their portable VRM-style slots and
    // are remapped here for this hand-authored skeleton.
    const ARM_SCALE = 1.0;
    const addRot = (names, rot, localXBase = 0) => {
      const name = names.find((candidate) => b[candidate]);
      const node = name ? b[name] : null;
      const r = name ? rest[name] : null;
      if (!node || !r || !rot) return;
      euler.set((localXBase + rot[2]) * ARM_SCALE, rot[0] * ARM_SCALE, rot[1] * ARM_SCALE);
      delta.setFromEuler(euler);
      node.quaternion.copy(r).multiply(delta);
    };
    // V8 uses RightArm/LeftArm; older backups used UpperArmR/UpperArmL.
    // Supporting both avoids silently losing all movement when exports differ.
    const RELAXED_ARM_DROP = 1.12;
    addRot(['RightArm', 'UpperArmR'], pose.rUpper, RELAXED_ARM_DROP);
    addRot(['LeftArm', 'UpperArmL'], pose.lUpper, RELAXED_ARM_DROP);
    addRot(['RightForeArm', 'ForeArmR'], pose.rLower);
    addRot(['LeftForeArm', 'ForeArmL'], pose.lLower);
    addRot(['RightHand'], pose.rHand);
    addRot(['LeftHand'], pose.lHand);

    const addLocal = (names, rot) => {
      const name = names.find((candidate) => b[candidate]);
      const node = name ? b[name] : null;
      const r = name ? rest[name] : null;
      if (!node || !r || !rot) return;
      euler.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
      delta.setFromEuler(euler);
      node.quaternion.copy(r).multiply(delta);
    };
    addLocal(['RightShoulder'], pose.rShoulder);
    addLocal(['LeftShoulder'], pose.lShoulder);

    const head = b.Head;
    if (head) {
      euler.set(pose.headX ?? 0, pose.headY ?? 0, pose.headZ ?? 0);
      delta.setFromEuler(euler);
      head.quaternion.copy(rest.Head).multiply(delta);
    }
    addLocal(['neck', 'Neck'], [pose.neckX, pose.neckY, pose.neckZ]);
    addLocal(['Spine'], [pose.spineX, pose.spineY, pose.spineZ]);
    addLocal(['Spine01'], [(pose.chestX ?? 0) * 0.42, (pose.chestY ?? 0) * 0.45, (pose.chestZ ?? 0) * 0.45]);
    addLocal(['Spine02'], [(pose.chestX ?? 0) * 0.58, (pose.chestY ?? 0) * 0.55, (pose.chestZ ?? 0) * 0.55]);
    addLocal(['Hips'], [pose.hipsX, pose.hipsY, pose.hipsZ]);

    // Mouth is handled centrally in updateMouth(); see the frame loop.
  }

  applyToPlaceholder(pose) {
    const c = this.controller;
    const p = this.placeholder;
    const rot = (group, r) => r && group.rotation.set(r[0], r[1], r[2]);

    rot(p.armR.shoulder, pose.rUpper);
    rot(p.armL.shoulder, pose.lUpper);
    rot(p.armR.elbow, pose.rLower);
    rot(p.armL.elbow, pose.lLower);

    p.head.rotation.set(pose.headX ?? 0, pose.headY ?? 0, pose.headZ ?? 0);
    p.root.rotation.y = pose.spineY ?? 0;

    p.mouth.scale.set(1 + c.mouth * 0.25, 0.14 + c.mouth * 1.05, 0.5);
    const lid = 1 - c.blink;
    p.eyeL.scale.y = lid;
    p.eyeR.scale.y = lid;
    p.skin.color.setHex(EMOTION_TINT[c.emotion] ?? EMOTION_TINT.neutral);
  }

  // An unrigged mesh has no joints to pose, so all we can honestly do is move
  // the whole body. Breathing and a small turn toward the listener keep her
  // from looking frozen until a skeleton exists.
  applyToStatic(t) {
    const c = this.controller;
    const m = this.staticModel;
    m.position.y = this.staticBaseY + Math.sin(t * 1.5) * 0.006 + (c.speaking ? Math.sin(t * 7) * 0.004 : 0);
    m.rotation.y = Math.sin(t * 0.4) * 0.07 + (c.speaking ? Math.sin(t * 2.3) * 0.03 : 0);
    const lean = c.speaking ? 0.012 : 0;
    m.rotation.x += ((Math.sin(t * 1.1) * 0.008 + lean) - m.rotation.x) * 0.05;
  }

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    this.controller.tick(dt);
    const pose = this.currentPose(t, dt);

    this.updateMouth(dt);

    if (this.vrm) this.applyToVRM(pose, dt);
    else if (this.riggedMeshes) this.applyToRigged(pose);
    else if (this.staticModel) this.applyToStatic(t);
    else if (this.placeholder) this.applyToPlaceholder(pose);

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }
}
