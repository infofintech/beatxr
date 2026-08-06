// World-locked canvas HUD - readable both in the headset and on desktop.

import * as THREE from 'three';

export class Hud {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), mat);
    this.mesh.position.set(0, 2.55, -3.2);
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);

    this.state = { score: 0, combo: 0, multiplier: 1, accuracy: 1, energy: 0.5, message: '', progress: 0 };
    this._dirty = true;
  }

  set(state) {
    Object.assign(this.state, state);
    this._dirty = true;
  }

  update() {
    if (!this._dirty) return;
    this._dirty = false;
    const { ctx, canvas } = this;
    const { score, combo, multiplier, accuracy, energy, message, progress } = this.state;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(4,8,18,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (message) {
      ctx.fillStyle = '#7ef0ff';
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(message, canvas.width / 2, 150);
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 84px system-ui, sans-serif';
      ctx.fillText(score.toLocaleString(), 36, 100);

      ctx.font = '34px system-ui, sans-serif';
      ctx.fillStyle = '#8ea6c8';
      ctx.fillText(`${Math.round(accuracy * 100)}% accuracy`, 38, 150);

      ctx.textAlign = 'right';
      ctx.fillStyle = combo > 0 ? '#2affd5' : '#55607a';
      ctx.font = 'bold 72px system-ui, sans-serif';
      ctx.fillText(`${combo}`, canvas.width - 40, 92);
      ctx.font = '34px system-ui, sans-serif';
      ctx.fillStyle = '#8ea6c8';
      ctx.fillText(`combo  x${multiplier}`, canvas.width - 40, 142);

      // Energy bar.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(36, 178, canvas.width - 72, 14);
      ctx.fillStyle = energy > 0.3 ? '#2affd5' : '#ff4d6d';
      ctx.fillRect(36, 178, (canvas.width - 72) * energy, 14);
    }

    // Song progress.
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, canvas.height - 10, canvas.width, 10);
    ctx.fillStyle = '#4d8dff';
    ctx.fillRect(0, canvas.height - 10, canvas.width * progress, 10);

    this.texture.needsUpdate = true;
  }
}
