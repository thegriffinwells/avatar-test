import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ── Scene setup ──────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);

const isMobile = innerWidth < 768;
const hasTouch = 'ontouchstart' in window;
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, isMobile ? 1.6 : 1.2, isMobile ? 5.5 : 4);
camera.lookAt(0, isMobile ? 1.5 : 1.0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// ── Lighting (bright, even, Wii Sports vibe) ────────────────
scene.add(new THREE.AmbientLight(0xaaccff, 1.2));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(3, 6, 4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 20;
keyLight.shadow.camera.left = -3;
keyLight.shadow.camera.right = 3;
keyLight.shadow.camera.top = 3;
keyLight.shadow.camera.bottom = -1;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x88bbff, 1.2);
fillLight.position.set(-3, 4, 2);
scene.add(fillLight);

const backLight = new THREE.DirectionalLight(0xaaddff, 0.8);
backLight.position.set(0, 3, -4);
scene.add(backLight);

// Hemisphere for even sky/ground tones
const hemiLight = new THREE.HemisphereLight(0x88ccff, 0x446688, 0.8);
scene.add(hemiLight);

// ── Ground ───────────────────────────────────────────────────
const groundGeo = new THREE.PlaneGeometry(20, 20);
const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const floorMat = new THREE.MeshStandardMaterial({ color: 0x5b9bd5, roughness: 0.6, metalness: 0.05 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.001;
scene.add(floor);

// ── State ────────────────────────────────────────────────────
let model, mixer, idleAction, hangAction, fallAction, fallIdleAction, clapAction, pointAction, phoneAction, prayAction;
let headBone, neckBone;
let introPlaying = true; // block interaction during intro
let isClapping = false;
const mouse = new THREE.Vector2();
const mouseWorld = new THREE.Vector3();
const prevMouseWorld = new THREE.Vector3();
const raycaster = new THREE.Raycaster();

let isGrabbed = false;
let wasGrabbed = false; // track transition frame
const grabOffset = new THREE.Vector3();
const modelVelocity = new THREE.Vector3();

let gravityVel = 0;
const GROUND_Y = 0;
let groundedY = 0; // computed after model loads
let swingVel = 0; // pendulum angular velocity while grabbed
let legSwingAngle = 0;
let hipsBone, spineBone;
const _hipsAnimQuat = new THREE.Quaternion();
const _spineAnimQuat = new THREE.Quaternion();

// Compute visible world-space half-width at z=0 for screen edge clamping
function getMaxDriftX() {
  const vFov = camera.fov * Math.PI / 180;
  const dist = camera.position.z;
  const visibleHeight = 2 * Math.tan(vFov / 2) * dist;
  return (visibleHeight * camera.aspect) / 2 - 0.4;
}
let maxDriftX = getMaxDriftX();

// ── Gyroscope & hints ───────────────────────────────────────
let gyroGamma = 0, gyroBeta = 0;
let smoothGamma = 0;
let gyroEnabled = false;
let gyroPermissionRequested = false;
let hasGrabbed = false;
let hasTilted = false;
const hintEl = document.getElementById('hint');

// ── Tunable drop parameters ──────────────────────────────────
const dropConfig = {
  gravity: 6,
  dropHeight: 3,
  landTriggerTime: 0,
  crossfadeDuration: 0.26,
  landAnimSpeed: 1.6,
};

// ── Loader setup ─────────────────────────────────────────────
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

// Try compressed first, fall back to original
function loadGLB(compressedPath, fallbackPath) {
  return new Promise((resolve) => {
    loader.load(compressedPath, resolve, undefined, () => {
      loader.load(fallbackPath, resolve);
    });
  });
}

// ── Load all models ──────────────────────────────────────────
Promise.all([
  loadGLB('model-opt.glb', 'model.glb'),
  loadGLB('hanging-opt.glb', 'Hanging Idle.glb'),
  loadGLB('falling-opt.glb', 'Falling To Landing.glb'),
  loadGLB('clapping-opt.glb', 'Clapping.glb'),
  loadGLB('fallingidle-opt.glb', 'Falling Idle.glb'),
  loadGLB('pointing-opt.glb', 'Pointing.glb'),
  loadGLB('phone-opt.glb', 'Talking On A Cell Phone.glb'),
  loadGLB('praying-opt.glb', 'Praying.glb'),
]).then(([mainGltf, hangGltf, fallGltf, clapGltf, fallIdleGltf, pointGltf, phoneGltf, prayGltf]) => {
  model = mainGltf.scene;

  // Scale to ~1.8m tall
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 1.8 / size.y;
  model.scale.setScalar(scale);

  // Recompute bounds after scale
  box.setFromObject(model);
  box.getCenter(center);
  groundedY = -box.min.y;

  // Start above the floor
  model.position.set(-center.x, groundedY + dropConfig.dropHeight, -center.z);

  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      if (child.material) {
        child.material.roughness = 1;
        child.material.metalness = 0;
        if (child.material.envMapIntensity !== undefined) {
          child.material.envMapIntensity = 0;
        }
      }
    }
    if (child.isSkinnedMesh) child.frustumCulled = false;
  });

  scene.add(model);

  // Setup animation mixer with all clips
  mixer = new THREE.AnimationMixer(model);

  // Idle animation
  if (mainGltf.animations.length > 0) {
    idleAction = mixer.clipAction(mainGltf.animations[0]);
  }

  // Hanging animation
  if (hangGltf.animations.length > 0) {
    hangAction = mixer.clipAction(hangGltf.animations[0]);
    hangAction.loop = THREE.LoopRepeat;
  }

  // Falling-to-landing animation (plays once)
  if (fallGltf.animations.length > 0) {
    fallAction = mixer.clipAction(fallGltf.animations[0]);
    fallAction.setLoop(THREE.LoopOnce);
    fallAction.clampWhenFinished = true;
  }

  // Clapping animation
  if (clapGltf.animations.length > 0) {
    clapAction = mixer.clipAction(clapGltf.animations[0]);
    clapAction.setLoop(THREE.LoopOnce);
    clapAction.clampWhenFinished = true;
  }

  // Falling idle animation (looping pose while in the air)
  if (fallIdleGltf.animations.length > 0) {
    fallIdleAction = mixer.clipAction(fallIdleGltf.animations[0]);
    fallIdleAction.loop = THREE.LoopRepeat;
  }

  // Pointing animation (about button)
  if (pointGltf.animations.length > 0) {
    pointAction = mixer.clipAction(pointGltf.animations[0]);
    pointAction.setLoop(THREE.LoopOnce);
    pointAction.clampWhenFinished = true;
  }

  // Phone animation (contact button)
  if (phoneGltf.animations.length > 0) {
    phoneAction = mixer.clipAction(phoneGltf.animations[0]);
    phoneAction.setLoop(THREE.LoopOnce);
    phoneAction.clampWhenFinished = true;
  }

  // Praying animation (design button)
  if (prayGltf.animations.length > 0) {
    prayAction = mixer.clipAction(prayGltf.animations[0]);
    prayAction.setLoop(THREE.LoopOnce);
    prayAction.clampWhenFinished = true;
  }

  // Handle animation finished events
  mixer.addEventListener('finished', (e) => {
    if (e.action === fallAction) {
      dropState = 'grounded';
      fallAction.fadeOut(0.3);
      idleAction && idleAction.reset().fadeIn(0.3).play();
    }
    if (e.action === clapAction || e.action === pointAction || e.action === phoneAction || e.action === prayAction) {
      isClapping = false;
      e.action.fadeOut(0.3);
      idleAction && idleAction.reset().fadeIn(0.3).play();
    }
  });

  // Start intro drop
  introPlaying = true;
  startDrop();

  // Find key bones for look-at
  model.traverse((child) => {
    if (!child.isBone) return;
    const name = child.name.toLowerCase();
    if (name.includes('head') && !name.includes('headtop') && !headBone) headBone = child;
    if (name.includes('neck') && !neckBone) neckBone = child;
    if (name.endsWith('hips') && !hipsBone) hipsBone = child;
    if (name.endsWith('spine') && !spineBone) spineBone = child;
  });

  document.getElementById('loading').classList.add('hidden');
});

