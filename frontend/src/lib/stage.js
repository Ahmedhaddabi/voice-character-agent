import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

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
    if (this.staticModel) { this.scene.remove(this.staticModel); this.staticModel = null; }
    if (this.placeholder) { this.scene.remove(this.placeholder.root); this.placeholder = null; }
  }

  // Handles both a rigged VRM and a plain GLB. Returns which one it found, so
  // the UI can say honestly what will and will not move.
  async loadModel(url) {
    const loader = new GLTFLoader();
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
      return 'vrm';
    }

    // No skeleton and no blendshapes: she can stand and breathe, nothing more.
    this.clearRig();
    this.staticModel = gltf.scene;
    this.scene.add(gltf.scene);
    return 'static';
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
    m.position.y = Math.sin(t * 1.5) * 0.006 + (c.speaking ? Math.sin(t * 7) * 0.004 : 0);
    m.rotation.y = Math.sin(t * 0.4) * 0.07 + (c.speaking ? Math.sin(t * 2.3) * 0.03 : 0);
    const lean = c.speaking ? 0.012 : 0;
    m.rotation.x += ((Math.sin(t * 1.1) * 0.008 + lean) - m.rotation.x) * 0.05;
  }

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    this.controller.tick(dt);
    const pose = this.currentPose(t);

    if (this.vrm) this.applyToVRM(pose, dt);
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
