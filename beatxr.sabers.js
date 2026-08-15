// Sabers for both input modes: real XR controllers, or a mouse-driven fallback
// so the chart can be played (and debugged) on a plain desktop browser.

import * as THREE from 'three';

const BLADE_LENGTH = 1.0;
const HISTORY = 4; // frames of tip positions used to derive swing direction
// A real swing tops out around 20 m/s at the tip. Anything past this in a single
// frame is a tracking glitch or a controller teleporting in, not a swing - using
// it as a direction would hand out phantom bad cuts.
const MAX_STEP_PER_SECOND = 45;

function buildSaber(color) {
  const group = new THREE.Group();

  const hilt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.026, 0.2, 12),
    new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.5, metalness: 0.6 })
  );
  hilt.rotation.x = -Math.PI / 2;
  hilt.position.z = -0.06;
  group.add(hilt);

  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.012, BLADE_LENGTH, 10),
    new THREE.MeshBasicMaterial({ color })
  );
  blade.rotation.x = -Math.PI / 2;
  blade.position.z = -(0.16 + BLADE_LENGTH / 2);
  group.add(blade);

  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.035, BLADE_LENGTH, 10, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.z = blade.position.z;
  group.add(glow);

  group.add(new THREE.PointLight(color, 1.2, 2.5));
  return group;
}

export class Saber {
  constructor(hand, color) {
    this.hand = hand;
    this.color = color;
    this.object = buildSaber(color);
    this.tip = new THREE.Vector3();
    this.base = new THREE.Vector3();
    this.history = [];
    this.velocity = new THREE.Vector3();
    this.speed = 0;
    this.active = false;
    this._localTip = new THREE.Vector3(0, 0, -(0.16 + BLADE_LENGTH));
    this._localBase = new THREE.Vector3(0, 0, -0.16);
  }

  sample(dt) {
    this.object.updateMatrixWorld();
    this.tip.copy(this._localTip).applyMatrix4(this.object.matrixWorld);
    this.base.copy(this._localBase).applyMatrix4(this.object.matrixWorld);

    const previous = this.history[this.history.length - 1];
    if (previous && dt > 0 && previous.distanceTo(this.tip) > MAX_STEP_PER_SECOND * dt) {
      // Discontinuity: drop the stale history so the next real frames rebuild it.
      this.history.length = 0;
      this.velocity.set(0, 0, 0);
      this.speed = 0;
    }

    this.history.push(this.tip.clone());
    if (this.history.length > HISTORY) this.history.shift();

    if (this.history.length >= 2 && dt > 0) {
      const first = this.history[0];
      const last = this.history[this.history.length - 1];
      const span = dt * (this.history.length - 1);
      this.velocity.subVectors(last, first).divideScalar(span);
      this.speed = this.velocity.length();
    }
  }
}

export class SaberRig {
  /** colors: [leftColor, rightColor] */
  constructor(renderer, scene, camera, colors) {
    this.renderer = renderer;
    this.camera = camera;
    this.sabers = [new Saber(0, colors[0]), new Saber(1, colors[1])];
    this.mode = 'desktop';
    this.pointer = new THREE.Vector2(0, 0);
    this.mirror = true;

    // XR controller anchors. Controller 0/1 order is not guaranteed to be
    // left/right, so we re-map when the input source reports handedness.
    this.grips = [0, 1].map((i) => {
      const grip = renderer.xr.getControllerGrip(i);
      scene.add(grip);
      return grip;
    });

    this.desktopRoot = new THREE.Group();
    scene.add(this.desktopRoot);
    for (const s of this.sabers) this.desktopRoot.add(s.object);

    renderer.xr.addEventListener('sessionstart', () => this._enterXR());
    renderer.xr.addEventListener('sessionend', () => this._exitXR());

    this._onPointer = (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', this._onPointer);
  }

  _enterXR() {
    this.mode = 'xr';
    const session = this.renderer.xr.getSession();
    const assign = () => {
      const sources = Array.from(session.inputSources);
      for (let i = 0; i < this.grips.length; i++) {
        const src = sources[i];
        const handIndex = src?.handedness === 'left' ? 0 : src?.handedness === 'right' ? 1 : i;
        const saber = this.sabers[handIndex];
        if (saber && saber.object.parent !== this.grips[i]) this.grips[i].add(saber.object);
        this.gamepads = sources.map((s) => s.gamepad);
      }
    };
    session.addEventListener('inputsourceschange', assign);
    assign();
  }

  _exitXR() {
    this.mode = 'desktop';
    for (const s of this.sabers) this.desktopRoot.add(s.object);
  }

  pulse(hand, intensity = 0.6, ms = 55) {
    if (this.mode !== 'xr') return;
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      const wanted = hand === 0 ? 'left' : 'right';
      if (src.handedness !== wanted) continue;
      const actuator = src.gamepad?.hapticActuators?.[0];
      actuator?.pulse?.(intensity, ms);
    }
  }

  update(dt) {
    if (this.mode === 'desktop') this._updateDesktop();
    for (const s of this.sabers) s.sample(dt);
  }

  _updateDesktop() {
    const x = this.pointer.x * 1.25;
    const y = 1.3 + this.pointer.y * 0.75;

    // Point the saber from a shoulder position through the cursor target, so
    // moving the mouse produces a real swing arc rather than a slide.
    const place = (obj, tipX, shoulderX) => {
      const shoulder = new THREE.Vector3(shoulderX, 1.15, 0.55);
      const target = new THREE.Vector3(tipX, y, -0.15);
      obj.position.copy(shoulder);
      const dir = target.clone().sub(shoulder).normalize();
      // Object3D.lookAt aims +Z at the target, but the blade is built along -Z,
      // so aim at the mirrored point to get the blade pointing down-range.
      obj.lookAt(shoulder.clone().sub(dir));
    };

    if (this.mirror) {
      // The cursor drives whichever saber owns the side it's on, and the other
      // mirrors it. That keeps red on the left and blue on the right, so lane
      // colours always line up. The hand-off at x = 0 is continuous because
      // both sabers meet at the centre there.
      const primary = x < 0 ? 0 : 1;
      place(this.sabers[primary].object, x, primary === 0 ? -0.22 : 0.22);
      place(this.sabers[1 - primary].object, -x, primary === 0 ? 0.22 : -0.22);
    } else {
      // Single-saber mode: the cursor is the blue saber, red rests out of the way.
      place(this.sabers[1].object, x, 0.22);
      place(this.sabers[0].object, -1.15, -0.22);
    }
  }

  dispose() {
    window.removeEventListener('pointermove', this._onPointer);
  }
}
