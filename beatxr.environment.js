// The room: scrolling neon grid, receding rings and side rails that react to the music.

import * as THREE from 'three';

const LEFT_COLOR = 0xff2b55;
const RIGHT_COLOR = 0x2b8cff;

function gridTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#04060d';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(90,190,255,0.55)';
  g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * size;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 24);
  tex.anisotropy = 4;
  return tex;
}

export class Environment {
  constructor(scene, spawnDistance) {
    this.scene = scene;
    this.spawnDistance = spawnDistance;
    this.group = new THREE.Group();
    scene.add(this.group);

    scene.background = new THREE.Color(0x03050b);
    scene.fog = new THREE.Fog(0x03050b, 12, spawnDistance + 6);

    this.gridTex = gridTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, spawnDistance * 2.4),
      new THREE.MeshBasicMaterial({ map: this.gridTex, transparent: true, opacity: 0.85 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -spawnDistance * 0.9;
    this.group.add(floor);

    const ceiling = floor.clone();
    ceiling.material = floor.material.clone();
    ceiling.material.opacity = 0.25;
    ceiling.position.y = 6;
    ceiling.rotation.x = Math.PI / 2;
    this.group.add(ceiling);

    // Receding rings that recycle toward the player.
    this.rings = [];
    const ringGeo = new THREE.TorusGeometry(4.2, 0.045, 6, 4);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x1f6fff, transparent: true, opacity: 0.5 });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.position.set(0, 1.4, -(i / 14) * spawnDistance * 2);
      ring.rotation.z = Math.PI / 4;
      this.group.add(ring);
      this.rings.push(ring);
    }

    // Side rails - one per saber colour.
    this.rails = [];
    for (const [sign, color] of [[-1, LEFT_COLOR], [1, RIGHT_COLOR]]) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 });
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, spawnDistance * 2), mat);
      rail.position.set(sign * 2.6, 0.06, -spawnDistance * 0.9);
      this.group.add(rail);
      this.rails.push(rail);

      const light = new THREE.PointLight(color, 2, 14);
      light.position.set(sign * 2.4, 2.4, -6);
      this.group.add(light);
      this.rails.push(light);
    }

    this.group.add(new THREE.AmbientLight(0x334466, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(0, 4, 2);
    this.group.add(key);

    // Lane markers on the floor so the player can read the 4 columns.
    const laneMat = new THREE.MeshBasicMaterial({ color: 0x2affd5, transparent: true, opacity: 0.22 });
    for (let lane = 0; lane < 4; lane++) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.02, spawnDistance * 1.6), laneMat);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set((lane - 1.5) * 0.6, 0.005, -spawnDistance * 0.7);
      this.group.add(strip);
    }
  }

  update(dt, songTime, spectrum) {
    this.gridTex.offset.y = (songTime * 0.42) % 1;

    const pulse = 0.35 + spectrum.low * 1.4;
    for (const r of this.rails) {
      if (r.isLight) r.intensity = 1 + spectrum.low * 6;
      else r.material.opacity = Math.min(1, 0.4 + spectrum.mid * 0.9);
    }

    const speed = 14 + spectrum.mid * 10;
    for (const ring of this.rings) {
      ring.position.z += speed * dt;
      if (ring.position.z > 4) ring.position.z -= this.spawnDistance * 2;
      const d = 1 - Math.min(1, -ring.position.z / (this.spawnDistance * 2));
      ring.material.opacity = 0.12 + pulse * 0.35 * d;
      ring.scale.setScalar(1 + spectrum.low * 0.12);
    }
  }
}
