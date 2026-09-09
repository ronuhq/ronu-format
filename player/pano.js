// A simple drag-to-pan viewer for photo360 scenes.
//
// This is not a perspective projection. The equirectangular image is shown as
// a flat, scrollable strip: cheap, works with no WebGL on any phone, and good
// enough to find hotspots. Hotspot position mapping (see SPEC-GAPS G10):
//
//   yaw   in radians, 0 at the image's horizontal centre, positive to the
//         right, wrapping at +/- pi;   u = (yaw / 2pi + 0.5) * imageWidth
//   pitch in radians, 0 at the horizon, positive up, range +/- pi/2;
//         v = (0.5 - pitch / pi) * imageHeight
//
// The view shows a vertical field of view of VFOV_FRACTION of the image height
// and pans by dragging or with the arrow keys. A tap (no drag) reports the
// yaw/pitch under the finger so the engine can run hidden-hotspot discovery.

const VFOV_FRACTION = 0.5; // half the image height (about 90 degrees) fills the viewport
const TAP_SLOP_PX = 8;

export class PanoView {
  /**
   * @param {HTMLElement} container  positioned block; the canvas fills it
   * @param {object} opts  { src?: string, onTap?: ({yaw,pitch}) => void, onMarker?: (id) => void }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.onTap = opts.onTap ?? (() => {});
    this.onMarker = opts.onMarker ?? (() => {});
    this.yaw = 0;
    this.pitch = 0;
    this.markers = [];
    this.img = null;
    this.imgW = 2048;
    this.imgH = 1024;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pano-canvas';
    this.canvas.setAttribute('aria-label', 'Panorama. Drag to look around, tap to inspect.');
    this.canvas.tabIndex = 0;
    this.layer = document.createElement('div');
    this.layer.className = 'pano-markers';
    container.appendChild(this.canvas);
    container.appendChild(this.layer);

    this.ctx = this.canvas.getContext('2d');
    this.bindEvents();
    this.resize();
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(container);

    if (opts.src) {
      const img = new Image();
      img.onload = () => {
        this.img = img;
        this.imgW = img.naturalWidth || 2048;
        this.imgH = img.naturalHeight || 1024;
        this.draw();
      };
      img.onerror = () => this.draw();
      img.src = opts.src;
    }
  }

  destroy() {
    this.ro?.disconnect();
    this.canvas.remove();
    this.layer.remove();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Scale from image pixels to screen pixels. */
  get scale() {
    return this.h / (this.imgH * VFOV_FRACTION);
  }

  /** Projection of yaw/pitch to screen coordinates (may fall outside the viewport). */
  project(yaw, pitch) {
    const s = this.scale;
    let du = ((yaw - this.yaw) / (2 * Math.PI)) * this.imgW;
    const half = this.imgW / 2;
    if (du > half) du -= this.imgW;
    if (du < -half) du += this.imgW;
    const dv = ((this.pitch - pitch) / Math.PI) * this.imgH;
    return { x: this.w / 2 + du * s, y: this.h / 2 + dv * s };
  }

  /** Inverse: screen point to yaw/pitch. */
  unproject(x, y) {
    const s = this.scale;
    let yaw = this.yaw + ((x - this.w / 2) / s / this.imgW) * 2 * Math.PI;
    if (yaw > Math.PI) yaw -= 2 * Math.PI;
    if (yaw < -Math.PI) yaw += 2 * Math.PI;
    const pitch = this.pitch - ((y - this.h / 2) / s / this.imgH) * Math.PI;
    return { yaw, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)) };
  }

  clampPitch() {
    const halfFov = (VFOV_FRACTION * Math.PI) / 2;
    const limit = Math.max(0, Math.PI / 2 - halfFov);
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  lookAt(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = pitch ?? 0;
    this.clampPitch();
    this.draw();
  }

  /** markers: [{ id, label, yaw, pitch, visible, found, locked }] */
  setMarkers(markers) {
    this.markers = markers;
    this.layer.replaceChildren();
    for (const m of markers) {
      if (!m.visible) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `hotspot-marker${m.found ? ' is-found' : ''}${m.locked ? ' is-locked' : ''}`;
      b.dataset.id = m.id;
      b.setAttribute('aria-label', m.label || 'Hotspot');
      b.title = m.label || '';
      const dot = document.createElement('span');
      dot.className = 'hotspot-dot';
      const lab = document.createElement('span');
      lab.className = 'hotspot-label';
      lab.textContent = m.label || '';
      b.append(dot, lab);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMarker(m.id);
      });
      this.layer.appendChild(b);
    }
    this.placeMarkers();
  }

  placeMarkers() {
    for (const b of this.layer.children) {
      const m = this.markers.find((x) => x.id === b.dataset.id);
      if (!m) continue;
      const p = this.project(m.yaw, m.pitch);
      const on = p.x >= -40 && p.x <= this.w + 40 && p.y >= -40 && p.y <= this.h + 40;
      b.style.display = on ? '' : 'none';
      b.style.left = `${p.x}px`;
      b.style.top = `${p.y}px`;
    }
  }

  draw() {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const s = this.scale;
    const drawW = this.imgW * s;
    const drawH = this.imgH * s;
    const u0 = (this.yaw / (2 * Math.PI) + 0.5) * this.imgW;
    const v0 = (0.5 - this.pitch / Math.PI) * this.imgH;
    const left = w / 2 - u0 * s;
    const top = h / 2 - v0 * s;
    if (this.img) {
      // Draw twice for horizontal wrap-around.
      for (const k of [-1, 0, 1]) {
        const x = left + k * drawW;
        if (x > w || x + drawW < 0) continue;
        ctx.drawImage(this.img, x, top, drawW, drawH);
      }
    } else {
      // No image (empty `environment.source`): a neutral gradient with a grid so panning is visible.
      const g = ctx.createLinearGradient(0, top, 0, top + drawH);
      g.addColorStop(0, '#2b3646');
      g.addColorStop(0.5, '#4d5b70');
      g.addColorStop(1, '#1e2530');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      const step = drawW / 24;
      for (let k = -1; k <= 1; k++) {
        for (let i = 0; i <= 24; i++) {
          const x = left + k * drawW + i * step;
          if (x < -1 || x > w + 1) continue;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      const horizon = top + drawH / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(w, horizon);
      ctx.stroke();
    }
    this.placeMarkers();
  }

  bindEvents() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false, id: e.pointerId };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) drag.moved = true;
      if (!drag.moved) return;
      const s = this.scale;
      this.yaw = drag.yaw - (dx / s / this.imgW) * 2 * Math.PI;
      if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
      if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
      this.pitch = drag.pitch + (dy / s / this.imgH) * Math.PI;
      this.clampPitch();
      this.draw();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasTap = !drag.moved;
      drag = null;
      if (wasTap) {
        const r = c.getBoundingClientRect();
        this.onTap(this.unproject(e.clientX - r.left, e.clientY - r.top));
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => {
      drag = null;
    });
    c.addEventListener('keydown', (e) => {
      const step = 0.15;
      if (e.key === 'ArrowLeft') this.yaw -= step;
      else if (e.key === 'ArrowRight') this.yaw += step;
      else if (e.key === 'ArrowUp') this.pitch += step;
      else if (e.key === 'ArrowDown') this.pitch -= step;
      else return;
      e.preventDefault();
      if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
      if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
      this.clampPitch();
      this.draw();
    });
  }
}