// ── Gyroscope ───────────────────────────────────────────────
function onDeviceOrientation(e) {
  if (e.gamma !== null) {
    gyroGamma = e.gamma;
    gyroBeta = e.beta;
    gyroEnabled = true;
    // Hide the permission button once we're getting real data
    const btn = document.getElementById('gyro-btn');
    if (btn) btn.style.display = 'none';
  }
}

// Always listen — on iOS without permission, events fire with null gamma
window.addEventListener('deviceorientation', onDeviceOrientation);

// iOS needs permission via a real HTML button click (touchstart on canvas doesn't count)
const _gyroBtn = document.getElementById('gyro-btn');
const _needsGyroPermission = typeof DeviceOrientationEvent !== 'undefined' &&
  typeof DeviceOrientationEvent.requestPermission === 'function';

if (_needsGyroPermission && _gyroBtn) {
  // Show the button after first grab (handled in updateHint)
  _gyroBtn.addEventListener('click', () => {
    DeviceOrientationEvent.requestPermission()
      .then(state => {
        _gyroBtn.style.display = 'none';
        if (state === 'granted') gyroEnabled = true;
      })
      .catch(() => {
        _gyroBtn.textContent = 'Permission denied — check Safari settings';
      });
  });
}

// ── Hit detection via screen-space distance ──────────────────
function isNearModel(ndc) {
  if (!model) return false;
  // Project model center (roughly chest height) to screen
  const modelCenter = new THREE.Vector3(model.position.x, model.position.y + 0.9, model.position.z);
  modelCenter.project(camera);
  const dx = ndc.x - modelCenter.x;
  const dy = ndc.y - modelCenter.y;
  // Threshold in NDC space — ~0.25 is generous enough to grab easily
  return (dx * dx + dy * dy) < 0.15;
}

