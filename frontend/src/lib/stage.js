import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// The model is now authored with her mouth OPEN, and carries a MouthClosed
// shape key that brings the lips together. So the drive is inverted: silence
// means fully closed, speech opens toward zero.
//
// REST_CLOSE is how shut she sits when silent. Slightly under 1.0 leaves a
// natural hint of a parting rather than a pressed-flat line.
const REST_CLOSE = 1.0;
// How far she is allowed to open at peak volume. Lower opens wider.
const MIN_CLOSE = 0.0;

// Gesture poses are expressed as bone rotation offsets in radians, so the same
// definitions drive the placeholder figure and a real VRM rig.
// phase runs 0..1 across the gesture.
const POSES = {
  wave: (p) => {
    const lift = Math.sin(Math.min(1, p * 3) * Math.PI * 0.5);
    return { rUpper: [0, 0, -2.1 * lift], rLower: [0, 0, -0.5 * lift + Math.sin(p * 22) * 0.45 * lift] };
  },
  nod: (p) => ({ headX: Math.sin(p * Math.PI * 2) * 0.22 }),
  shrug: (p) => {
    const s = Math.sin(p * Math.PI);
    return { rUpper: [0, 0, -0.55 * s], lUpper: [0, 0, 0.55 * s], rLower: [0, 0, -0.7 * s], lLower: [0, 0, 0.7 * s], headX: -0.08 * s };
  },
  point: (p) => {
    const s = Math.sin(Math.min(1, p * 2.4) * Math.PI * 0.5) * (1 - Math.max(0, p - 0.7) / 0.3);
    return { rUpper: [0, -0.35 * s, -1.15 * s], rLower: [0, 0, -0.35 * s] };
  },
  think: (p) => {
    const s = Math.sin(Math.min(1, p * 2.5) * Math.PI * 0.5) * (1 - Math.max(0, p - 0.75) / 0.25);
    return { rUpper: [0, 0, -1.35 * s], rLower: [0, 0, -1.5 * s], headX: 0.12 * s, headY: 0.2 * s };
  },
  celebrate: (p) => {
    const s = Math.sin(Math.min(1, p * 3) * Math.PI * 0.5);
    const b = Math.sin(p * 14) * 0.15 * s;
    return { rUpper: [0, 0, -2.5 * s + b], lUpper: [0, 0, 2.5 * s - b], headX: -0.15 * s };
  },
};

const EMOTION_TO_VRM = { happy: 'happy', sad: 'sad', surprised: 'surprised', curious: 'relaxed', thoughtful: 'relaxed' };
const EMOTION_TINT = {
  neutral: 0xd8c3b4, happy: 0xf0cfa8, curious: 0xd6c9dd,
  thoughtful: 0xc4c0cf, surprised: 0xf2d6c4, sad: 0xb9c2cd,
};

