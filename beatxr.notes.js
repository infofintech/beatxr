// Note blocks: pooled meshes, arrow decals, saber-segment intersection test
// and the debris burst that plays when one gets cut.

import * as THREE from 'three';
import { DIR, DIR_VECTORS } from './beatxr.generator.js';

export const NOTE_SIZE = 0.45;
export const LANE_WIDTH = 0.6;
export const LAYER_HEIGHT = 0.48;
export const BASE_HEIGHT = 0.78;
const HALF = NOTE_SIZE / 2;

export function laneX(lane) { return (lane - 1.5) * LANE_WIDTH; }
export function layerY(layer, heightOffset = 0) { return BASE_HEIGHT + layer * LAYER_HEIGHT + heightOffset; }

/** Rotation about Z that makes an up-pointing arrow face `dir`. */
export function dirRotation(dir) {
  if (dir === DIR.ANY) return 0;
  const [x, y] = DIR_VECTORS[dir];
  return Math.atan2(-x, y);
}

function decalTexture(kind) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  g.fillStyle = '#ffffff';
  if (kind === 'arrow') {
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.16);
    g.lineTo(s * 0.82, s * 0.56);
    g.lineTo(s * 0.63, s * 0.56);
    g.lineTo(s * 0.63, s * 0.86);
    g.lineTo(s * 0.37, s * 0.86);
    g.lineTo(s * 0.37, s * 0.56);
    g.lineTo(s * 0.18, s * 0.56);
    g.closePath();
    g.fill();
  } else {
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.22, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class NoteField {
  constructor(scene, colors, heightOffset = 0) {
    this.scene = scene;
    this.colors = colors;
    this.heightOffset = heightOffset;

    this.boxGeo = new THREE.BoxGeometry(NOTE_SIZE, NOTE_SIZE, NOTE_SIZE);
    this.halfGeo = new THREE.BoxGeometry(NOTE_SIZE, HALF, NOTE_SIZE);
    this.decalGeo = new THREE.PlaneGeometry(NOTE_SIZE * 0.62, NOTE_SIZE * 0.62);
    this.sparkGeo = new THREE.BoxGeometry(0.035, 0.035, 0.035);

    this.noteMats = colors.map((c) => new THREE.MeshStandardMaterial({
      color: c, roughness: 0.32, metalness: 0.15, emissive: c, emissiveIntensity: 0.28,
    }));
    this.decalMats = {
      arrow: new THREE.MeshBasicMaterial({ map: decalTexture('arrow'), transparent: true, depthWrite: false }),
      dot: new THREE.MeshBasicMaterial({ map: decalTexture('dot'), transparent: true, depthWrite: false }),
    };
    this.debrisMats = colors.map((c) => new THREE.MeshStandardMaterial({
      color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.2, transparent: true,
    }));
    this.sparkMats = colors.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true }));

    this.pool = [];
    this.debrisPool = [];
    this.sparkPool = [];
    this.activeDebris = [];
    this.activeSparks = [];
  }

  _acquire() {
    const mesh = this.pool.pop();
    if (mesh) { mesh.visible = true; return mesh; }

    const group = new THREE.Group();
    const box = new THREE.Mesh(this.boxGeo, this.noteMats[0]);
    group.add(box);
    const decal = new THREE.Mesh(this.decalGeo, this.decalMats.arrow);
    decal.position.z = HALF + 0.002;
    group.add(decal);
    group.userData.box = box;
    group.userData.decal = decal;
    this.scene.add(group);
    return group;
  }

  release(mesh) {
    mesh.visible = false;
    this.pool.push(mesh);
  }

  configure(mesh, note) {
    mesh.userData.box.material = this.noteMats[note.hand];
    mesh.userData.decal.material = note.dir === DIR.ANY ? this.decalMats.dot : this.decalMats.arrow;
    mesh.rotation.set(0, 0, dirRotation(note.dir));
    mesh.position.set(laneX(note.lane), layerY(note.layer, this.heightOffset), 0);
    mesh.scale.setScalar(1);
    return mesh;
  }

  spawn(note) {
    return this.configure(this._acquire(), note);
  }

  /**
   * Segment vs. oriented box test in the note's local frame.
   * Returns the local-space entry point, or null.
   */
  static intersectSegment(mesh, p0, p1) {
    const c = Math.cos(-mesh.rotation.z);
    const s = Math.sin(-mesh.rotation.z);
    const local = (p) => {
      const dx = p.x - mesh.position.x;
      const dy = p.y - mesh.position.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c, z: p.z - mesh.position.z };
    };
    const a = local(p0);
    const b = local(p1);

    let tMin = 0;
    let tMax = 1;
    for (const axis of ['x', 'y', 'z']) {
      const d = b[axis] - a[axis];
      const half = HALF;
      if (Math.abs(d) < 1e-8) {
        if (a[axis] < -half || a[axis] > half) return null;
        continue;
      }
      let t1 = (-half - a[axis]) / d;
      let t2 = (half - a[axis]) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
    return {
      t: tMin,
      x: a.x + (b.x - a.x) * tMin,
      y: a.y + (b.y - a.y) * tMin,
    };
  }

  burst(position, hand, count = 10) {
    for (let i = 0; i < count; i++) {
      let spark = this.sparkPool.pop();
      if (!spark) {
        spark = new THREE.Mesh(this.sparkGeo, this.sparkMats[hand]);
        this.scene.add(spark);
      }
      spark.material = this.sparkMats[hand];
      spark.visible = true;
      spark.position.copy(position);
      spark.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4.5,
        (Math.random() - 0.5) * 4.5 + 1,
        (Math.random() - 0.2) * 3.5
      );
      spark.userData.life = 0.45 + Math.random() * 0.3;
      spark.userData.age = 0;
      this.activeSparks.push(spark);
    }
  }

  /** Two halves flying apart perpendicular to the cut. */
  slice(mesh, hand, cutAngle, swingDir) {
    for (const sign of [-1, 1]) {
      let piece = this.debrisPool.pop();
      if (!piece) {
        piece = new THREE.Mesh(this.halfGeo, this.debrisMats[hand]);
        this.scene.add(piece);
      }
      piece.material = this.debrisMats[hand].clone();
      piece.visible = true;
      piece.position.copy(mesh.position);
      piece.rotation.set(0, 0, cutAngle);
      piece.translateY(sign * HALF / 2);

      const perp = new THREE.Vector3(-swingDir.y, swingDir.x, 0).multiplyScalar(sign * 2.4);
      piece.userData.vel = perp.add(new THREE.Vector3(0, 0.6, 2 + Math.random()));
      piece.userData.spin = new THREE.Vector3(
        (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, sign * 5
      );
      piece.userData.age = 0;
      piece.userData.life = 0.8;
      this.activeDebris.push(piece);
    }
    this.burst(mesh.position, hand);
  }

  updateEffects(dt) {
    for (let i = this.activeDebris.length - 1; i >= 0; i--) {
      const d = this.activeDebris[i];
      d.userData.age += dt;
      d.userData.vel.y -= 9.8 * dt;
      d.position.addScaledVector(d.userData.vel, dt);
      d.rotation.x += d.userData.spin.x * dt;
      d.rotation.y += d.userData.spin.y * dt;
      d.rotation.z += d.userData.spin.z * dt;
      const k = 1 - d.userData.age / d.userData.life;
      d.material.opacity = Math.max(0, k);
      d.scale.setScalar(Math.max(0.01, k));
      if (k <= 0) {
        d.visible = false;
        this.activeDebris.splice(i, 1);
        this.debrisPool.push(d);
      }
    }

    for (let i = this.activeSparks.length - 1; i >= 0; i--) {
      const s = this.activeSparks[i];
      s.userData.age += dt;
      s.userData.vel.y -= 6 * dt;
      s.position.addScaledVector(s.userData.vel, dt);
      const k = 1 - s.userData.age / s.userData.life;
      s.scale.setScalar(Math.max(0.01, k));
      if (k <= 0) {
        s.visible = false;
        this.activeSparks.splice(i, 1);
        this.sparkPool.push(s);
      }
    }
  }
}