// ── Pointer tracking (mouse + touch) ─────────────────────────
function updatePointerWorld(clientX, clientY) {
  mouse.x = (clientX / innerWidth) * 2 - 1;
  mouse.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  raycaster.ray.intersectPlane(plane, mouseWorld);
}

function onPointerMove(clientX, clientY) {
  prevMouseWorld.copy(mouseWorld);
  updatePointerWorld(clientX, clientY);

  // Cursor style on hover (mouse only)
  if (!isGrabbed && model) {
    document.body.style.cursor = isNearModel(mouse) ? 'grab' : 'default';
  }
}

function onPointerDown(clientX, clientY) {
  if (!model || introPlaying) return;
  updatePointerWorld(clientX, clientY);

  if (isNearModel(mouse)) {
    isGrabbed = true;
    document.body.style.cursor = 'grabbing';
    if (!hasGrabbed) {
      hasGrabbed = true;
    }
    // Offset so hands (raised above head) align with cursor
    grabOffset.set(0, 2.2, 0);
    gravityVel = 0;
    modelVelocity.set(0, 0, 0);

    // Stop all other actions, then play hanging
    if (idleAction) idleAction.stop();
    if (clapAction) { clapAction.stop(); isClapping = false; }
    if (pointAction) pointAction.stop();
    if (phoneAction) phoneAction.stop();
    if (prayAction) prayAction.stop();
    if (fallAction) fallAction.stop();
    if (fallIdleAction) fallIdleAction.stop();
    swingVel = 0;
    legSwingAngle = 0;
    if (hangAction) {
      hangAction.timeScale = 1.5;
      hangAction.reset().fadeIn(0.15).play();
    }
  }
}

function onPointerUp() {
  if (!isGrabbed) return;
  isGrabbed = false;
  wasGrabbed = true;
  document.body.style.cursor = 'default';

  // Throw velocity
  modelVelocity.copy(mouseWorld).sub(prevMouseWorld).multiplyScalar(2);
  gravityVel = modelVelocity.y;

  // Start drop sequence
  if (hangAction) hangAction.fadeOut(0.2);
  startDrop();
}

