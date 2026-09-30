/* ══════════════════════════════════════════════
   PONTE EN PAUSA · main.js
   Nav, reveal, fondo neural, contadores, FAQ
   ══════════════════════════════════════════════ */
(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══ NAV: sombra al hacer scroll ═══ */
  const nav = $('#nav');
  const links = $('#nav-links');
  const burger = $('#burger');

  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  burger.addEventListener('click', () => {
    const open = links.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      links.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    }
  });

  /* ═══ REVEAL al entrar en viewport ═══ */
  const revealables = $$('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const d = Number(en.target.dataset.delay || 0);
        setTimeout(() => en.target.classList.add('is-in'), d * 110);
        io.unobserve(en.target);
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add('is-in'));
  }

  /* ═══ FONDO: red neuronal de partículas ═══ */
  (function neural() {
    const c = $('#bg-neural');
    const ctx = c.getContext('2d');
    let w = 0, h = 0, dpr = 1;
    let pts = [];
    const mouse = { x: -9999, y: -9999 };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round(Math.min(78, Math.max(26, (w * h) / 26000)));
      pts = Array.from({ length: target }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.24, vy: (Math.random() - 0.5) * 0.24,
        r: Math.random() * 1.5 + 0.5
      }));
    };

    const LINK = 132;

    const frame = (staticOnly) => {
      ctx.clearRect(0, 0, w, h);

      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = w + 20; if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20; if (p.y > h + 20) p.y = -20;
      }

      // enlaces
      ctx.lineWidth = 1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        // al mouse
        const dxm = a.x - mouse.x, dym = a.y - mouse.y;
        const dm = Math.hypot(dxm, dym);
        if (dm < 190) {
          ctx.strokeStyle = 'rgba(53,224,240,' + (0.16 * (1 - dm / 190)).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
        }
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < LINK) {
            ctx.strokeStyle = 'rgba(124,92,255,' + (0.14 * (1 - d / LINK)).toFixed(3) + ')';
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }

      // nodos
      for (const p of pts) {
        ctx.fillStyle = 'rgba(180,190,255,.5)';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }

      if (!staticOnly) requestAnimationFrame(() => frame(false));
    };

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
    window.addEventListener('mouseleave', () => { mouse.x = mouse.y = -9999; });

    resize();
    frame(reduced);
  })();

  /* ═══ FAQ: solo una abierta a la vez ═══ */
  $$('.qa').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) $$('.qa').forEach((o) => { if (o !== d) o.open = false; });
    });
  });

  /* ═══ Contador animado de "4.9/5" ═══ */
  (function rating() {
    const el = $$('.stats dt').find((d) => d.textContent.includes('/5'));
    if (!el) return;
    const target = 4.9;
    let cur = 0;
    const run = () => {
      cur += (target - cur) * 0.08;
      el.textContent = cur.toFixed(1) + '/5';
      if (Math.abs(target - cur) > 0.01) requestAnimationFrame(run);
      else el.textContent = target.toFixed(1) + '/5';
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => {
        es.forEach((e) => { if (e.isIntersecting) { run(); io.disconnect(); } });
      }, { threshold: 0.6 });
      io.observe(el);
    }
  })();

  /* ═══ Year en footer ═══ */
  (function year() {
    const el = $('.foot__base span');
    if (el) el.textContent = '© ' + new Date().getFullYear() + ' PONTE EN PAUSA Labs';
  })();
})();
