/* components/gx-map/gx-map.js */
/**
 * GX Map — deterministic, self-contained pan/zoom surface.
 *
 * Features:
 * - Smooth pan/zoom using a rAF-driven transform pipeline
 * - Pointer Events: mouse/touch/pen support, pinch-to-zoom
 * - Inertial panning (disabled if prefers-reduced-motion)
 * - Double-tap/double-click zoom
 * - Keyboard navigation (arrows, +/-, 0, F)
 * - Audit hooks (CustomEvent + optional global sink)
 *
 * No external dependencies.
 */

(() => {
  'use strict';

  const SELECTOR = '[data-gx-map]';

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * Default audit sink:
   * - dispatches a DOM event so host code can listen deterministically
   * - calls globalThis.GX_AUDIT(entry) if present
   * - stores a local in-memory log in globalThis.__GX_AUDIT_LOG__
   */
  function emitAudit(root, entry) {
    try {
      root.dispatchEvent(new CustomEvent('gx:map:audit', { detail: entry }));
    } catch (_) { /* ignore */ }

    if (typeof globalThis.GX_AUDIT === 'function') {
      try { globalThis.GX_AUDIT(entry); } catch (_) { /* ignore */ }
    }

    try {
      if (!globalThis.__GX_AUDIT_LOG__) globalThis.__GX_AUDIT_LOG__ = [];
      globalThis.__GX_AUDIT_LOG__.push(entry);
    } catch (_) { /* ignore */ }

    // Local dev: keep this on; production may suppress.
    // eslint-disable-next-line no-console
    console.debug('[GX_MAP_AUDIT]', entry);
  }

  class GXMap {
    constructor(root) {
      this.root = root;
      this.viewport = root.querySelector('.gx-map__viewport');
      this.content = root.querySelector('.gx-map__content');
      this.statusEl = root.querySelector('.gx-map__status');

      this.btnZoomIn = root.querySelector('[data-gx-map-zoom-in]');
      this.btnZoomOut = root.querySelector('[data-gx-map-zoom-out]');
      this.btnFit = root.querySelector('[data-gx-map-fit]');
      this.btnReset = root.querySelector('[data-gx-map-reset]');
      this.btnHelp = root.querySelector('[data-gx-map-help]');

      // Parse config from data attributes for deterministic behavior.
      this.minScale = parseFloat(root.dataset.gxMapMinScale || '0.25');
      this.maxScale = parseFloat(root.dataset.gxMapMaxScale || '6');
      this.zoomStep = parseFloat(root.dataset.gxMapZoomStep || '1.2');
      this.panStep = parseFloat(root.dataset.gxMapPanStep || '64');

      // Inertia config (tuned for low-end hardware; minimal allocations).
      this.enableInertia = !prefersReducedMotion();
      this.frictionPerFrame = 0.90;      // lower = more friction
      this.stopSpeed = 0.02;             // px/ms

      // Transform state: screen-space translate + unitless scale.
      this.tx = 0;
      this.ty = 0;
      this.scale = 1;

      // The “world” size comes from SVG width/height.
      const svg = this.root.querySelector('svg.gx-map__svg');
      this.worldW = svg ? (svg.viewBox?.baseVal?.width || svg.width?.baseVal?.value || 1200) : 1200;
      this.worldH = svg ? (svg.viewBox?.baseVal?.height || svg.height?.baseVal?.value || 800) : 800;

      // Active pointer tracking for pan/pinch.
      this.pointers = new Map(); // pointerId -> { x, y }
      this.isPanning = false;
      this.pinch = null;

      // Velocity tracking for inertial pan.
      this.lastMoveT = 0;
      this.vx = 0;
      this.vy = 0;

      // Double tap tracking.
      this.lastTapT = 0;
      this.lastTapPos = null;

      // rAF scheduling
      this.raf = 0;
      this.dirty = false;
      this.inertiaRAF = 0;

      this.bind();
      this.fitToView('init');
      this.updateStatus('Ready');

      emitAudit(this.root, {
        ts: new Date().toISOString(),
        type: 'map.init',
        detail: { worldW: this.worldW, worldH: this.worldH }
      });
    }

    bind() {
      if (!this.viewport || !this.content) return;

      // Pointer Events unify mouse/touch/pen. We use pointer capture for stability.
      this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.viewport.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.viewport.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.viewport.addEventListener('pointercancel', (e) => this.onPointerUp(e));

      // Wheel zoom: must be non-passive if we preventDefault().
      this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

      // Double click zoom for mouse users.
      this.viewport.addEventListener('dblclick', (e) => this.onDoubleClick(e));

      // Keyboard navigation (viewport is tabindex=0).
      this.viewport.addEventListener('keydown', (e) => this.onKeyDown(e));

      // Buttons
      if (this.btnZoomIn) this.btnZoomIn.addEventListener('click', () => this.zoomBy(this.zoomStep, this.viewportCenter()));
      if (this.btnZoomOut) this.btnZoomOut.addEventListener('click', () => this.zoomBy(1 / this.zoomStep, this.viewportCenter()));
      if (this.btnFit) this.btnFit.addEventListener('click', () => this.fitToView('button'));
      if (this.btnReset) this.btnReset.addEventListener('click', () => this.resetView('button'));
      if (this.btnHelp) this.btnHelp.addEventListener('click', () => this.showHelp());
    }

    viewportRect() {
      return this.viewport.getBoundingClientRect();
    }

    viewportCenter() {
      const r = this.viewportRect();
      return { x: r.width / 2, y: r.height / 2 };
    }

    // Convert a viewport-local screen point to world coords.
    screenToWorld(p) {
      return {
        x: (p.x - this.tx) / this.scale,
        y: (p.y - this.ty) / this.scale
      };
    }

    scheduleRender() {
      if (this.raf) return;
      this.raf = window.requestAnimationFrame(() => this.render());
    }

    render() {
      this.raf = 0;
      if (!this.dirty) return;
      this.dirty = false;

      // GPU-friendly composite transform.
      this.content.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    }

    setTransform(nextTx, nextTy, nextScale, reason) {
      this.scale = clamp(nextScale, this.minScale, this.maxScale);
      this.tx = nextTx;
      this.ty = nextTy;

      this.constrainToBounds();
      this.dirty = true;
      this.scheduleRender();

      if (reason) {
        emitAudit(this.root, {
          ts: new Date().toISOString(),
          type: 'map.transform',
          detail: { reason, tx: this.tx, ty: this.ty, scale: this.scale }
        });
      }
    }

    constrainToBounds() {
      const r = this.viewportRect();
      const contentW = this.worldW * this.scale;
      const contentH = this.worldH * this.scale;

      // If content smaller than viewport, center it. Otherwise clamp.
      if (contentW <= r.width) {
        this.tx = (r.width - contentW) / 2;
      } else {
        this.tx = clamp(this.tx, r.width - contentW, 0);
      }

      if (contentH <= r.height) {
        this.ty = (r.height - contentH) / 2;
      } else {
        this.ty = clamp(this.ty, r.height - contentH, 0);
      }
    }

    fitToView(reason) {
      const r = this.viewportRect();
      const sx = r.width / this.worldW;
      const sy = r.height / this.worldH;
      const s = clamp(Math.min(sx, sy), this.minScale, this.maxScale);

      const contentW = this.worldW * s;
      const contentH = this.worldH * s;

      const tx = (r.width - contentW) / 2;
      const ty = (r.height - contentH) / 2;

      this.setTransform(tx, ty, s, `fit:${reason}`);
      this.updateStatus(`Fit to view (${Math.round(this.scale * 100)}%)`);
    }

    resetView(reason) {
      this.setTransform(0, 0, 1, `reset:${reason}`);
      this.updateStatus(`Reset (${Math.round(this.scale * 100)}%)`);
    }

    updateStatus(msg) {
      if (!this.statusEl) return;
      this.statusEl.textContent = `${msg} • Zoom ${Math.round(this.scale * 100)}%`;
    }

    showHelp() {
      this.updateStatus('Help: drag pan • wheel/pinch zoom • arrows pan • +/- zoom • 0 reset • F fit');
      emitAudit(this.root, { ts: new Date().toISOString(), type: 'map.help', detail: {} });
    }

    stopInertia() {
      if (this.inertiaRAF) {
        window.cancelAnimationFrame(this.inertiaRAF);
        this.inertiaRAF = 0;
      }
      this.vx = 0;
      this.vy = 0;
    }

    startInertia() {
      if (!this.enableInertia) return;
      const speed = Math.hypot(this.vx, this.vy);
      if (speed < this.stopSpeed) return;

      let lastT = performance.now();
      const step = () => {
        const now = performance.now();
        const dt = Math.max(1, now - lastT);
        lastT = now;

        // Apply motion (vx/vy are px per ms).
        this.tx += this.vx * dt;
        this.ty += this.vy * dt;

        // Exponential decay (dt scaled to ~60fps).
        const decay = Math.pow(this.frictionPerFrame, dt / 16.6667);
        this.vx *= decay;
        this.vy *= decay;

        this.constrainToBounds();
        this.dirty = true;
        this.scheduleRender();

        const s = Math.hypot(this.vx, this.vy);
        if (s >= this.stopSpeed) {
          this.inertiaRAF = window.requestAnimationFrame(step);
        } else {
          this.inertiaRAF = 0;
        }
      };

      emitAudit(this.root, { ts: new Date().toISOString(), type: 'map.inertia.start', detail: { vx: this.vx, vy: this.vy } });
      this.inertiaRAF = window.requestAnimationFrame(step);
    }

    onPointerDown(e) {
      // Only respond to primary button for mouse; touch/pen are fine.
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      // Prevent text selection and other defaults inside the viewport.
      e.preventDefault();

      this.viewport.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      this.stopInertia();

      if (this.pointers.size === 1) {
        this.isPanning = true;
        this.lastMoveT = performance.now();
        this.vx = 0;
        this.vy = 0;
      } else if (this.pointers.size === 2) {
        // Initialize pinch.
        const pts = Array.from(this.pointers.values());
        const a = pts[0], b = pts[1];
        const m = mid(a, b);

        const r = this.viewportRect();
        const localMid = { x: m.x - r.left, y: m.y - r.top };
        const worldMid = this.screenToWorld(localMid);

        this.pinch = {
          startDist: dist(a, b),
          startScale: this.scale,
          startWorld: worldMid
        };
      }

      emitAudit(this.root, {
        ts: new Date().toISOString(),
        type: 'map.pointer.down',
        detail: { pointerType: e.pointerType, pointers: this.pointers.size }
      });
    }

    onPointerMove(e) {
      if (!this.pointers.has(e.pointerId)) return;

      e.preventDefault();

      const prev = this.pointers.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      this.pointers.set(e.pointerId, cur);

      const r = this.viewportRect();

      if (this.pointers.size === 2 && this.pinch) {
        const pts = Array.from(this.pointers.values());
        const a = pts[0], b = pts[1];
        const m = mid(a, b);
        const newDist = dist(a, b);

        const scaleFactor = newDist / Math.max(1, this.pinch.startDist);
        const newScale = clamp(this.pinch.startScale * scaleFactor, this.minScale, this.maxScale);

        // Anchor zoom around the original world midpoint, but follow current midpoint position.
        const localMidNow = { x: (m.x - r.left), y: (m.y - r.top) };
        const tx = localMidNow.x - this.pinch.startWorld.x * newScale;
        const ty = localMidNow.y - this.pinch.startWorld.y * newScale;

        this.setTransform(tx, ty, newScale, 'pinch');
        this.updateStatus('Pinch zoom');
        return;
      }

      if (this.pointers.size === 1 && this.isPanning) {
        const now = performance.now();
        const dt = Math.max(1, now - this.lastMoveT);
        this.lastMoveT = now;

        const dx = (cur.x - prev.x);
        const dy = (cur.y - prev.y);

        // Update translation; store velocity for inertia.
        this.tx += dx;
        this.ty += dy;

        this.vx = dx / dt;
        this.vy = dy / dt;

        this.constrainToBounds();
        this.dirty = true;
        this.scheduleRender();

        this.updateStatus('Panning');
      }
    }

    onPointerUp(e) {
      if (!this.pointers.has(e.pointerId)) return;

      e.preventDefault();
      this.pointers.delete(e.pointerId);

      // Double-tap zoom (touch only): detect quick repeated taps near same location.
      if (e.pointerType === 'touch') {
        const t = performance.now();
        const pos = { x: e.clientX, y: e.clientY };

        if (this.lastTapPos && (t - this.lastTapT) < 280) {
          const d = Math.hypot(pos.x - this.lastTapPos.x, pos.y - this.lastTapPos.y);
          if (d < 24) {
            const r = this.viewportRect();
            const local = { x: pos.x - r.left, y: pos.y - r.top };
            this.zoomBy(this.zoomStep, local);
            this.updateStatus('Double-tap zoom');
          }
        }

        this.lastTapT = t;
        this.lastTapPos = pos;
      }

      if (this.pointers.size < 2) {
        this.pinch = null;
      }

      const wasPanning = this.isPanning;
      if (this.pointers.size === 0) {
        this.isPanning = false;
        if (wasPanning) this.startInertia();
      }

      emitAudit(this.root, {
        ts: new Date().toISOString(),
        type: 'map.pointer.up',
        detail: { pointerType: e.pointerType, pointers: this.pointers.size }
      });
    }

    onWheel(e) {
      // We are implementing zoom; prevent page scroll inside viewport.
      e.preventDefault();

      // Typical convention: wheel deltaY > 0 means zoom out.
      // Clamp zoom factor per event to keep trackpad pinch and wheel sane.
      const delta = clamp(e.deltaY, -120, 120);
      const factor = (delta < 0) ? this.zoomStep : (1 / this.zoomStep);

      const r = this.viewportRect();
      const local = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.zoomBy(factor, local);

      this.updateStatus('Wheel zoom');
      emitAudit(this.root, { ts: new Date().toISOString(), type: 'map.wheel', detail: { deltaY: e.deltaY, ctrlKey: !!e.ctrlKey } });
    }

    onDoubleClick(e) {
      // Mouse double click zoom-in.
      const r = this.viewportRect();
      const local = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.zoomBy(this.zoomStep, local);
      this.updateStatus('Double-click zoom');
      emitAudit(this.root, { ts: new Date().toISOString(), type: 'map.dblclick', detail: {} });
    }

    zoomBy(factor, anchorLocal) {
      const a = anchorLocal || this.viewportCenter();

      // World coordinate under anchor before zoom.
      const w = this.screenToWorld(a);

      const newScale = clamp(this.scale * factor, this.minScale, this.maxScale);

      // Keep anchor pinned: a = t + w*scale  =>  t = a - w*scale
      const tx = a.x - w.x * newScale;
      const ty = a.y - w.y * newScale;

      this.setTransform(tx, ty, newScale, 'zoom');
      this.updateStatus(`Zoom ${Math.round(this.scale * 100)}%`);
    }

    panBy(dx, dy) {
      this.setTransform(this.tx + dx, this.ty + dy, this.scale, 'keypan');
      this.updateStatus('Keyboard pan');
    }

    onKeyDown(e) {
      // Use KeyboardEvent.key values (not deprecated keyCode).
      const step = e.shiftKey ? (this.panStep * 3) : this.panStep;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault(); this.panBy(step, 0); return;
        case 'ArrowRight':
          e.preventDefault(); this.panBy(-step, 0); return;
        case 'ArrowUp':
          e.preventDefault(); this.panBy(0, step); return;
        case 'ArrowDown':
          e.preventDefault(); this.panBy(0, -step); return;
        case '+':
        case '=': // common “plus” without shift
          e.preventDefault(); this.zoomBy(this.zoomStep, this.viewportCenter()); return;
        case '-':
        case '_':
          e.preventDefault(); this.zoomBy(1 / this.zoomStep, this.viewportCenter()); return;
        case '0':
          e.preventDefault(); this.resetView('key'); return;
        case 'f':
        case 'F':
          e.preventDefault(); this.fitToView('key'); return;
        case 'h':
        case 'H':
          e.preventDefault(); this.showHelp(); return;
        default:
          return;
      }
    }
  }

  function initMap(root) {
    if (root.__gxMapInstance) return;
    root.__gxMapInstance = new GXMap(root);
  }

  function initAll() {
    const roots = Array.from(document.querySelectorAll(SELECTOR));

    // Optional lazy init: mark container with data-gx-map-lazy="1".
    const lazyRoots = roots.filter(r => r.dataset.gxMapLazy === '1');

    if (lazyRoots.length && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            initMap(e.target);
            io.unobserve(e.target);
          }
        }
      }, { root: null, threshold: 0.05 });

      lazyRoots.forEach(r => io.observe(r));
    }

    // Non-lazy init
    roots.filter(r => r.dataset.gxMapLazy !== '1').forEach(initMap);
  }

  // Defer init until DOM is parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once: true });
  } else {
    initAll();
  }
})();