// Mouse events
window.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY));
window.addEventListener('mousedown', (e) => onPointerDown(e.clientX, e.clientY));
window.addEventListener('mouseup', onPointerUp);

// Touch events — don't prevent default on buttons
renderer.domElement.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  onPointerMove(t.clientX, t.clientY);
  onPointerDown(t.clientX, t.clientY);
}, { passive: false });

renderer.domElement.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  onPointerMove(t.clientX, t.clientY);
}, { passive: false });

renderer.domElement.addEventListener('touchend', (e) => {
  e.preventDefault();
  onPointerUp();
}, { passive: false });

// ── Head look-at (grounded idle only) ────────────────────────
const _headTargetQuat = new THREE.Quaternion();
const _headEuler = new THREE.Euler();
const _headAnimQuat = new THREE.Quaternion();
const _neckAnimQuat = new THREE.Quaternion();
let smoothYaw = 0;
let smoothPitch = 0;

function updateHeadTracking() {
  // Only track when standing idle — not during fall, land, grab, or button anims
  if (!headBone || isGrabbed || introPlaying || dropState !== 'grounded' || isClapping) return;

  const headWorldPos = new THREE.Vector3();
  headBone.getWorldPosition(headWorldPos);
  const dir = mouseWorld.clone().sub(headWorldPos).normalize();

  const targetYaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -0.4, 0.4);
  const targetPitch = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(dir.y, -0.3, 0.3)), -0.2, 0.2);

  smoothYaw += (targetYaw - smoothYaw) * 0.08;
  smoothPitch += (targetPitch - smoothPitch) * 0.08;

  _headEuler.set(smoothPitch, smoothYaw, 0, 'YXZ');
  _headTargetQuat.setFromEuler(_headEuler);

  // Apply on top of saved animation quaternion — prevents accumulation
  headBone.quaternion.copy(_headAnimQuat).multiply(_headTargetQuat);

  if (neckBone) {
    _headEuler.set(smoothPitch * 0.3, smoothYaw * 0.4, 0, 'YXZ');
    _headTargetQuat.setFromEuler(_headEuler);
    neckBone.quaternion.copy(_neckAnimQuat).multiply(_headTargetQuat);
  }
}

// ── Grabbed: follow cursor, pendulum legs ───────────────────
function updateGrabbed(dt) {
  if (!model || !isGrabbed) return;

  const prevX = model.position.x;
  const targetPos = mouseWorld.clone().sub(grabOffset);
  model.position.lerp(targetPos, 0.3);

  // Don't let model clip through floor while grabbed
  if (model.position.y < groundedY) model.position.y = groundedY;

  // Pendulum physics drives leg swing (not whole-body rotation)
  const moveAccel = (model.position.x - prevX) / Math.max(dt, 0.001);
  swingVel -= moveAccel * 0.06;                          // drag momentum
  if (gyroEnabled) swingVel += (smoothGamma / 90) * 2 * dt; // phone tilt
  swingVel -= 6 * Math.sin(legSwingAngle) * dt;          // gravity restores
  swingVel *= 0.94;                                       // damping
  legSwingAngle += swingVel * dt;
  legSwingAngle = THREE.MathUtils.clamp(legSwingAngle, -0.4, 0.4);

  // Keep model upright — swing is applied to bones, not the whole model
  model.rotation.z = THREE.MathUtils.lerp(model.rotation.z, 0, 0.15);
}

// Apply leg swing to hips bone, counter-rotate spine so only legs move
const _swingQuat = new THREE.Quaternion();
const _counterQuat = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

function applyLegSwing() {
  if (!isGrabbed || !hipsBone || !spineBone) return;

  _swingQuat.setFromAxisAngle(_zAxis, legSwingAngle);
  _counterQuat.setFromAxisAngle(_zAxis, -legSwingAngle);

  // Rotate hips (affects legs + spine), then undo rotation on spine (keeps upper body still)
  hipsBone.quaternion.copy(_hipsAnimQuat).premultiply(_swingQuat);
  spineBone.quaternion.copy(_spineAnimQuat).premultiply(_counterQuat);
}