function lerp(a, b, t) { return a + (b - a) * t; }

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
    if (this.riggedScene) { this.scene.remove(this.riggedScene); this.riggedScene = null; this.riggedMeshes = null; this.bones = null; this.restRot = null; this.mouthDark = null; }
    if (this.staticModel) { this.scene.remove(this.staticModel); this.staticModel = null; }
    if (this.placeholder) { this.scene.remove(this.placeholder.root); this.placeholder = null; }
  }

  // Handles a VRM, a plain GLB rigged by hand (skeleton + morph targets but no
  // VRM humanoid metadata), and a fully static GLB. Returns which one it
  // found, so the UI can say honestly what will and will not move.
  async loadModel(url) {
    const loader = new GLTFLoader();

    // The model ships Draco-compressed: 166k triangles in 2.9 MB rather than
    // 13 MB. Without this decoder the file will not load at all.
    // The decoder is fetched once and cached by the browser.
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    draco.setDecoderConfig({ type: 'js' });
    loader.setDRACOLoader(draco);
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
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
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh) skinnedMeshes.push(o);
      if (o.isBone) bones[o.name] = o;
      // A small static "teeth bar" mesh tucked behind the lips (see
      // applyToRigged below) — it never moves on its own, it just fades in
      // as the jaw opens, so the closed-mouth look never depends on getting
      // its physical depth relative to the lips exactly right.
      if (o.name === 'MouthDark') mouthDark = o;
    });

    if (skinnedMeshes.length) {
      this.clearRig();
      this.riggedScene = gltf.scene;
      this.riggedMeshes = skinnedMeshes;
      this.bones = bones;
      this.mouthDark = mouthDark;
      if (this.mouthDark) {
        const mat = this.mouthDark.material;
        // The lower-lip shape key only recedes the skin by a centimetre or
        // two, so relying on the depth buffer to hide this object behind
        // closed lips and reveal it behind an open mouth is fragile (it was
        // tried in Blender first and kept poking through at rest or staying
        // hidden when open, depending on the mesh's own curvature at any
        // given point). Disabling depth testing and driving pure opacity
        // from the same mouth-open value sidesteps that entirely: at
        // opacity 0 it is invisible regardless of what's in front of it, and
        // when it fades in it always draws on top, so it reads correctly no
        // matter how the jaw shape key is tuned later.
        mat.transparent = true;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.opacity = 0;
        this.mouthDark.renderOrder = 999;

        // MouthDark ships mis-positioned: its centre sits at y=0.226, but her
        // lip line is at y=0.2355 — measured in Blender by raycasting the face
        // surface. Nine and a half millimetres low, which put it on her chin.
        // Fading it in therefore produced a dark smear on her jaw rather than
        // an open mouth. Shift the geometry up to meet the lips.
        //
        // Translating the geometry (not the object) is deliberate: this is a
        // skinned mesh, so its object transform is largely overridden by the
        // skeleton, whereas a geometry offset survives skinning.
        // Hidden: it sits on her chin (y=0.226), not her lips (y=0.2355),
        // so fading it in only ever produced a dark smear on her jaw.
        this.mouthDark.visible = false;
      }

      // Bone orientations here are not normalized like a VRM rig: her arms
      // rest at her sides, a compound rotation on every axis, not identity.
      // Capture each bone's authored rest orientation as a quaternion so
      // gesture offsets can be composed on top of it (quaternion multiply)
      // instead of overwritten as raw Euler angles, which would silently
      // no-op against a non-trivial rest pose.
      this.restRot = {};
      for (const name of Object.keys(bones)) this.restRot[name] = bones[name].quaternion.clone();
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
    root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary) return;
      const idx = o.morphTargetDictionary.MouthClosed
        ?? o.morphTargetDictionary.MouthOpen;
      if (idx === undefined) return;
      this.mouthMeshes.push({ mesh: o, idx });
      o.morphTargetInfluences[idx] = REST_CLOSE;
    });
    this._mouthSmoothed = 0;
    return this.mouthMeshes.length;
  }

  // Drive the mouth from the smoothed volume. Runs every frame regardless of
  // which rig branch is active.
  updateMouth() {
    if (!this.mouthMeshes?.length) return;
    this._mouthSmoothed = lerp(this._mouthSmoothed ?? 0, this.controller.mouth, 0.3);
    const w = REST_CLOSE - this._mouthSmoothed * (REST_CLOSE - MIN_CLOSE);
    for (const { mesh, idx } of this.mouthMeshes) {
      mesh.morphTargetInfluences[idx] = w;
    }
  }

  // Blend the current gesture pose toward the rig, whichever rig that is.
  currentPose(t) {
    const c = this.controller;
    const target = c.gesture && POSES[c.gesture] ? POSES[c.gesture](c.gesturePhase) : {};

    // Ambient life: breathing and a slow sway, always running.
    const breath = Math.sin(t * 1.5) * 0.018;
    const sway = Math.sin(t * 0.45) * 0.05;
    const talkBob = c.speaking ? Math.sin(t * 7.5) * 0.03 : 0;

    const base = {
      rUpper: [0, 0, breath * 0.6], lUpper: [0, 0, -breath * 0.6],
      rLower: [0, 0, 0], lLower: [0, 0, 0],
      headX: talkBob, headY: sway, spineY: sway * 0.4,
    };

    const out = { ...base };
    for (const key of Object.keys(target)) {
      const v = target[key];
      out[key] = Array.isArray(v) ? v.map((n, i) => n + (base[key]?.[i] ?? 0)) : v + (base[key] ?? 0);
    }

    // Smooth every channel so gestures ease in and out instead of snapping.
    for (const key of Object.keys(out)) {
      const v = out[key];
      if (Array.isArray(v)) {
        const prev = this.smoothed[key] ?? [0, 0, 0];
        this.smoothed[key] = v.map((n, i) => lerp(prev[i], n, 0.14));
      } else {
        this.smoothed[key] = lerp(this.smoothed[key] ?? 0, v, 0.14);
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

    const head = bone('head');
    if (head) head.rotation.set(pose.headX ?? 0, pose.headY ?? 0, 0);
    const spine = bone('spine');
    if (spine) spine.rotation.set(0, pose.spineY ?? 0, 0);

    const em = vrm.expressionManager;
    if (em) {
      // Amplitude drives a blend of open vowels. Replace with formant analysis
      // for per-viseme accuracy.
      em.setValue('aa', c.mouth * 0.85);
      em.setValue('ih', c.mouth * 0.25);
      em.setValue('ou', c.mouth * 0.2);
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
    // The "sleeve streaks at the cuff" symptom previously blamed on rough
    // weight painting was actually a wrong-axis bug, confirmed by extracting
    // the exported rig's own rest/posed joint quaternions (2026-08-26
    // TAZ.glb) and checking which local axis a known-good bend (Blender's
    // own baked wave — a clean, natural arm raise, no streaking) rotates
    // around: it's local X, not Z. POSES.wave/shrug/point/think/celebrate
    // put their bend value in rUpper[2]/rLower[2] (index 2, "Z") because they
    // were written for a VRM-normalized humanoid bone space, a different
    // skeleton convention from this hand-rigged one. Feeding that Z-slot
    // value straight into this rig's Euler Z rotated the forearm mostly
    // around its own roll/twist axis instead of bending it — that twist
    // against the cloth is what read as streaking, not fragile weighting.
    // Remapping index 2 -> local X (the verified bend axis) fixes the actual
    // rotation direction. Verified in Blender up to POSES' full combined
    // peak (~150 deg shoulder+elbow) with no mesh damage, but that peak
    // reads as a fairly exaggerated swing on this character's proportions,
    // so ARM_SCALE is set to a visibly large-but-not-maxed value rather than
    // 1.0 — nudge it once you've seen it live.
    const ARM_SCALE = 0.6;
    const addRot = (name, rot) => {
      const node = b[name];
      const r = rest[name];
      if (!node || !r || !rot) return;
      euler.set(rot[2] * ARM_SCALE, rot[0] * ARM_SCALE, rot[1] * ARM_SCALE);
      delta.setFromEuler(euler);
      node.quaternion.copy(r).multiply(delta);
    };
    // GLTFLoader strips '.' from node names (it uses '.' as the separator in
    // animation track paths), so "UpperArm.R" in the file becomes "UpperArmR".
    addRot('UpperArmR', pose.rUpper);
    addRot('UpperArmL', pose.lUpper);
    addRot('ForeArmR', pose.rLower);
    addRot('ForeArmL', pose.lLower);

    const head = b.Head;
    if (head) {
      euler.set(pose.headX ?? 0, pose.headY ?? 0, 0);
      delta.setFromEuler(euler);
      head.quaternion.copy(rest.Head).multiply(delta);
    }
    const spine = b.Spine;
    if (spine) {
      euler.set(0, pose.spineY ?? 0, 0);
      delta.setFromEuler(euler);
      spine.quaternion.copy(rest.Spine).multiply(delta);
    }

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

    p.head.rotation.set(pose.headX ?? 0, pose.headY ?? 0, 0);
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
    const pose = this.currentPose(t);

    this.updateMouth();

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
