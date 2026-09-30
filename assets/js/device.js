/* ══════════════════════════════════════════════
   PONTE EN PAUSA · device.js
   Panel "Conectar mi máscara" y sesión en vivo
   ══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const { MaskLink, PHASES, SESSION_MODES, PROFILES, SESSION_PLAN, buildPlan,
          willSleep, makeDream, clamp, fmtHM, store } = global.NEBULA;
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  
  const fmtClock = (min) => {
    const m = Math.max(0, Math.round(min));
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };
  // tiempo restante en formato de reloj real: mm:ss cuando la sesión es corta
  const fmtLeft = (min) => {
    const s = Math.max(0, Math.ceil(min * 60));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = String(m).padStart(2, '0');
    const rest = String(ss).padStart(2, '0');
    return (h ? h + ':' : '') + mm + ':' + rest;
  };

  /* ---------- memoria de la noche ----------
   Todo lo que hace falta para retomar la sesión se guarda en este navegador:
   el enlace, el perfil, el periodo elegido, el plan ya calculado (para que
   la noche no cambie al recargar), el hipnograma muestreado, los registros
   oníricos y la hora de inicio. La caducidad la aplica `NEBULA.store`. */
  const memory = (() => {
    const state = {
      seed: null, linked: false, pin: null,
      profileIdx: 0, modeIdx: 0,
      live: false, startedAt: 0, totalMin: 0, trial: false,
      asleep: true, plan: null, totals: null, asleepAt: 0, fellAsleep: true,
      hypBuf: [], dreams: [], telemetry: null, lastDream: null,
      report: null, savedAt: 0
    };

    function read() {
      const d = store.read();
      // sin nada guardado no es un error: se devuelve el estado por defecto
      if (!d) return state;
      if (Array.isArray(d.hypBuf)) state.hypBuf = d.hypBuf;
      if (Array.isArray(d.dreams)) state.dreams = d.dreams;
      if (d.seed !== undefined) state.seed = d.seed;
      if (d.pin) state.pin = d.pin;
      if (d.profileIdx !== undefined) state.profileIdx = d.profileIdx | 0;
      if (d.modeIdx !== undefined) state.modeIdx = d.modeIdx | 0;
      if (d.plan) state.plan = d.plan;
      if (d.totals) state.totals = d.totals;
      if (d.telemetry) state.telemetry = d.telemetry;
      if (d.lastDream) state.lastDream = d.lastDream;
      if (d.report) state.report = d.report;
      state.live = !!d.live;
      state.startedAt = d.startedAt || 0;
      state.totalMin = d.totalMin || 0;
      state.trial = !!d.trial;
      state.asleep = d.asleep !== false;
      state.fellAsleep = d.fellAsleep !== false;
      state.asleepAt = d.asleepAt || 0;
      state.linked = !!d.linked;
      return state;
    }

    function write() {
      return store.write(state);
    }

    function clear() {
      store.clear();
      state.seed = null;
      state.pin = null;
      state.linked = false;
      state.live = false;
      state.startedAt = 0;
      state.plan = null;
      state.hypBuf = [];
      state.dreams = [];
      state.report = null;
      state.telemetry = null;
      state.lastDream = null;
    }

    return { state, read, write, clear };
  })();

  const restored = memory.read();
  const mask = new MaskLink({ seed: restored.seed });
  // la semilla recuperada manda: el enlace es el mismo que antes de recargar
  if (restored.seed !== null) mask.seed = restored.seed;

  const history = [];        // telemetría para el hipnograma
  const dreams = restored.dreams.slice();
  let found = [];            // dispositivos del último escaneo

  // periodos disponibles. Todo corre a tiempo real (1 s = 1 s); la sesión
  // larga son las 3 h completas y los periodos de prueba son el mismo
  // protocolo a escala para verlo entero en 1, 3 o 5 minutos.
  let modeIdx = 0;
  const mode = () => SESSION_MODES[modeIdx];

  // perfil de quien usa la máscara. Cambia la latencia, los micro-despertares,
  // la forma del EEG, la telemetría, los sueños y el informe final.
  let profileIdx = 0;
  const profile = () => PROFILES[profileIdx];
  const setProfile = (i) => {
    profileIdx = clamp(i | 0, 0, PROFILES.length - 1);
    renderProfiles();
    // con la máscara vinculada, cambiar de perfil vuelve a calcular la noche
    // sincronizada: otra latencia, otros micro-despertares y otros sueños
    if (mask.state === 'linked') seedHistory();
  };

  /* ---------- estado de la UI ---------- */
  const statusBox = $('[data-status]');
  const statusTxt = $('.status__txt', statusBox);
  const hintBox = $('[data-hint]');
  const btnScan = $('[data-scan]');
  const btnSess = $('[data-session]');
  const btnSpeed = $('[data-speed]');
  const btnSpeedTxt = $('[data-speed-txt]');
  const modeNote = $('[data-mode-note]');
  const batBar = $('[data-bat]');
  const batTxt = $('[data-bat-txt]');
  const eegBox = $('.eeg');

  /* ---------- modal de emparejamiento ---------- */
  const pairEl = $('[data-pair]');
  const pairForm = $('[data-pair-form]');
  const pairInput = $('[data-pair-input]');
  const pairErr = $('[data-pair-err]');
  const pairName = $('[data-pair-name]');
  const pairMac = $('[data-pair-mac]');
  const pairRssi = $('[data-pair-rssi]');
  let pairBusy = false;

  /* El texto de "vinculada" tiene que hablar del periodo elegido: si la
     persona está en una prueba de 1 min, decirle que la sesión dura 3 h
     la confunde. */
  function linkedHint() {
    const m = mode();
    if (m.trial) {
      return 'Vinculada. Periodo de ' + m.label.toLowerCase() + ' (' + m.minutes +
        ' min reales): es la sesión de 3 h comprimida, con la misma proporción ' +
        'de conciliación, corte y ciclos. No está garantizado que llegues a dormirse.';
    }
    return 'Vinculada. La sesión dura 3 h exactos: 20 min de conciliación, 15 de ' +
      'corte de línea y el resto según los ciclos, en tiempo real.';
  }

  function setStatus(state, text) {
    statusBox.dataset.s = state;
    statusTxt.textContent = text;
  }

  function setLive(key, value) {
    $$('[data-live="' + key + '"]').forEach((el) => { el.textContent = value; });
  }

  function cycleSpeed() {
    modeIdx = (modeIdx + 1) % SESSION_MODES.length;
    applyMode();
  }

  function setMode(i) {
    modeIdx = clamp(i | 0, 0, SESSION_MODES.length - 1);
    applyMode();
  }

  // sincroniza botón de sesión y nota con el periodo elegido
  function applyMode() {
    const m = mode();
    btnSpeedTxt.textContent = m.label + ' · ' + m.short;
    if (!btnSess.disabled) {
      btnSess.textContent = m.trial ? 'Iniciar prueba de ' + m.short : 'Iniciar sesión de 3 h';
    }
    if (modeNote) {
      modeNote.textContent = m.trial
        ? 'Prueba de ' + m.short + ' reales · protocolo a escala · las líneas avanzan en tiempo real'
        : 'Sesión real de 3 h · sin aceleración · las líneas avanzan en tiempo real';
    }
  }

  /* ══════════════ CANVAS EEG ══════════════ */
  const eeg = $('#eeg-canvas');
  const eegCtx = eeg.getContext('2d');
  const CH_COLORS = ['#35e0f0', '#7c5cff', '#ff5ea8', '#3ddc97'];
  const CH_NAMES = ['AF7', 'AF3', 'F7', 'F8'];
  const CH_ROLE = ['frontal izq.', 'frontal der.', 'temporal izq.', 'occipital der.'];

  /* Ventana adaptativa: se muestran los segundos que hacen falta para unas
     ~10 ondas del ritmo actual, con un mínimo de 3 s para que siempre haya
     margen de pantalla. Así cada fase tiene una "densidad" reconocible:
       delta 1 Hz  -> 9.5 s, ~10 ondas lentas y grandes
       theta 7 Hz  -> 3   s, ~21 ondas
       beta 11 Hz  -> 3   s, ~35 ondas, textura fina pero con ritmo visible
     Una ventana fija de 12 s metía 90 ondas en 60 px: maraña ilegible.
     El usuario puede_multiplicar esa ventana con el zoom. */
  const winFor = (freq) => clamp(10 / Math.max(freq, 0.35), 3, 12);
  const RIBBON_H = 22;       // cinta de fases bajo las 4 trazas
  let waveFn = null;         // función (seg, canal) => [-1,1]
  let waveNow = 0;           // segundos de sesión que se están viendo
  let waveAmp = 0;           // amplitud típica actual, para escalar la traza
  let waveFreq = 6;          // ritmo dominante actual
  let eegOn = false;
  let cutLeft = 0;           // minutos que faltan para que vuelva la señal
  let sessTotal = 180;       // duración del periodo en curso
  let lastHypMin = -1;       // muestreo del hipnograma
  let lastHypPhase = null;
  let reportTick = 0;        // refresca el informe en vivo cada N ticks
  let lastTelemetry = null;  // gauges actuales, para retomar sin salto
  let lastDreamRef = null;   // último sueño, se guarda con la noche
  let lastSaveAt = 0;        // evita escribir en el navegador cada frame

  /* ══════════════ ZOOM Y DESPLAZAMIENTO ══════════════
     Una misma vista para el EEG y para el hipnograma. Cada vista guarda su
     propio factor y su propio desplazamiento, en la unidad del gráfico:
     segundos para el EEG, minutos para el hipnograma.

       zoom = 1        el EEG muestra su ventana adaptativa y el hipnograma
                       la noche entera
       zoom > 1        se amplía: en el EEG aparecen menos ondas por pantalla
                       pero más grandes; en el hipnograma los minutos se
                       separan y las transiciones se leen con detalle
       follow = true   la vista se pega al último dato y va avanzando sola
       follow = false  la vista queda fija en lo que el usuario está leyendo

     Con la rueda se hace zoom centrado en el puntero, que es lo que espera
     cualquiera que haya usado un editor de audio: lo que está bajo el cursor
     se queda donde está. En el hipnograma, donde el tiempo va de izquierda a
     derecha y no hay señal que "mirar", el zoom se ancla en el centro.     */
  const VIEWS = {
    eeg: { zoom: 1, off: 0, follow: true },
    hyp: { zoom: 1, off: 0, follow: true }
  };
  const ZOOM_MIN = 1, ZOOM_MAX = 60;

  // factor multiplicador de la ventana visible del EEG
  const eegWin = () => clamp(winFor(waveFreq) * VIEWS.eeg.zoom, 0.25, 240);

  function viewSpan(key) {
    return key === 'eeg' ? eegWin() : sessTotal / VIEWS.hyp.zoom;
  }

  /* Rango visible [inicio, fin] en la unidad del gráfico. Con follow pegado
     a la señal es una ventana que termina en el último dato; con la vista
     fija, `off` es el desplazamiento que el usuario dejó. */
  function viewRange(key) {
    const v = VIEWS[key];
    const span = viewSpan(key);
    if (v.follow) {
      const end = key === 'eeg' ? waveNow : Math.max(sessTotal, lastHypMinSeen());
      return [Math.max(0, end - span), end];
    }
    const start = v.off;
    return [start, start + span];
  }

  function lastHypMinSeen() {
    return hypBuf.length ? hypBuf[hypBuf.length - 1].min : 0;
  }

  function setZoom(key, z, anchorFrac) {
    const v = VIEWS[key];
    const z2 = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (z2 === v.zoom) return;
    // se conserva fijo el punto que quedó bajo el ancla al cambiar el zoom
    if (v.follow && key === 'eeg') {
      v.zoom = z2;
    } else {
      const [a, b] = viewRange(key);
      const pivot = a + (b - a) * (anchorFrac === undefined ? 0.5 : clamp(anchorFrac, 0, 1));
      v.zoom = z2;
      const span2 = viewSpan(key);
      let start = pivot - span2 * (anchorFrac === undefined ? 0.5 : clamp(anchorFrac, 0, 1));
      start = clamp(start, 0, Math.max(0, totalDomain(key) - span2));
      v.off = start;
      if (v.follow && key === 'hyp') v.follow = false;
    }
    syncZoomBar(key);
  }

  // dominio total del gráfico: el EEG no tiene final, el hipnograma sí
  const totalDomain = (key) => (key === 'eeg' ? Infinity : sessTotal);

  function panTo(key, start) {
    const v = VIEWS[key];
    const span = viewSpan(key);
    const dom = totalDomain(key);
    v.follow = false;
    v.off = dom === Infinity
      ? Math.max(0, start)
      : clamp(start, 0, Math.max(0, dom - span));
    syncZoomBar(key);
  }

  function resetView(key) {
    const v = VIEWS[key];
    v.zoom = 1;
    v.off = 0;
    v.follow = true;
    syncZoomBar(key);
  }

  function nudge(key, dir) {
    const v = VIEWS[key];
    const span = viewSpan(key);
    if (v.follow) { v.follow = false; v.off = viewRange(key)[0]; }
    panTo(key, v.off + dir * span * 0.5);
  }

  function syncZoomBar(key) {
    const out = document.querySelector('[data-zoom-val="' + key + '"]');
    if (out) out.textContent = VIEWS[key].zoom.toFixed(1) + '×';
    const bar = document.querySelector('[data-zoom="' + key + '"]');
    if (bar) bar.classList.toggle('is-panned', !VIEWS[key].follow);
  }

  /* Ratón, rueda y táctil sobre un lienzo. Se registra una sola vez por
     lienzo y delega en el objeto de vista que corresponda. */
  function bindZoom(key, canvas, redraw) {
    let dragging = false;
    let lastX = 0;
    const points = new Map();
    let pinch0 = 0, pinchZoom0 = 1, pinchFrac = 0;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / Math.max(r.width, 1), 0, 1);
      const step = Math.pow(1.18, -Math.sign(e.deltaY || 1));
      setZoom(key, VIEWS[key].zoom * step, frac);
      redraw();
    }, { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        points.set(e.pointerId, { x: e.clientX });
        if (points.size === 2) {
          const [a, b] = Array.from(points.values());
          pinch0 = Math.abs(a.x - b.x) || 1;
          pinchZoom0 = VIEWS[key].zoom;
          const r = canvas.getBoundingClientRect();
          pinchFrac = clamp(((a.x + b.x) / 2 - r.left) / Math.max(r.width, 1), 0, 1);
        }
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('is-grabbing');
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (!points.has(e.pointerId)) return;
        points.set(e.pointerId, { x: e.clientX });
        if (points.size >= 2) {
          const [a, b] = Array.from(points.values());
          const dist = Math.abs(a.x - b.x) || 1;
          setZoom(key, pinchZoom0 * (dist / pinch0), pinchFrac);
          redraw();
        }
        return;
      }
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      const dpx = (lastX - e.clientX) / Math.max(r.width, 1);
      lastX = e.clientX;
      const span = viewSpan(key);
      panTo(key, VIEWS[key].off + dpx * span);
      redraw();
    });

    const end = (e) => {
      points.delete(e.pointerId);
      if (points.size < 2) pinch0 = 0;
      dragging = false;
      canvas.classList.remove('is-grabbing');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);

    // doble toque / doble clic: volver a seguir la señal
    let lastTap = 0;
    canvas.addEventListener('pointerdown', (e) => {
      const now = Date.now();
      if (now - lastTap < 320) { resetView(key); redraw(); lastTap = 0; }
      else lastTap = now;
    });

    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', (e) => {
      const big = e.shiftKey ? 2 : 1;
      if (e.key === 'ArrowLeft') { nudge(key, -1 * big); redraw(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { nudge(key, 1 * big); redraw(); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { setZoom(key, VIEWS[key].zoom * 1.4); redraw(); }
      else if (e.key === '-' || e.key === '_') { setZoom(key, VIEWS[key].zoom / 1.4); redraw(); }
      else if (e.key === '0') { resetView(key); redraw(); }
    });
  }

  const canvasSize = new WeakMap();

  function sizeCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    // si el lienzo está en una pestaña oculta no tiene tamaño: se dibuja al
    // volver a mostrarla, y no se memoriza un 1x1 que luego hay que rehacer
    if (!r.width || !r.height) return null;
    const w = Math.round(r.width), h = Math.round(r.height);
    const prev = canvasSize.get(c);
    if (!prev || prev.w !== w || prev.h !== h || prev.dpr !== dpr) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      canvasSize.set(c, { w, h, dpr });
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, ctx };
  }

  /* Señal de fondo: la máscara "respira" aunque no haya sesión. */
  function idleWave(sec, ch) {
    const n = Math.sin(sec * 1.1 + ch * 1.7) * 0.35
            + Math.sin(sec * 2.7 + ch * 0.6) * 0.2
            + Math.sin(sec * 9.3 + ch * 2.1) * 0.06;
    return n;
  }

  function drawEEG() {
    const box = sizeCanvas(eeg);
    if (!box) return;
    const { w, h, ctx } = box;
    ctx.clearRect(0, 0, w, h);

    const plotH = h - RIBBON_H;      // zona de las 4 trazas
    const rowH = plotH / 4;
    const fn = waveFn || idleWave;
    const cut = cutLeft > 0;

    // el rango visible sale del motor de zoom: con follow pegado al último
    // dato, y fijo en lo que el usuario ha desplazado
    const win = waveFn ? eegWin() : 6;
    const [t0, t1] = waveFn ? viewRange('eeg') : [0, win];

    // fondo de cada canal + separadores
    for (let ch = 0; ch < 4; ch++) {
      ctx.fillStyle = ch % 2 ? 'rgba(255,255,255,.014)' : 'rgba(255,255,255,.028)';
      ctx.fillRect(0, rowH * ch, w, rowH);
      if (ch) {
        ctx.strokeStyle = 'rgba(124,92,255,.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(rowH * ch) + .5);
        ctx.lineTo(w, Math.round(rowH * ch) + .5);
        ctx.stroke();
      }
    }

    /* Grid: the spacing adapts to the zoom so the vertical lines always end
       up at a round time mark. Away from the signal it would be a 0.37 s grid,
       which is unreadable. */
    ctx.strokeStyle = 'rgba(124,92,255,.05)';
    ctx.lineWidth = 1;
    const grid = tickStep(win);
    const first = Math.ceil(t0 / grid) * grid;
    for (let s = first; s <= t1 + 1e-9; s += grid) {
      const xx = Math.round(((s - t0) / win) * w) + .5;
      ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, plotH); ctx.stroke();
    }

    /* The 4 traces: one point per pixel evaluating the wave function.
       The amplitude is ALREADY calibrated inside the function (WAVE[].amp), so
       here only a fixed scale per row height applies. Autoscaling
       per phase was the previous error: it put beta and delta at the same
       height and lost the contrast that makes the graph legible. */
    const scale = rowH * 0.44;
    for (let ch = 0; ch < 4; ch++) {
      const mid = rowH * ch + rowH / 2;
      ctx.strokeStyle = CH_COLORS[ch];
      ctx.globalAlpha = cut ? .34 : .92;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const sec = t0 + (x / w) * win;
        const y = mid - clamp(fn(sec, ch), -1, 1) * scale;
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // channel label
      ctx.fillStyle = CH_COLORS[ch];
      ctx.globalAlpha = .8;
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.fillText(CH_NAMES[ch], 6, rowH * ch + 13);
      ctx.globalAlpha = .38;
      ctx.font = '9px Sora, sans-serif';
      ctx.fillText(CH_ROLE[ch], 6, rowH * ch + 24);
      ctx.globalAlpha = 1;
    }

    // scale readout of the visible window, so the zoom is never a mystery
    ctx.fillStyle = 'rgba(106,118,160,.9)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(win.toFixed(win < 10 ? 1 : 0) + ' s en pantalla', w - 6, plotH - 6);
    ctx.textAlign = 'left';

    // ribbon of phases: the visible seconds coloured by state
    drawRibbon(ctx, w, plotH);

    if (cut) {
      ctx.fillStyle = 'rgba(4,5,13,.72)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff5c5c';
      ctx.font = '600 13px Sora, sans-serif';
      ctx.fillText('SEÑAL CORTADA', w / 2, plotH / 2 - 12);
      ctx.fillStyle = '#a2a8c8';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillText('electrodos desconectados · recalibrando', w / 2, plotH / 2 + 9);
      ctx.fillStyle = '#35e0f0';
      ctx.fillText('recuperación: ' + fmtClock(cutLeft), w / 2, plotH / 2 + 30);
      ctx.textAlign = 'left';
    }
  }

  /* Round time step for the grid: keep roughly 4 to 12 vertical lines whatever
     the zoom. The step jumps between 1-2-5-10-15-30-60 s as the user zooms. */
  function tickStep(span) {
    const target = span / 6;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) if (s >= target) return s;
    return steps[steps.length - 1];
  }

  /* Lower ribbon: the sleep state second by second. This is what makes the
     sequence "awake -> falling asleep -> deep -> waking up" readable, and it
     follows the same zoom and displacement as the traces above it. */
  function drawRibbon(ctx, w, y) {
    const h = RIBBON_H;
    ctx.fillStyle = 'rgba(4,5,13,.55)';
    ctx.fillRect(0, y, w, h);

    if (!waveFn) {
      ctx.fillStyle = '#3a4060';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText('no session · background signal', 8, y + 15);
      return;
    }

    const win = eegWin();
    const [t0, t1] = viewRange('eeg');
    let prev = null;
    for (let x = 0; x < w; x += 2) {
      const sec = t0 + (x / w) * win;
      // real phase at that instant: if the hypnogram buffer has it, use it
      let ph = lastHypPhase || 'N1';
      if (hypBuf.length) {
        const p = lastHypPhaseAt(sec);
        if (p) ph = p;
      }
      const col = PHASES[ph] ? PHASES[ph].color : '#333';
      ctx.fillStyle = col;
      ctx.globalAlpha = ph === prev ? .78 : .95;
      ctx.fillRect(x, y + 3, 2, h - 6);
      prev = ph;
    }
    ctx.globalAlpha = 1;

    // name of the phase at the right edge
    const nowPh = hypBuf.length ? (lastHypPhaseAt(t1) || lastHypPhase) : lastHypPhase;
    const meta = PHASES[nowPh];
    if (meta) {
      ctx.fillStyle = meta.color;
      ctx.font = '600 10px Sora, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(meta.short.toUpperCase(), w - 8, y + 15);
      ctx.textAlign = 'left';
    }
  }

  // fase que había en un instante dado, a partir del buffer muestreado
  function lastHypPhaseAt(sec) {
    let ph = null;
    const m = sec / 60;
    for (let i = 0; i < hypBuf.length; i++) {
      if (hypBuf[i].min <= m) ph = hypBuf[i].phaseId;
      else break;
    }
    return ph;
  }

  /* ══════════════ CANVAS HIPNOGRAMA ══════════════ */
  const hyp = $('#hypno-canvas');
  const fasesPane = $('.pane[data-pane="fases"]');
  const livePane = $('.pane[data-pane="live"]');
  /* `RL` es la franja de los ojos cerrados: la persona está despierta pero ya
     no mira nada. Va por debajo de "Despertar" y por encima del corte, porque
     es un escalón real entre estar despierto y dormirse. */
  const LEVEL = { W: 0, RL: 0.4, CUT: 0.9, R: 1.6, N1: 2.1, N2: 2.6, N3: 3.5 };
  // orden vertical del hipnograma, de más despierto a más profundo
  const HYPNO_ROWS = [
    { label: 'Despertar', level: LEVEL.W },
    { label: 'Ojos cerrados', level: LEVEL.RL },
    { label: 'Corte', level: LEVEL.CUT },
    { label: 'REM', level: LEVEL.R },
    { label: 'N1 / N2', level: LEVEL.N2 },
    { label: 'N3 profundo', level: LEVEL.N3 }
  ];
  const hypBuf = [];

  function drawHypno() {
    const box = sizeCanvas(hyp);
    if (!box) return;
    const { w, h, ctx } = box;
    ctx.clearRect(0, 0, w, h);

    const rows = HYPNO_ROWS;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#6f76a0';
    const yFor = (p) => 14 + (LEVEL[p] / 3.5) * (h - 34);
    rows.forEach((r) => ctx.fillText(r.label, 2, yFor(r.level) + 3));

    ctx.strokeStyle = 'rgba(124,92,255,.08)';
    for (let i = 0; i < rows.length; i++) {
      const y = 14 + (rows[i].level / 3.5) * (h - 34);
      ctx.beginPath(); ctx.moveTo(x0Of(w), y + .5); ctx.lineTo(w - 6, y + .5); ctx.stroke();
    }
    if (!hypBuf.length) {
      ctx.fillStyle = '#4a5078';
      ctx.font = '11px Sora, sans-serif';
      ctx.fillText('Ningún registro todavía. Vincula la máscara e inicia un periodo.',
        x0Of(w), 14 + (1.75) * (h - 34));
      return;
    }

    // the visible window comes from the shared zoom engine: by default the
    // whole night, and from there the user can separate the minutes and read
    // exactly where each transition happened
    const x0 = x0Of(w), wPlot = w - x0 - 6;
    const span = Math.max(sessTotal, 0.001);
    const [tMin, tMax] = viewRange('hyp');
    const viewSpanMin = Math.max(tMax - tMin, 0.001);
    const xFor = (m) => x0 + ((m - tMin) / viewSpanMin) * wPlot;
    const max = Math.max(hypBuf[hypBuf.length - 1].min, 0.001);

    // vertical grid, adapting its step to the zoom
    ctx.strokeStyle = 'rgba(124,92,255,.07)';
    const gStep = tickStep(viewSpanMin);
    for (let m = Math.ceil(tMin / gStep) * gStep; m <= tMax; m += gStep) {
      const xx = Math.round(xFor(m)) + .5;
      ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h - 12); ctx.stroke();
    }

    // elapsed time line
    ctx.fillStyle = 'rgba(124,92,255,.05)';
    ctx.fillRect(x0, 0, clamp((max - tMin) / viewSpanMin, 0, 1) * wPlot, h - 12);

    hypBuf.forEach((p, i) => {
      const nxt = hypBuf[i + 1];
      const x = xFor(p.min);
      const x2 = nxt ? xFor(nxt.min) : xFor(max);
      // only what is on screen is drawn: outside there is nothing to see
      if (x2 < x0 - 4 || x > w + 4) return;
      const y = yFor(p.phaseId);
      ctx.strokeStyle = PHASES[p.phaseId].color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (nxt) {
        ctx.moveTo(x, y);
        ctx.lineTo(x2, yFor(nxt.phaseId));
      } else {
        ctx.moveTo(x, y); ctx.lineTo(Math.max(x, x2), y);
      }
      ctx.stroke();

      // line-drop mark
      if (p.phaseId === 'CUT' && x > x0 && x < w) {
        ctx.fillStyle = '#ff5c5c';
        ctx.font = '600 9px Sora, sans-serif';
        ctx.fillText('corte', x + 2, y - 6);
      }
    });

    // time axis: at zoom 1 it reads "start ... end"; zoomed in, the marks
    ctx.fillStyle = '#6f76a0';
    ctx.font = '9px "JetBrains Mono", monospace';
    if (VIEWS.hyp.zoom <= 1.05) {
      ctx.fillText('00:00 inicio', x0, h - 4);
      ctx.fillText(fmtClock(sessTotal) + ' fin', w - 60, h - 4);
    } else {
      ctx.fillText(fmtClock(tMin), x0, h - 4);
      ctx.textAlign = 'right';
      ctx.fillText(fmtClock(tMax), w - 6, h - 4);
      ctx.textAlign = 'left';
    }

    // visible-range readout, so the zoom level is never a mystery
    ctx.fillStyle = 'rgba(106,118,160,.9)';
    ctx.textAlign = 'right';
    ctx.fillText(gStep + ' min por línea', w - 6, 10);
    ctx.textAlign = 'left';
  }

  const x0Of = (w) => (w < 520 ? 58 : 74);

  /* ══════════════ LISTA DE DISPOSITIVOS ══════════════ */
  const KIND_ICO = { mask: '◐', audio: '♪', periférico: '⌨', reloj: '◷', impresora: '⎙' };

  function renderFound() {
    const box = $('[data-found]');
    if (!found.length) { box.hidden = true; return; }
    box.hidden = false;
    $('[data-found-list]').innerHTML = found.map((d) => (
      '<li><button class="fdev' + (d.kind === 'mask' ? ' fdev--mask' : '') + '" data-pick="' + d.id + '"' +
        (d.kind === 'mask' ? ' data-pick-mask' : '') + '>' +
        '<span class="fdev__ico fdev__ico--' + d.kind + '">' + (KIND_ICO[d.kind] || '•') + '</span>' +
        '<span class="fdev__body">' +
          '<span class="fdev__name">' + d.name + '</span>' +
          '<span class="fdev__mac mono">' + d.mac + ' · ' + d.rssi + ' dBm</span>' +
        '</span>' +
        '<span class="fdev__tag">' + (d.kind === 'mask' ? 'Requiere clave' : 'Vinculado') + '</span>' +
      '</button></li>'
    )).join('');

    $$('[data-pick]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.pick)));
  }

  function onPick(id) {
    const d = found.find((x) => x.id === id);
    if (!d) return;
    if (d.kind !== 'mask') {
      setStatus('found', 'No es una máscara');
      hintBox.textContent = d.name + ' no es una PONTE EN PAUSA. Elige la de la lista para vincularla.';
      return;
    }
    openPair(d);
  }

  /* ══════════════ MODAL DE CLAVE ══════════════ */
  let pairDevice = null;

  function openPair(device) {
    pairDevice = device;
    pairName.textContent = device.name;
    pairMac.textContent = device.mac;
    pairRssi.textContent = device.rssi + ' dBm';
    pairInput.value = '';
    pairErr.hidden = true;
    pairEl.hidden = false;
    document.body.style.overflow = 'hidden';
    setStatus('found', 'Esperando clave');
    hintBox.textContent = 'Escribe la clave de 6 dígitos para vincular ' + device.name + '.';
    setTimeout(() => pairInput.focus(), 60);
  }

  function closePair() {
    if (pairBusy) return;
    pairEl.hidden = true;
    document.body.style.overflow = '';
    if (mask.state === 'found') {
      setStatus('found', 'Dispositivo encontrado');
      hintBox.textContent = 'Toca tu máscara en la lista para vincularla.';
    }
  }

  async function submitPin(e) {
    e.preventDefault();
    if (pairBusy) return;
    const pin = pairInput.value.replace(/\D/g, '').slice(0, 6);
    pairInput.value = pin;

    if (pin.length === 0) {
      pairErr.hidden = false;
      pairErr.textContent = 'Escribe la clave de 6 dígitos de la máscara.';
      return;
    }
    if (pin.length < 6) {
      pairErr.hidden = false;
      pairErr.textContent = 'La clave incompleta: ' + pin.length + ' de 6 dígitos.';
      return;
    }

    pairBusy = true;
    pairErr.hidden = true;
    $('[data-pair-form] .btn').textContent = 'Vinculando…';
    $('[data-pair-form] .btn').disabled = true;
    setStatus('pairing', 'Emparejando…');
    hintBox.textContent = 'Validando la clave con el dispositivo…';

    const res = await mask.pair(pin);

    pairBusy = false;
    $('[data-pair-form] .btn').textContent = 'Vincular';
    $('[data-pair-form] .btn').disabled = false;

    if (!res.ok) {
      pairErr.hidden = false;
      pairErr.textContent = 'El dispositivo rechazó la clave. Revisa los 6 dígitos e inténtalo otra vez.';
      setStatus('found', 'Clave incorrecta');
      pairInput.select();
      return;
    }

    pairEl.hidden = true;
    document.body.style.overflow = '';
    batBar.style.setProperty('--lvl', mask.battery + '%');
    batTxt.textContent = mask.battery + ' %';
    $('[data-dev="name"]').textContent = pairDevice ? pairDevice.name : mask.name;
    $('[data-dev="mac"]').textContent = mask.mac + ' · clave guardada';
    setStatus('linked', 'Conectada');
    hintBox.textContent = linkedHint();
    btnScan.disabled = false;
    btnScan.textContent = 'Desconectar';
    btnSess.disabled = false;
    applyMode();
    $('[data-found]').hidden = true;
    seedHistory();
  }

  /* ══════════════ SECUENCIA DE CONEXIÓN ══════════════ */
  async function scan() {
    if (mask.state === 'live' || pairBusy) return;
    btnScan.disabled = true;
    btnSess.disabled = true;
    found = [];
    renderFound();
    setStatus('scanning', 'Buscando…');
    hintBox.textContent = 'Escaneando bandas 2.4 GHz y 5 GHz. Mantén la máscara cerca.';

    const res = await mask.scan();

    if (!res.ok) {
      setStatus('idle', 'Sin conectar');
      hintBox.textContent = 'No encontramos ninguna PONTE EN PAUSA. Pulsa el botón físico hasta que el LED parpadee en azul e inténtalo otra vez.';
      btnScan.disabled = false;
      return;
    }

    found = res.devices;
    const own = found.find((x) => x.kind === 'mask');
    if (own) {
      $('[data-dev="name"]').textContent = own.name;
      $('[data-dev="mac"]').textContent = own.mac + ' · ' + own.rssi + ' dBm';
    }
    setStatus('found', found.length + (found.length === 1 ? ' dispositivo' : ' dispositivos'));
    hintBox.textContent = 'Toca tu máscara en la lista para escribir su clave de vinculación.';
    btnScan.disabled = false;
    btnScan.textContent = 'Volver a buscar';
    renderFound();
  }

  function disconnect() {
    if (mask.state === 'live') return;
    mask.disconnect();
    eegOn = false;
    cutLeft = 0;
    pairEl.hidden = true;
    setStatus('idle', 'Sin conectar');
    hintBox.textContent = 'Pulsa el botón físico de tu máscara hasta que el LED parpadee en azul y búscala aquí.';
    btnScan.textContent = 'Buscar dispositivos';
    btnSess.disabled = true;
    found = [];
    renderFound();
    // desconectar borra lo que este navegador tenía guardado de la noche
    memory.clear();
    $('[data-blocks]').innerHTML = '';
    $('[data-dreams]').innerHTML = emptyDreams();
    $('[data-report]').innerHTML = '<div class="empty"><span class="empty__ico">◷</span>' +
      '<p>Sin informe. Vincula la máscara e inicia un periodo para ver el reparto de fases, ' +
      'el hipnograma y los registros oníricos.</p></div>';
    hypBuf.length = 0;
    sessTotal = 180;
    drawHypno();
  }

/* Night history kept in the mask's own memory.
        When linking, the device hands over what it recorded: the phases, the
        blocks, the oneiric entries of the previous night and the report. */
  function seedHistory(opts) {
    const o = opts || {};
    const prof = profile();
    history.length = 0;
    hypBuf.length = 0;
    dreams.length = 0;
    mask.totals = null;
    mask.totalMin = 180;
    mask.trial = false;
    mask.profile = prof;
    sessTotal = 180;

    // a restored session keeps the night it already had: same plan, same sleep
    const resumed = !!(o.plan && o.plan.length);
    const plan = resumed ? o.plan : buildPlan(180, prof, o.asleep !== false);
    let cursor = 0;
    plan.forEach((p, i) => {
      history.push({ ...p, min: cursor, id: i });
      hypBuf.push({ min: cursor, phaseId: p.phase });
      cursor += p.min;
    });
    mask.plan = plan;
    mask.asleepAt = o.asleepAt || (resumed ? 0 : prof.latency + 20);
    mask.fellAsleep = o.fellAsleep !== false;
    mask.totals = plan.reduce((acc, p) => {
      acc[p.phase] = (acc[p.phase] || 0) + p.min;
      return acc;
    }, {});

    // last night's oneiric records, following the profile's own themes
    let cycle = 0;
    let at = 0;
    plan.forEach((p) => {
      if (p.phase === 'R') {
        cycle++;
        dreams.push(makeDream(at, at + p.min, cycle, prof));
      }
      at += p.min;
    });

    if (o.dreams && o.dreams.length) {
      dreams.length = 0;
      o.dreams.forEach((d) => dreams.push(d));
    }
    if (o.hypBuf && o.hypBuf.length) {
      hypBuf.length = 0;
      o.hypBuf.forEach((p) => hypBuf.push(p));
    }
    if (o.totalMin) {
      mask.totalMin = o.totalMin;
      mask.trial = !!o.trial;
      sessTotal = o.totalMin;
    }

    $('[data-blocks]').innerHTML = blockCards();
    drawHypno();
    $('[data-dreams]').innerHTML = syncNote() + dreamsHTML();
  }

  /* sync banner: the oneiric records come from the mask's own memory */
  function syncNote() {
    return '<div class="sync"><span class="sync__ico">⇅</span><p><b>Memoria de la máscara sincronizada.</b> ' +
      dreams.length + ' registros oníricos de la última noche, descargados del dispositivo ' +
      PROFILES.find((p) => p.id === profile().id).name + '. ' +
      'Los datos se guardan en este navegador y se borran solos a las ' + (store.TTL_MS / 3600000) +
      ' h de dejar de usarlos.</p></div>';
  }

  /* minutos por fase. Si la sesión en curso es un periodo de prueba se
     proyecta a 3 h, para que las cifras sean comparables con una sesión real. */
  function phaseMinutes() {
    const plan = SESSION_PLAN;
    if (mask.totals && mask.totalMin) {
      const factor = 180 / mask.totalMin;
      const acc = {};
      Object.keys(mask.totals).forEach((k) => { acc[k] = mask.totals[k] * factor; });
      return { acc, total: 180, projected: mask.trial };
    }
    const acc = {};
    plan.forEach((p) => { acc[p.phase] = (acc[p.phase] || 0) + p.min; });
    return { acc, total: plan.reduce((s, p) => s + p.min, 0), projected: false };
  }

  // 1 h 08 / 29 min — más legible que mm:ss en un reparto de fases
  const fmtDur = (min) => {
    const m = Math.round(min);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' min';
  };

  function blockCards() {
    const { acc, total, projected } = phaseMinutes();
    const cards = BLOCKS.map(([id, label]) => {
      const p = PHASES[id];
      const v = acc[id] || 0;
      return '<div class="block">' +
        '<span class="block__k">' + label + '</span>' +
        '<span class="block__v" style="color:' + p.color + '">' + fmtDur(v) + '</span>' +
        '<span class="block__s">' + Math.round(v / total * 100) + ' % de la sesión</span>' +
        '</div>';
    }).join('');
    return cards + (projected
      ? '<p class="blocks__note">Periodo de prueba: el reparto se muestra proyectado a la sesión completa de 3 h.</p>'
      : '');
  }

  /* Reparto por bloques. `RL` no es sueño: es vigilia con los ojos cerrados, y
     por eso va en su propia tarjeta para que se vea que la conciliación
     ocurre antes de que la señal pase de alpha a theta. */
  const BLOCKS = [
    ['N3', 'Onda lenta (N3)'],
    ['R', 'REM / onírico'],
    ['N2', 'N2 ligero'],
    ['N1', 'N1 · somnolencia'],
    ['RL', 'Ojos cerrados (conciliación)'],
    ['CUT', 'Corte de línea']
  ];

  /* ══════════════ PERFILES DE USUARIO ══════════════ */
  function renderProfiles() {
    const box = $('[data-profiles]');
    if (!box) return;
    box.innerHTML = PROFILES.map((p, i) =>
      '<button type="button" class="prof' + (i === profileIdx ? ' is-on' : '') + '" data-prof="' + i + '" ' +
      'aria-pressed="' + (i === profileIdx) + '">' +
        '<b>' + p.name + '</b>' +
        '<span>' + p.desc + '</span>' +
        '<em>' + p.latency + ' min de latencia' + (p.micro > 0.5 ? ' · ' + Math.round(p.micro * 4) + ' micro-despertares' : ' · duerme rápido') + '</em>' +
      '</button>'
    ).join('');
    const note = $('[data-profile-note]');
    if (note) note.textContent = profile().tip;
  }

  /* ══════════════ SUEÑOS ══════════════ */
  function emptyDreams() {
    return '<div class="empty"><span class="empty__ico">☾</span>' +
      '<p>Sin registros oníricos todavía. Inicia una sesión y aquí verás cada sueño que la máscara reconstruye.</p></div>';
  }

  /* waiting state for the report: real progress, no made-up figures. In a
     short trial the person may not fall asleep, and the wording says so
     instead of promising a score that will not exist. */
  function reportWaiting(t) {
    const pct = Math.round(t.progress * 100);
    const line = !isFinite(t.asleepAt)
      ? 'Sigues despierto: en esta persona la señal todavía no ha pasado de alpha a theta. Si al terminar el periodo sigue así, el informe lo dirá sin puntuarla.'
      : t.asleep
        ? 'Dormiste hace <b>' + fmtHM(t.elapsedAt || 0) + '</b>. Faltan ' + fmtLeft(t.leftMin) + '.'
        : 'Todavía despierto: te duermes a los <b>' + fmtHM(t.asleepAt) + '</b> según tu perfil.';
    return '<div class="waiting">' +
      '<div class="waiting__ring" style="--p:' + pct + '"><b>' + pct + '%</b><span>' + fmtClock(t.elapsedMin) + '</span></div>' +
      '<div class="waiting__body">' +
        '<h4>Informe en curso</h4>' +
        '<p>Fase actual: <b>' + t.phase.name + '</b> · banda <b>' + t.band + '</b> (' + t.bandDesc + ').</p>' +
        '<p>' + line + '</p>' +
        '<p class="waiting__note">Las métricas, la puntuación y los registros oníricos definitivos se calculan al terminar la sesión.</p>' +
      '</div>' +
    '</div>';
  }

  function dreamsHTML() {
    return dreams.map((d) => (
      '<article class="dream" data-id="' + d.id + '">' +
        '<div class="dream__top">' +
          '<span class="dream__time">' + fmtClock(d.from) + ' — ' + fmtClock(d.to) + ' · ciclo ' + d.cycle + '</span>' +
          '<span class="dream__tag">' + d.kind + '</span>' +
        '</div>' +
        '<h4 class="dream__title">' + d.title + '</h4>' +
        '<p class="dream__text">' + d.text + '</p>' +
        '<div class="dream__meta">' +
          '<span>OAI <b>' + d.oai + '</b></span>' +
          '<span>Intensidad <b>' + d.intensity + ' %</b></span>' +
          d.keywords.map((k) => '<span>' + k + '</span>').join('') +
        '</div>' +
      '</article>'
    )).join('');
  }

  /* ══════════════ REPORTE ══════════════ */
  /* Resultado de una noche en la que la persona NO llegó a dormirse: no hay
     puntuación ni cifras de sueño profundo, porque no llegaron a existir.
     Se informa de lo que sí se registró: minutos de vigilia, en qué momento
     se cerró el theta y qué queda para la siguiente vez. */
  function reportAwakeHTML(r) {
    return (
      '<div class="score score--awake">' +
        '<div class="score__ring score__ring--awake">' +
          '<svg viewBox="0 0 110 110" aria-hidden="true">' +
            '<circle class="bgc" cx="55" cy="55" r="46"/>' +
            '<circle class="fgc fgc--awake" cx="55" cy="55" r="46"/>' +
          '</svg>' +
          '<span class="score__num score__num--awake">☾</span>' +
        '</div>' +
        '<div class="score__txt">' +
          '<h3>No se durmió' + (r.trial ? ' en la prueba' : '') + '</h3>' +
          '<p>' + fmtHM(r.realMin) + ' de registro y en todo ese tiempo la señal se quedó ' +
            'en beta y alpha: ojos abiertos al principio, ojos cerrados después, ' +
            'pero sin theta, sin espigas y sin onda lenta.</p>' +
          '<p class="score__prof">Perfil: <b>' + r.profileName + '</b></p>' +
        '</div>' +
      '</div>' +
      '<div class="kpis">' +
        kpi('Tiempo real', fmtHM(r.realMin)) +
        kpi('Vigilia', fmtHM(r.awakeMin)) +
        kpi('Ojos cerrados', fmtHM(r.awakeMinProj)) +
        kpi('Onda lenta', '—') +
        kpi('REM', '—') +
        kpi('Ciclos', '—') +
      '</div>' +
      '<div class="recap">' +
        recap('Latencia', 'no alcanzado', 'warn') +
        recap('Tiempo real', fmtHM(r.realMin), 'ok') +
        recap('Sueño equivalente', '0 min', 'proj') +
        recap('Terminó en', r.wakeLabel, 'ok') +
        recap('Registros oníricos', 'ninguno', 'ok') +
      '</div>' +
      '<div class="advice"><h4>Recomendación para hoy</h4><p>' + r.advice.join(' ') + '</p></div>' +
      '<p class="disclaimer">Informe generado en este navegador a partir del perfil ' + r.profileName +
        '. No es una medida médica y no sustituye un estudio de sueño.</p>'
    );
  }

  function reportHTML(r) {
    if (!r.fellAsleep) return reportAwakeHTML(r);
    const R = 46, C = 2 * Math.PI * R;
    const off = C - (r.score / 100) * C;
    const head = r.trial
      ? 'Prueba de ' + fmtHM(r.realMin) + ' reales = ' + fmtHM(r.equivalentMin) +
        ' de sueño equivalente. El informe usa el protocolo proyectado a 3 h: ' +
        r.relaxMin + ' min de conciliación, ' + r.cutMin + ' min de corte de línea recuperado y ' +
        r.cycles + ' ciclos completos. Onda lenta ' + r.deepMin + ' min, REM ' + r.remMin +
        ' min y ' + r.spindles + ' espigas.'
      : '3 h reales de sesión para ' + fmtHM(r.equivalentMin) +
        ' de sueño equivalente: ' + r.relaxMin + ' min de conciliación, ' + r.cutMin +
        ' min de corte de línea recuperado y ' + r.cycles + ' ciclos completos. Onda lenta ' +
        r.deepMin + ' min, REM ' + r.remMin + ' min y ' + r.spindles + ' espigas.';
    return (
      '<div class="score">' +
        '<div class="score__ring">' +
          '<svg viewBox="0 0 110 110" aria-hidden="true">' +
            '<defs><linearGradient id="scoregrad" x1="0" y1="0" x2="1" y2="1">' +
              '<stop offset="0" stop-color="#35e0f0"/><stop offset="1" stop-color="#ff5ea8"/>' +
            '</linearGradient></defs>' +
            '<circle class="bgc" cx="55" cy="55" r="' + R + '"/>' +
            '<circle class="fgc" cx="55" cy="55" r="' + R + '" ' +
              'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>' +
          '</svg>' +
          '<span class="score__num">' + r.score + '</span>' +
        '</div>' +
        '<div class="score__txt">' +
          '<h3>' + verdict(r.score) + (r.trial ? ' · prueba' : '') + '</h3>' +
          '<p>' + head + '</p>' +
          '<p class="score__prof">Perfil: <b>' + r.profileName + '</b></p>' +
        '</div>' +
      '</div>' +
      '<div class="kpis">' +
        kpi('Latencia de sueño', r.latency + ' min') +
        kpi('Índice onírico', r.eff + ' %') +
        kpi('Consolidación', r.consolidation + ' %') +
        kpi('Espigas', r.spindles) +
        kpi('Corte de línea', r.cutMin + ' min') +
        kpi('Micro-despertares', r.micros) +
      '</div>' +
      '<div class="recap">' +
        recap('Te dormiste', r.latency + ' min', r.latency <= 15 ? 'ok' : 'warn') +
        recap('Tiempo real', fmtHM(r.realMin), 'ok') +
        recap('Sueño equivalente', fmtHM(r.equivalentMin), 'proj') +
        recap('Despertaste en', r.wakeLabel, 'ok') +
        recap('Último sueño', r.lastDream ? 'ciclo ' + r.lastDream.cycle : '—', 'ok') +
      '</div>' +
      '<div class="advice"><h4>Recomendación para hoy</h4><p>' + r.advice.join(' ') + '</p></div>' +
      '<p class="disclaimer">Informe generado en este navegador a partir del perfil ' + r.profileName +
        '. No es una medida médica y no sustituye un estudio de sueño.</p>'
    );
  }

  const recap = (k, v, cls) =>
    '<div class="recap__i recap__i--' + cls + '"><span>' + k + '</span><b>' + v + '</b></div>';

  const kpi = (k, v) => '<div class="kpi"><span class="kpi__v">' + v + '</span><span class="kpi__k">' + k + '</span></div>';

  const verdict = (s) =>
    s >= 90 ? 'Sesión excepcional' :
    s >= 78 ? 'Consolidación completa' :
    s >= 65 ? 'Sesión correcta' :
    s >= 50 ? 'Sesión irregular' : 'Sesión fallida';

  /* ══════════════ SESIÓN ══════════════ */
  /* Arranca una sesión. En un periodo de PRUEBA no está garantizado que la
     persona llegue a dormirse: se decide con `willSleep()` y, si no se duerme,
     la noche termina en vigilia con los ojos cerrados y sin ciclos, tal como
     ocurre en la sesión real. Al retomar una sesión guardada se reutiliza el
     plan y la hora de inicio ya calculados. */
  function startSession(opts) {
    const o = opts || {};
    if (!o.resume && mask.state !== 'linked') return;

    const m = o.resume && memory.state.totalMin
      ? SESSION_MODES.find((x) => x.minutes === memory.state.totalMin) || mode()
      : mode();

    if (!o.resume) {
      dreams.length = 0;
      hypBuf.length = 0;
      history.length = 0;
      mask.totals = null;
    }
    sessTotal = m.minutes;
    lastHypMin = -1;
    lastHypPhase = null;
    reportTick = 0;
    $('[data-blocks]').innerHTML = '';
    $('[data-report]').innerHTML = '<div class="empty"><span class="empty__ico">◷</span>' +
      '<p>Sesión en curso a tiempo real. El informe se genera al terminar ' +
      (m.trial ? 'los ' + m.short + ' del periodo de prueba.' : 'las 3 horas.') + '</p></div>';
    $('[data-dreams]').innerHTML = '<div class="empty"><span class="empty__ico">☾</span>' +
      '<p>Grabando registros oníricos… Cada ciclo REM aparece aquí en cuanto termina.</p></div>';
    switchTab('live');

    setStatus('live', 'Sesión activa · ' + fmtLeft(m.minutes));
    btnSess.textContent = 'Detener sesión';
    btnSess.disabled = false;
    eegOn = true;
    cutLeft = 0;
    eegBox.classList.remove('is-cut');
    waveFn = null;
    waveNow = 0;
    waveAmp = 0.5;
    waveFreq = 6;

    // La noche que se va a seguir: la guardada si se retoma, y si no, una
    // nueva en la que se decide si la persona llega a dormirse.
    const asleep = o.resume ? memory.state.asleep : willSleep(m.minutes, m.trial, profile());
    /* El plan se calcula AQUÍ, no dentro de MaskLink.start, para que el primer
       guardado de la sesión ya lo incluya: si se calculara allí, persist()
       correría antes y guardaría plan=null, y una pestaña cerrada en los
       primeros segundos dejaría una noche sin plan y sin poder reanudarse.
       Al reanudar se reutiliza el ya guardado, sin volver a tirarlo. */
    const plan = o.resume && memory.state.plan
      ? memory.state.plan
      : buildPlan(m.minutes, profile(), asleep);

    /* El reloj de pared de ESTA sesión. Al reanudar se conserva el del
       principio, para que el tiempo con la pestaña cerrada también cuente.
       Se calcula una vez y lo usan tanto mask.start() como persist(), porque
       mask.startedAt aquí todavía es el de la sesión anterior. */
    const startedAt = o.resume && memory.state.startedAt ? memory.state.startedAt : Date.now();

    // la memoria guarda un plan limpio (sin funciones ni referencias)
    function persist(extra) {
      const st = memory.state;
      st.seed = mask.seed;
      st.linked = true;
      st.pin = mask.pin || st.pin;
      st.profileIdx = profileIdx;
      st.modeIdx = modeIdx;
      st.live = true;
      st.startedAt = startedAt;
      st.totalMin = m.minutes;
      st.trial = m.trial;
      st.asleep = asleep;
      /* El plan se guarda YA calculado, no el que lleva el DeviceLink: esta
         función corre antes de mask.start(), así que `mask.plan` todavía es el
         de la noche anterior y se guardaría una noche que no es la actual. */
      st.plan = plan;
      st.totals = mask.totals || null;
      st.asleepAt = isFinite(mask.asleepAt) ? mask.asleepAt : 0;
      /* Tampoco `mask.fellAsleep`: todavía no se ha calculado. Se deduce del
         plan, que ya está: si no tiene tramo "nowake", la persona duerme. */
      st.fellAsleep = !!plan && !plan.some((p) => p.block === 'nowake');
      st.hypBuf = hypBuf.slice();
      st.dreams = dreams.slice();
      st.telemetry = lastTelemetry;
      st.lastDream = lastDreamRef;
      if (extra) Object.assign(st, extra);
      memory.write();
    }

    const tick = (t) => {
      lastTelemetry = { hr: t.hr, hrv: t.hrv, spo2: t.spo2, temp: t.temp };
      // corte de línea: los gauges se vacían y el EEG se aplana
      if (t.signalCut) {
        cutLeft = t.segTotalMin * (1 - t.segLocal);
        eegBox.classList.add('is-cut');
        setLive('phase', 'Corte de línea');
        setLive('band', '— · señal cortada');
        setLive('hr', '—');
        setLive('hrv', '—');
        setLive('spo2', '—');
        setLive('temp', '—');
      } else {
        cutLeft = 0;
        eegBox.classList.remove('is-cut');
        setLive('phase', t.phase.name);
        setLive('band', t.band + ' · ' + t.bandDesc);
        setLive('hr', Math.round(t.hr) + ' bpm');
        setLive('hrv', Math.round(t.hrv) + ' ms');
        setLive('spo2', Math.round(t.spo2) + ' %');
        setLive('temp', t.temp.toFixed(1) + ' °C');
      }
      setLive('left', fmtLeft(t.leftMin));
      setLive('wake', 'en ' + fmtLeft(t.leftMin));
      setLive('sleep', t.asleep
        ? fmtHM(t.asleepProj) + ' dormido'
        : 'despierto · ' + fmtHM(t.asleepAtProj - (t.elapsedMin * (180 / t.totalMin))) + ' para dormir');

      /* The hypnogram is stored with sampling (phase change or every 15 s of
         session): in a real 3 h session there are thousands of frames and it
         cannot store one per tick. */
      const bucket = Math.floor(t.elapsedMin * 4);
      let newSample = false;
      if (t.phase.id !== lastHypPhase || bucket !== lastHypMin) {
        lastHypPhase = t.phase.id;
        lastHypMin = bucket;
        history.push({ min: t.elapsedMin, phase: t.phase.id, label: t.segment.label });
        hypBuf.push({ min: t.elapsedMin, phaseId: t.phase.id });
        if (fasesPane.classList.contains('is-on')) drawHypno();
        newSample = true;
      }
      batBar.style.setProperty('--lvl', Math.max(6, t.battery - (t.progress * 34)) + '%');
      batTxt.textContent = Math.max(6, Math.round(t.battery - t.progress * 34)) + ' %';

      // informe: solo progreso y estado real mientras dura la sesión
      if (reportTick++ % 10 === 0) {
        $('[data-report]').innerHTML = reportWaiting({
          progress: t.progress, elapsedMin: t.elapsedMin, leftMin: t.leftMin,
          phase: t.phase, band: t.band, bandDesc: t.bandDesc,
          asleep: t.asleep, asleepAt: t.asleepAtProj,
          elapsedAt: t.asleepProj
        });
      }

      /* The canvas draws the signal evaluating waveFn on every pixel: it is
         enough to advance the clock of the visible window and repaint. */
      waveFn = t.waveFn;
      waveNow = t.elapsedMin * 60;
      waveAmp = t.waveAmp;
      waveFreq = t.waveFreq;
      lastHypPhase = t.phase.id;
      if (livePane.classList.contains('is-on')) drawEEG();

      // guardado: en cada muestra del hipnograma, y como mucho una vez cada
      // 15 s aunque la fase no cambie, para no escribir en disco cada frame
      const now = Date.now();
      if (newSample || now - lastSaveAt > 15000) {
        lastSaveAt = now;
        persist();
      }
    };

    persist();
    mask.start(tick,
      (d) => {
        dreams.push(d);
        lastDreamRef = d;
        $('[data-dreams]').innerHTML = dreamsHTML();
        persist();
      },
      (report) => {
        eegOn = false;
        waveFn = null;          // vuelve a la señal de fondo, ya no hay sesión
        cutLeft = 0;
        eegBox.classList.remove('is-cut');
        /* Al acabar, la máscara sigue vinculada: vuelve a 'linked' para que
           el botón "Repetir" pueda arrancar otra noche. Si se quedara en
           'done', startSession() la rechazaría y el botón no haría nada. */
        mask.state = 'linked';
        setStatus('linked', 'Sesión completada · ' + report.profileName);
        btnSess.textContent = m.trial ? 'Repetir prueba de ' + m.short : 'Iniciar sesión de 3 h';
        setLive('phase', report.fellAsleep ? 'Despertar limpio' : 'Sigue despierto');
        setLive('band', report.fellAsleep ? 'Alpha · despertar' : 'Beta / alpha · sin llegar a dormir');
        setLive('left', '00:00');
        setLive('wake', 'ahora');
        setLive('sleep', report.fellAsleep
          ? fmtHM(report.asleepMin) + ' dormido'
          : 'no se durmió · ' + fmtHM(report.awakeMin) + ' despierto');
        $('[data-blocks]').innerHTML = blockCards();
        drawHypno();
        $('[data-report]').innerHTML = reportHTML(report);
        if (!dreams.length) $('[data-dreams]').innerHTML = emptyDreams();
        persist({ live: false, report, startedAt: 0 });
        memory.write();
        setTimeout(() => switchTab('reporte'), 400);
      },
      {
        minutes: m.minutes, trial: m.trial, profile: profile(),
        asleep, plan, startedAt,
        telemetry: o.resume ? memory.state.telemetry : null,
        lastDream: o.resume ? memory.state.lastDream : null
      });
  }

  /* ══════════════ REANUDAR ══════════════
     Una sesión se guarda en este navegador mientras corre. Al recargar la
     página, si la sesión seguía viva y no ha caducado, se puede continuar
     desde el minuto exacto en que estaba: el tiempo con la pestaña cerrada
     también cuenta, porque la señal avanza contra el reloj de pared.        */
  let resumeOffered = false;

  function sessionElapsed() {
    if (!memory.state.startedAt || !memory.state.totalMin) return 0;
    return (Date.now() - memory.state.startedAt) / 60000;
  }

  function canResume() {
    const st = memory.state;
    if (!st.live || !st.startedAt || !st.plan) return false;
    return sessionElapsed() < st.totalMin;
  }

  function offerResume() {
    resumeOffered = true;
    const st = memory.state;
    const left = Math.max(0, st.totalMin - sessionElapsed());
    const m = SESSION_MODES.find((x) => x.minutes === st.totalMin);
    const tag = m ? (m.trial ? 'Prueba de ' + m.short : 'Sesión de 3 h') : 'Sesión';
    const banner = document.createElement('div');
    banner.className = 'resume';
    banner.innerHTML =
      '<p><b>Sesión guardada en este navegador.</b> ' + tag + ' en curso: ' +
        fmtClock(sessionElapsed()) + ' de ' + fmtClock(st.totalMin) + ' · quedan ' +
        fmtLeft(left) + '.</p>' +
      '<div class="resume__acts">' +
        '<button type="button" class="btn btn--ghost" data-resume="no">Empezar de cero</button>' +
        '<button type="button" class="btn" data-resume="yes">Retomar donde estaba</button>' +
      '</div>';
    const host = statusBox.parentNode;
    host.appendChild(banner);

    const done = () => { banner.remove(); };
    banner.querySelector('[data-resume="no"]').addEventListener('click', () => {
      memory.state.live = false;
      memory.state.startedAt = 0;
      memory.write();
      done();
      startSession();
    });
    banner.querySelector('[data-resume="yes"]').addEventListener('click', () => {
      done();
      startSession({ resume: true });
    });
  }

  /* ══════════════ TABS ══════════════ */
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === name));
    $$('.pane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === name));
    if (name === 'fases') requestAnimationFrame(drawHypno);
    if (name === 'live') requestAnimationFrame(() => drawEEG());
  }

  /* ══════════════ LOOP DE RENDER ══════════════ */
  function idleLoop() {
    // señal de fondo cuando no hay sesión: el sensor parece "respirar"
    if (!eegOn) {
      waveNow = performance.now() / 1000;
      waveFreq = 6; waveAmp = 0.5;
      if (!document.hidden && livePane.classList.contains('is-on')) drawEEG();
    }
    requestAnimationFrame(idleLoop);
  }

  /* ══════════════ INIT ══════════════ */
  function init() {
    btnScan.addEventListener('click', () => {
      if (mask.state === 'linked') disconnect();
      else scan();
    });

    btnSess.addEventListener('click', () => {
      if (mask.state === 'live') {
        mask.stop();
        eegOn = false;
        cutLeft = 0;
        setStatus('linked', 'Sesión detenida');
        applyMode();
        return;
      }
      // si había una sesión a medias en este navegador, se ofrece retomarla
      if (canResume() && !resumeOffered) {
        offerResume();
        return;
      }
      startSession();
    });

    pairForm.addEventListener('submit', submitPin);
    pairInput.addEventListener('input', () => {
      pairInput.value = pairInput.value.replace(/\D/g, '').slice(0, 6);
      if (!pairErr.hidden) pairErr.hidden = true;
    });
    $('[data-pair-cancel]').addEventListener('click', closePair);
    pairEl.addEventListener('click', (e) => { if (e.target === pairEl) closePair(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pairEl.hidden) closePair();
    });

    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    btnSpeed.addEventListener('click', () => {
      if (mask.state === 'live') return;
      cycleSpeed();
    });
    applyMode();

    // selector de perfil
    $('[data-profiles]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-prof]');
      if (!b || mask.state === 'live') return;
      setProfile(+b.dataset.prof);
    });
    renderProfiles();

    // abrir el panel desde cualquier CTA
    $$('[data-open-panel]').forEach((el) => el.addEventListener('click', () => {
      setTimeout(() => {
        $$('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === 'live'));
        requestAnimationFrame(() => drawEEG());
      }, 350);
    }));

    /* ---------- zoom y desplazamiento ---------- */
    bindZoom('eeg', eeg, drawEEG);
    bindZoom('hyp', hyp, drawHypno);
    $$('[data-zoom-in]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.zoomIn;
      setZoom(k, VIEWS[k].zoom * 1.5);
      k === 'eeg' ? drawEEG() : drawHypno();
    }));
    $$('[data-zoom-out]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.zoomOut;
      setZoom(k, VIEWS[k].zoom / 1.5);
      k === 'eeg' ? drawEEG() : drawHypno();
    }));
    $$('[data-zoom-reset]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.zoomReset;
      resetView(k);
      k === 'eeg' ? drawEEG() : drawHypno();
    }));
    syncZoomBar('eeg');
    syncZoomBar('hyp');

    window.addEventListener('resize', () => { drawEEG(); drawHypno(); });

    batBar.style.setProperty('--lvl', mask.battery + '%');
    batTxt.textContent = mask.battery + ' %';
    $('[data-dev="name"]').textContent = mask.name;
    $('[data-dev="mac"]').textContent = mask.mac;
    setLive('phase', '—');
    setLive('band', '—');

    /* Lo que quedó guardado en este navegador manda: el perfil y el periodo
       elegidos, y si había una noche en curso o un informe ya terminado. */
    if (memory.state.profileIdx !== profileIdx) setProfile(memory.state.profileIdx);
    if (memory.state.modeIdx !== modeIdx) setMode(memory.state.modeIdx);

    /* Si la noche anterior llegó a vincularse, el enlace sigue en pie al
       recargar: la máscara vuelve a estar vinculada con la misma semilla y el
       botón de sesión se habilita. Si no, el usuario tiene que volver a
       emparejarla desde cero. */
    if (memory.state.linked) {
      mask.state = 'linked';
      btnScan.textContent = 'Desconectar';
      btnSess.disabled = false;
      btnSess.textContent = mode().trial
        ? 'Iniciar prueba de ' + mode().short : 'Iniciar sesión de 3 h';
      setStatus('linked', 'Conectada');
      if (!canResume()) hintBox.textContent = linkedHint();
    }

    if (memory.state.report) {
      seedHistory({
        plan: memory.state.plan, dreams: memory.state.dreams,
        hypBuf: memory.state.hypBuf, totalMin: memory.state.totalMin,
        trial: memory.state.trial, asleepAt: memory.state.asleepAt,
        fellAsleep: memory.state.fellAsleep
      });
      $('[data-report]').innerHTML = reportHTML(memory.state.report);
    } else if (canResume()) {
      // la noche sigue viva: se muestra lo registrado hasta donde se quedó
      seedHistory({
        plan: memory.state.plan, dreams: memory.state.dreams,
        hypBuf: memory.state.hypBuf, totalMin: memory.state.totalMin,
        trial: memory.state.trial, asleepAt: memory.state.asleepAt,
        fellAsleep: memory.state.fellAsleep
      });
      const done = Math.min(sessionElapsed(), memory.state.totalMin);
      setStatus('linked', 'Sesión guardada · ' + fmtClock(done));
      hintBox.textContent = 'Quedó una sesión a medias en este navegador, con ' +
        fmtClock(done) + ' registrados. Pulsa iniciar para retomarla o empezar de cero.';
      $('[data-report]').innerHTML = reportWaiting({
        progress: memory.state.totalMin ? done / memory.state.totalMin : 0,
        elapsedMin: done,
        leftMin: Math.max(0, memory.state.totalMin - done),
        phase: PHASES.W, band: '—', bandDesc: 'en pausa',
        asleep: false, asleepAt: NaN, elapsedAt: 0
      });
    } else if (memory.state.hypBuf.length) {
      // una noche anterior ya cerrada
      seedHistory({
        plan: memory.state.plan, dreams: memory.state.dreams,
        hypBuf: memory.state.hypBuf, totalMin: memory.state.totalMin,
        trial: memory.state.trial, asleepAt: memory.state.asleepAt,
        fellAsleep: memory.state.fellAsleep
      });
    }

    drawEEG();
    idleLoop();
  }

  document.addEventListener('DOMContentLoaded', init);
  global.NEBULA_UI = {
    switchTab, scan, submitPin, startSession, applyMode, cycleSpeed, setMode, dreams, mask,
    get modes() { return SESSION_MODES; },
    get modeIdx() { return modeIdx; },
    get profiles() { return PROFILES; },
    get profileIdx() { return profileIdx; },
    setProfile, seedHistory, profile,
    renderProfiles, reportHTML, drawHypno, drawEEG, blockCards, syncNote,
    // memoria de la noche
    get memory() { return memory.state; },
    memoryRead: memory.read, memoryWrite: memory.write, memoryClear: memory.clear,
    canResume, sessionElapsed, offerResume,
    // zoom
    get views() { return VIEWS; },
    setZoom, panTo, resetView, viewRange, viewSpan, tickStep,
    get hypBuf() { return hypBuf; },
    // para pruebas: la función de onda viva y el reloj de la ventana
    get wave() { return waveFn; },
    get waveNow() { return waveNow; },
    get waveRange() { return viewRange('eeg'); },
    sample: (sec, ch) => (waveFn ? waveFn(sec, ch || 0) : idleWave(sec, ch || 0))
  };
})(window);