// ── Drop system (rewritten from scratch) ─────────────────────
// States: 'falling' | 'landing' | 'grounded'
let dropState = 'falling';

function timeToGround() {
  // Given current height and velocity, estimate seconds until ground hit
  // Using kinematic equation: h = v*t + 0.5*g*t^2
  const h = model.position.y - groundedY;
  if (h <= 0) return 0;
  const v = -gravityVel; // flip sign (vel is negative when falling)
  const g = dropConfig.gravity;
  // Quadratic: 0.5*g*t^2 + v*t - h = 0
  const discriminant = v * v + 2 * g * h;
  if (discriminant < 0) return 99;
  return (-v + Math.sqrt(discriminant)) / g;
}

function startDrop() {
  dropState = 'falling';
  gravityVel = 0;
  if (fallIdleAction) fallIdleAction.reset().play();
}

function updateDropped(dt) {
  if (!model || isGrabbed) return;

  // Safety: if below ground, force to grounded
  if (model.position.y < groundedY) {
    model.position.y = groundedY;
    gravityVel = 0;
    modelVelocity.set(0, 0, 0);
    model.rotation.z = 0;
    dropState = 'grounded';
    // Hard-cut to idle — no fade prevents T-pose when all actions have zero weight
    mixer.stopAllAction();
    if (idleAction) idleAction.reset().play();
    introPlaying = false;
    wasGrabbed = false;
    return;
  }

  if (dropState === 'falling') {
    // Apply gravity
    gravityVel -= dropConfig.gravity * dt;
    const nextY = model.position.y + gravityVel * dt;
    model.position.y = Math.max(nextY, groundedY);

    // Horizontal movement
    if (!introPlaying) {
      model.position.x += modelVelocity.x * dt;
      modelVelocity.x *= 0.95;
      model.position.x = THREE.MathUtils.clamp(model.position.x, -maxDriftX, maxDriftX);
    }

    // Check if we should trigger landing animation
    const ttg = timeToGround();
    if (ttg <= dropConfig.landTriggerTime && gravityVel <= 0) {
      // Transition to landing state
      dropState = 'landing';
      model.position.y = groundedY; // snap to ground
      gravityVel = 0;
      modelVelocity.set(0, 0, 0);
      model.rotation.z = 0;

      // Crossfade animations
      if (fallIdleAction) fallIdleAction.fadeOut(dropConfig.crossfadeDuration);
      if (fallAction) {
        fallAction.timeScale = dropConfig.landAnimSpeed;
        fallAction.reset().fadeIn(dropConfig.crossfadeDuration).play();
      }

      introPlaying = false;
      wasGrabbed = false;
    }
  }

  if (dropState === 'landing') {
    // Lock to ground every frame — animation root motion cannot move us
    model.position.y = groundedY;
    model.rotation.z = THREE.MathUtils.lerp(model.rotation.z, 0, 0.08);
  }

  if (dropState === 'grounded') {
    model.position.y = groundedY;
    if (gyroEnabled) {
      const tiltFraction = smoothGamma / 90;
      // Lean proportional to tilt
      model.rotation.z = THREE.MathUtils.lerp(model.rotation.z, -tiltFraction * 0.8, 0.12);
      // Slide like gravity — velocity, not position snap
      model.position.x += tiltFraction * 4 * dt;
      model.position.x = THREE.MathUtils.clamp(model.position.x, -maxDriftX, maxDriftX);
    } else {
      model.rotation.z = THREE.MathUtils.lerp(model.rotation.z, 0, 0.08);
    }
  }
}

// ── Confetti ─────────────────────────────────────────────────
const confettiPieces = [];
const CONFETTI_PALETTES = {
  'btn-photo':   [0xcc0022, 0x991133, 0xdd1144, 0xaa0033, 0x880022],   // deep reds
  'btn-design':  [0x0044aa, 0x002288, 0x1155bb, 0x003399, 0x0033aa],   // dark blues
  'btn-about':   [0x007744, 0x005533, 0x008855, 0x006644, 0x009966],   // dark greens
  'btn-contact': [0xcc8800, 0xaa6600, 0xdd9900, 0xbb7700, 0xff9900],   // dark golds
};
const confettiGeo = new THREE.PlaneGeometry(0.06, 0.04);

function spawnConfetti(palette) {
  const colors = palette || [0xcc0022, 0x0044aa, 0x007744, 0xcc8800, 0x6622aa];
  for (let i = 0; i < 200; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const piece = new THREE.Mesh(confettiGeo, mat);

    // Spawn above and spread wide, behind the model
    const s = 0.5 + Math.random() * 1.5;
    piece.scale.set(s, s, s);
    piece.position.set(
      (Math.random() - 0.5) * 6,
      3 + Math.random() * 3,
      -0.3 - Math.random() * 3
    );
    piece.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

    scene.add(piece);
    confettiPieces.push({
      mesh: piece,
      velY: -1.5 - Math.random() * 1.5,
      velX: (Math.random() - 0.5) * 0.8,
      rotSpeed: (Math.random() - 0.5) * 8,
      life: 1
    });
  }
}

function updateConfetti(dt) {
  for (let i = confettiPieces.length - 1; i >= 0; i--) {
    const c = confettiPieces[i];
    c.mesh.position.y += c.velY * dt;
    c.mesh.position.x += c.velX * dt;
    c.mesh.rotation.x += c.rotSpeed * dt;
    c.mesh.rotation.z += c.rotSpeed * 0.7 * dt;
    c.velX *= 0.998;
    c.life -= dt * 0.4;

    c.mesh.material.opacity = Math.max(0, c.life);
    c.mesh.material.transparent = true;

    if (c.life <= 0 || c.mesh.position.y < -1) {
      scene.remove(c.mesh);
      c.mesh.material.dispose();
      confettiPieces.splice(i, 1);
    }
  }
}

// ── Button animations ────────────────────────────────────────
const BUTTON_ANIMS = {
  'btn-photo':   () => clapAction,
  'btn-design':  () => prayAction,
  'btn-about':   () => pointAction,
  'btn-contact': () => phoneAction,
};

function triggerButtonAnim(btnId, palette) {
  if (!model || introPlaying || isGrabbed) return;
  const getAction = BUTTON_ANIMS[btnId];
  const action = getAction && getAction();
  if (!action) return;
  isClapping = true;
  // Hard stop everything so the new animation plays instantly
  mixer.stopAllAction();
  action.timeScale = 1.5;
  action.reset().play();
  spawnConfetti(palette);
}

document.querySelectorAll('.corner-btn').forEach((btn) => {
  const palette = CONFETTI_PALETTES[btn.id];
  btn.addEventListener('click', () => triggerButtonAnim(btn.id, palette));
  btn.addEventListener('touchstart', () => btn.classList.add('tapped'), { passive: true });
  btn.addEventListener('touchend', () => {
    triggerButtonAnim(btn.id, palette);
    setTimeout(() => btn.classList.remove('tapped'), 150);
  }, { passive: true });
});

// ── Cursor trail ─────────────────────────────────────────────
const trailCanvas = document.getElementById('trail');
const trailCtx = trailCanvas.getContext('2d');
const trailPoints = [];
const MAX_TRAIL = 25;
let pointerX = 0, pointerY = 0;

function resizeTrail() {
  trailCanvas.width = innerWidth * devicePixelRatio;
  trailCanvas.height = innerHeight * devicePixelRatio;
  trailCanvas.style.width = innerWidth + 'px';
  trailCanvas.style.height = innerHeight + 'px';
  trailCtx.scale(devicePixelRatio, devicePixelRatio);
}
resizeTrail();

function trackPointer(e) {
  if (e.touches) {
    pointerX = e.touches[0].clientX;
    pointerY = e.touches[0].clientY;
  } else {
    pointerX = e.clientX;
    pointerY = e.clientY;
  }
}
window.addEventListener('mousemove', trackPointer);
window.addEventListener('touchmove', trackPointer, { passive: true });
window.addEventListener('touchstart', (e) => {
  if (e.target.closest('.corner-btn')) return;
  trackPointer(e);
}, { passive: true });

function drawTrail() {
  trailPoints.push({ x: pointerX, y: pointerY, life: 1 });
  if (trailPoints.length > MAX_TRAIL) trailPoints.shift();

  trailCtx.clearRect(0, 0, innerWidth, innerHeight);

  for (let i = 0; i < trailPoints.length; i++) {
    const p = trailPoints[i];
    p.life -= 0.04;
    if (p.life <= 0) continue;

    const alpha = p.life * 0.5;
    const radius = p.life * 4;
    const next = trailPoints[i + 1];

    // Draw glow dot
    trailCtx.beginPath();
    trailCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    trailCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    trailCtx.fill();

    // Draw connecting line to next point
    if (next && next.life > 0) {
      trailCtx.beginPath();
      trailCtx.moveTo(p.x, p.y);
      trailCtx.lineTo(next.x, next.y);
      trailCtx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.5})`;
      trailCtx.lineWidth = radius * 0.8;
      trailCtx.lineCap = 'round';
      trailCtx.stroke();
    }
  }

  // Remove dead points
  while (trailPoints.length > 0 && trailPoints[0].life <= 0) {
    trailPoints.shift();
  }
}

// ── Resize ───────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  maxDriftX = getMaxDriftX();
  resizeTrail();
});

// ── Gyro smoothing ──────────────────────────────────────────
function updateGyro(dt) {
  if (!gyroEnabled) return;
  smoothGamma = THREE.MathUtils.lerp(smoothGamma, gyroGamma, 0.1);
  if (!hasTilted && Math.abs(gyroGamma) > 12) {
    hasTilted = true;
  }
}

// ── Hint text above head ────────────────────────────────────
function updateHint() {
  if (!model || !hintEl) return;

  const showGrab = !introPlaying && !hasGrabbed && dropState === 'grounded';
  const showTilt = hasTouch && hasGrabbed && !hasTilted && !gyroEnabled && dropState === 'grounded' && !isGrabbed && !isClapping;

  // Show the gyro permission button above head when it's time for "Tilt Me" on iOS
  if (_needsGyroPermission && _gyroBtn) {
    if (showTilt && !gyroEnabled) {
      const btnPos = new THREE.Vector3(model.position.x, model.position.y + 2.15, model.position.z);
      btnPos.project(camera);
      _gyroBtn.style.display = 'block';
      _gyroBtn.style.left = ((btnPos.x * 0.5 + 0.5) * innerWidth) + 'px';
      _gyroBtn.style.top = ((-btnPos.y * 0.5 + 0.5) * innerHeight) + 'px';
    } else {
      _gyroBtn.style.display = 'none';
    }
  }

  if (showGrab || (showTilt && !_needsGyroPermission)) {
    const pos = new THREE.Vector3(model.position.x, model.position.y + 2.05, model.position.z);
    pos.project(camera);
    hintEl.style.left = ((pos.x * 0.5 + 0.5) * innerWidth) + 'px';
    hintEl.style.top = ((-pos.y * 0.5 + 0.5) * innerHeight) + 'px';

    if (showGrab) {
      hintEl.textContent = 'Grab Me';
      hintEl.className = 'hint pulse-slow';
    } else {
      hintEl.textContent = 'Tilt Me';
      hintEl.className = 'hint pulse-fast';
    }
  } else {
    hintEl.className = 'hint';
  }
}

// ── Animation loop ───────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (mixer) mixer.update(dt);

  // Save post-animation bone rotations before we modify them
  if (headBone) _headAnimQuat.copy(headBone.quaternion);
  if (neckBone) _neckAnimQuat.copy(neckBone.quaternion);
  if (hipsBone) _hipsAnimQuat.copy(hipsBone.quaternion);
  if (spineBone) _spineAnimQuat.copy(spineBone.quaternion);

  updateGyro(dt);
  updateHint();
  updateHeadTracking();
  updateGrabbed(dt);
  applyLegSwing();
  updateDropped(dt);
  updateConfetti(dt);

  renderer.render(scene, camera);
  drawTrail();
}

animate();
