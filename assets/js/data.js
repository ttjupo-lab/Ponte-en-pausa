/* ══════════════════════════════════════════════
   PONTE EN PAUSA · data.js
   Modelo de datos del dispositivo y del sueño
   ══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ---------- utilidades ---------- */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ruido 1D suave (value noise) para señales creíbles.
     Va con SEMILLA: cada canal tiene la suya (derivaciones distintas) y la
     misma semilla reproduce exactamente la misma señal al recargar la página
     o al retomar una sesión guardada. */
  function makeNoise(seed) {
    let s = ((((seed | 0) ^ 0x9e3779b9) >>> 0) || 0x2545f491);
    const rs = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const table = new Float32Array(256);
    for (let i = 0; i < 256; i++) table[i] = rs() * 2 - 1;
    const off = Math.floor(rs() * 256);
    return (x) => {
      const i = Math.floor(x);
      const f = x - i;
      const s = f * f * (3 - 2 * f);
      const a = table[(i + off) & 255];
      const b = table[(i + 1 + off) & 255];
      return lerp(a, b, s);
    };
  }

  /* Ruido blanco pseudoaleatorio y determinista: base de la banda Beta, que
     a diferencia del value noise cambia en cada muestra (20–30 Hz). */
  function whiteNoise(x) {
    const i = Math.sin(x * 12.9898) * 43758.5453;
    return (i - Math.floor(i)) * 2 - 1;
  }

  /* ══════════════════════════════════════════════════════════
     Profundidad cerebral continua
     ─────────────────────────────────────────────────────────
     Un EEG real no salta de un estado al siguiente: hay una
     pendiente. Cuando alguien cierra los ojos aparece alpha, el
     alpha se atenúa, aparece theta, más tarde sigma con espigas
     y por último delta. Al despertar el camino se recorre al
     revés: theta, alpha y otra vez beta.

     Por eso el estado se modela como un número continuo
     `lvl` y la señal se obtiene mezclando las dos plantillas
     que lo rodean. Así se puede VER a la persona conciliando el
     sueño y también despertándose, en lugar de un salto.

       0     ojos abiertos, despierto        beta
       0.5   ojos cerrados, relajado         alpha
       1     N1, somnolencia                 theta
       2     N2, ligero                      sigma + espigas
       3     N3, profundo                    delta
     El REM es una rama aparte (theta bajo + movimiento ocular).
     ══════════════════════════════════════════════════════════ */

  /* Cada plantilla describe QUÉ se ve en ese estado:
       freq    portadora principal
       amp     amplitud global (calibrada contra el alto de fila)
       noise   ruido de fondo
       beta    "pelusa" de beta: marca la diferencia entre un
               perfil relajado y uno estresado
       alpha   ritmo alpha de ojos cerrados
       emg     artefacto muscular: solo con los ojos abiertos
       spindle espigas de sueño de 13 Hz
       saw     dientes de sierra del REM
       dom     ritmo dominante, para elegir la ventana del lienzo  */
  const WAVE = {
    awake: { band: 'Beta',  dom: 11.5, freq: 11.5, amp: 0.30, noise: 0.55, beta: 1.00, alpha: 0.22, emg: 0.60, spindle: 0, saw: 0 },
    relax: { band: 'Alpha', dom:  9.6, freq:  9.6, amp: 0.52, noise: 0.24, beta: 0.30, alpha: 0.15, emg: 0.06, spindle: 0, saw: 0 },
    n1:    { band: 'Theta', dom:  6.4, freq:  6.4, amp: 0.42, noise: 0.30, beta: 0.18, alpha: 0.30, emg: 0.02, spindle: 0, saw: 0 },
    n2:    { band: 'Sigma', dom:  4.6, freq:  4.6, amp: 0.34, noise: 0.22, beta: 0.12, alpha: 0.04, emg: 0.01, spindle: 1, saw: 0 },
    n3:    { band: 'Delta', dom:  1.05,freq:  1.05,amp: 0.62, noise: 0.10, beta: 0.05, alpha: 0.02, emg: 0,    spindle: 0, saw: 0 },
    rem:   { band: 'Theta', dom:  6.1, freq:  6.1, amp: 0.24, noise: 0.20, beta: 0.12, alpha: 0.12, emg: 0.02, spindle: 0, saw: 0.45 },
    cut:   { band: '—',     dom:  1.5, freq:  1.5, amp: 0.00, noise: 0.00, beta: 0,    alpha: 0,    emg: 0,    spindle: 0, saw: 0 }
  };

  /* Profundidad a la que vive cada plantilla */
  const LVL = { awake: 0, relax: 0.5, n1: 1, n2: 2, n3: 3, rem: 1.6, cut: 2.6 };

  /* Mezcla lineal entre dos plantillas. Mezclar los parámetros (y no las
     señales) mantiene la traza legible: no aparecen batidos ni espurias
     que hide la banda que define cada fase.
     Solo se interpolan los campos numéricos: `band` es una etiqueta de texto
     y se queda con la plantilla que domina, para que la cabecera siga
     nombrando una banda real y no un NaN. */
  function mixWave(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    const o = {};
    const num = (a.band === undefined || b.band === undefined);
    for (const k in a) {
      if (!num && k === 'band') { o[k] = t < 0.5 ? a[k] : b[k]; continue; }
      o[k] = lerp(a[k], b[k], t);
    }
    return o;
  }

  /* Orden canónico de plantillas a lo largo de la escala de profundidad */
  const LADDER = [
    { lvl: 0,    w: WAVE.awake },
    { lvl: 0.5,  w: WAVE.relax },
    { lvl: 1,    w: WAVE.n1 },
    { lvl: 1.6,  w: WAVE.rem },
    { lvl: 2,    w: WAVE.n2 },
    { lvl: 3,    w: WAVE.n3 }
  ];

  /* Plantilla mixta para una profundidad continua cualquiera. */
  function waveAt(lvl, cut) {
    if (cut) return WAVE.cut;
    if (lvl <= 0) return WAVE.awake;
    if (lvl >= 3) return WAVE.n3;
    for (let i = 0; i < LADDER.length - 1; i++) {
      const a = LADDER[i], b = LADDER[i + 1];
      if (lvl <= b.lvl) {
        return mixWave(a.w, b.w, (lvl - a.lvl) / (b.lvl - a.lvl));
      }
    }
    return WAVE.n3;
  }

  /* ---------- fases de sueño ----------
     `awake` distingue a la persona que sigue despierta de la que ya
     se durmió: es lo que decide si los gráficos muestran beta con
     ojos abiertos o alpha con los ojos cerrados.                    */
  const PHASES = {
    W:   { id: 'W',   name: 'Despertar',          short: 'Desp.', color: '#4a5aa8', depth: 0,  awake: true },
    RL:  { id: 'RL',  name: 'Ojos cerrados',      short: 'Rel.',  color: '#6f7fd8', depth: 0,  awake: true },
    R:   { id: 'R',   name: 'REM',                short: 'REM',   color: '#ff5ea8', depth: 3,  awake: false },
    N1:  { id: 'N1',  name: 'N1 · somnolencia',   short: 'N1',    color: '#2f6f8f', depth: 1,  awake: false },
    N2:  { id: 'N2',  name: 'N2 · ligero',       short: 'N2',    color: '#35e0f0', depth: 2,  awake: false },
    N3:  { id: 'N3',  name: 'N3 · profundo',     short: 'N3',    color: '#7c5cff', depth: 4,  awake: false },
    CUT: { id: 'CUT', name: 'Corte de línea',    short: 'Corte', color: '#ff5c5c', depth: 0,  awake: true }
  };

  const BANDS = {
    W:   { band: 'Beta',  desc: 'alerta' },
    RL:  { band: 'Alpha', desc: 'relajado' },
    R:   { band: 'Theta', desc: 'onírico' },
    N1:  { band: 'Theta', desc: 'transición' },
    N2:  { band: 'Sigma', desc: 'spindles' },
    N3:  { band: 'Delta', desc: 'onda lenta' },
    CUT: { band: '—',     desc: 'señal cortada' }
  };

  /* ---------- parámetros fisiológicos por estado ---------- */
  const PHY = {
    W:   { hr: [66, 74], hrv: [44, 58], spo2: [96, 98], temp: [33.6, 34.0] },
    RL:  { hr: [62, 70], hrv: [50, 64], spo2: [96, 98], temp: [33.5, 33.9] },
    N1:  { hr: [60, 68], hrv: [56, 70], spo2: [97, 98], temp: [33.4, 33.8] },
    N2:  { hr: [55, 62], hrv: [66, 82], spo2: [97, 99], temp: [33.2, 33.6] },
    N3:  { hr: [48, 55], hrv: [84, 104], spo2: [98, 99], temp: [32.9, 33.3] },
    R:   { hr: [54, 62], hrv: [58, 74], spo2: [97, 99], temp: [33.2, 33.7] },
    CUT: { hr: [52, 60], hrv: [30, 52], spo2: [95, 98], temp: [33.4, 33.9] }
  };

  /* ---------- línea de tiempo de una sesión de 180 min ----------
     Cada segmento lleva su pendiente `lvl: [desde, hasta]` en la escala
     de profundidad, y de ahí sale la mezcla de bandas. Los tramos con
     pendiente distinta de [x, x] son los que se "veen":

       W  [0, 0]     ojos abiertos, todavía despierta
       RL [0.5, 0.85] cierra los ojos: beta → alpha, sin llegar a dormir
       N2 [2, 2]     ya duerme
       cola N1 [1,1] → RL [1, 0.5] → W [0.5, 0]   el despertar

     Suma exacta: 180 min                                            */
  const SESSION_PLAN = [
    { phase: 'RL',  label: 'Conciliación',            min: 20, block: 'relax', fixed: true, lvl: [0.5, 0.85] },
    { phase: 'CUT', label: 'Corte de línea',           min: 15, block: 'cut',   fixed: true, lvl: [2, 2] },

    { phase: 'N2',  label: 'Descenso 1',              min: 5,  lvl: [2, 2] },
    { phase: 'N3',  label: 'Ciclo 1 · N3',            min: 15, lvl: [3, 3] },
    { phase: 'N2',  label: 'Ascenso 1',               min: 3,  lvl: [2, 2] },
    { phase: 'R',   label: 'Ciclo 1 · REM',           min: 9,  lvl: [1.6, 1.6], rem: true },
    { phase: 'N2',  label: 'Descenso 2',              min: 4,  lvl: [2, 2] },
    { phase: 'N3',  label: 'Ciclo 2 · N3',            min: 18, lvl: [3, 3] },
    { phase: 'N2',  label: 'Ascenso 2',               min: 3,  lvl: [2, 2] },
    { phase: 'R',   label: 'Ciclo 2 · REM',           min: 10, lvl: [1.6, 1.6], rem: true },
    { phase: 'N2',  label: 'Descenso 3',              min: 4,  lvl: [2, 2] },
    { phase: 'N3',  label: 'Ciclo 3 · N3',            min: 19, lvl: [3, 3] },
    { phase: 'N2',  label: 'Ascenso 3',               min: 3,  lvl: [2, 2] },
    { phase: 'R',   label: 'Ciclo 3 · REM',           min: 11, lvl: [1.6, 1.6], rem: true },
    { phase: 'N2',  label: 'Descenso 4',              min: 4,  lvl: [2, 2] },
    { phase: 'N3',  label: 'Ciclo 4 · N3',            min: 16, lvl: [3, 3] },
    { phase: 'N2',  label: 'Ascenso 4',               min: 3,  lvl: [2, 2] },
    { phase: 'R',   label: 'Ciclo 4 · REM',           min: 8,  lvl: [1.6, 1.6], rem: true },

    { phase: 'N1',  label: 'Salida de N3',            min: 4,  lvl: [1, 1] },
    { phase: 'RL',  label: 'Vuelve alpha',            min: 3,  lvl: [1, 0.5] },
    { phase: 'W',   label: 'Despierta',               min: 3,  lvl: [0.5, 0] }
  ];

  const CUT_MIN = 15;

  /* ---------- periodos de sesión ----------
     Todo corre a TIEMPO REAL: 1 segundo de reloj = 1 segundo de sesión.
     No hay multiplicador de velocidad. Los periodos de prueba son el mismo
     protocolo (conciliación, corte, 4 ciclos) comprimido a escala.        */
  const SESSION_MODES = [
    { id: 'p1',  label: 'Prueba',       short: '1 min', minutes: 1,   trial: true },
    { id: 'p3',  label: 'Prueba',       short: '3 min', minutes: 3,   trial: true },
    { id: 'p5',  label: 'Prueba',       short: '5 min', minutes: 5,   trial: true },
    { id: 'r3h', label: 'Sesión real',  short: '3 h',   minutes: 180, trial: false }
  ];
  const COMPRESSION = 10 / 3;   // la equivalencia que promete la landing

  /* ---------- perfiles de usuario ----------
     Cambian la latencia, los micro-despertares, la forma del EEG, la
     telemetría, los sueños y el informe final.                            */
  const PROFILES = [
    {
      id: 'estudiante',
      name: 'Estudiante estresado',
      short: 'Estudiante',
      desc: 'Exámenes encima, cabeza encendida al acostarse',
      latency: 9, micro: 0.85,
      themes: { examen: 0.5, practico: 0.25, narrativo: 0.2, neutro: 0.05 },
      oai: [0.45, 0.95], intensity: [42, 98],
      hrBias: 7, hrvBias: -10,
      eeg: { amp: 1.1, noise: 1.3, beta: 0.75, emg: 1.2 },
      tip: 'Te duermes tarde y con la cabeza encendida: por eso el primer tramo de la sesión se lo comen los nervios. Con 9 min de latencia, la onda lenta te cuesta más.'
    },
    {
      id: 'creativo',
      name: 'Creativo con sueños vívidos',
      short: 'Creativo',
      desc: 'Se duerme rápido pero con un REM muy intenso',
      latency: 4, micro: 0.15,
      themes: { narrativo: 0.5, examen: 0.15, practico: 0.15, neutro: 0.2 },
      oai: [0.62, 0.99], intensity: [58, 100],
      hrBias: 2, hrvBias: 4,
      eeg: { amp: 1.2, noise: 0.95, beta: 0.4, emg: 0.7 },
      tip: 'Duermes en pocos minutos y el REM te da más señal onírica que a la media. Con el registro bien poblado puedes buscar patrones entre noches.'
    },
    {
      id: 'atleta',
      name: 'Atleta',
      short: 'Atleta',
      desc: 'Se duerme rápido y carga casi toda la onda lenta',
      latency: 3, micro: 0.1,
      themes: { practico: 0.5, neutro: 0.3, narrativo: 0.15, examen: 0.05 },
      oai: [0.3, 0.7], intensity: [18, 62],
      hrBias: -6, hrvBias: 12,
      eeg: { amp: 1.3, noise: 0.8, beta: 0.3, emg: 0.55 },
      tip: 'La recuperación es tu prioridad y el perfil lo confirma: entras en N3 rápido y sales de ahí con la reserva intacta. Cuida la hora de la siesta, no la de la noche.'
    },
    {
      id: 'turno',
      name: 'Trabajador de turnos',
      short: 'Turnos',
      desc: 'Se duerme a destiempo y con muchos despertares',
      latency: 21, micro: 1,
      themes: { neutro: 0.4, practico: 0.3, examen: 0.2, narrativo: 0.1 },
      oai: [0.25, 0.6], intensity: [15, 55],
      hrBias: 4, hrvBias: -4,
      eeg: { amp: 0.95, noise: 1.15, beta: 0.6, emg: 1.0 },
      tip: 'Dormir de día rompe el ritmo circadiano: la latencia se dispara y aparecen micro-despertares. La sesión de 3 h sirve, pero mantenela siempre a la misma hora.'
    }
  ];

  const pickWeighted = (weights) => {
    let r = Math.random();
    for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
    return Object.keys(weights)[0];
  };

  /* ¿La persona llega a dormirse dentro del periodo?
     En una prueba corta no está garantizado: te tumbas, cierras los ojos y
     puede que la cabeza siga encendida los cinco minutos. La sesión real de
     3 h es el protocolo completo y sí duerme.
     Cuanto más largo el periodo, más probable es que se duerma, y un perfil
     de latencia alta lo tiene más difícil aunque el periodo sea el mismo. */
  function willSleep(minutes, trial, profile) {
    if (!trial) return true;
    const prof = profile || PROFILES[0];
    const lat = prof.latency || 0;
    if (lat <= 0) return true;
    // la latencia del perfil, escalada al periodo, marca el suelo: si ni
    // siquiera cabe el tiempo de conciliar, no hay sueño posible
    const need = lat * (minutes / 180);
    if (need >= minutes) return false;
    const chance = clamp(0.22 + minutes * 0.12 - (need / minutes) * 0.6, 0.15, 0.9);
    return Math.random() < chance;
  }

  /* Construye el plan de la sesión. Siempre suma EXACTAMENTE totalMin.
        asleep = false  → solo vigilia + conciliación, sin ciclos ni sueños
        asleep = true   → latencia, conciliación, corte, 4 ciclos y despertar */
  function buildPlan(totalMin, profile, asleep) {
    const prof = profile || PROFILES[0];
    const doSleep = asleep !== false;
    const base = SESSION_PLAN.reduce((s, x) => s + x.min, 0);
    const scale = totalMin / base;

    // la latencia es tiempo real despierto: al menos el 5 % del periodo,
    // para que siga siendo visible en las pruebas de 1 y 3 min
    const latency = Math.max((prof.latency || 0) * scale, totalMin * 0.05);

    /* Sin dormir: ojos abiertos un rato, luego ojos cerrados y songsueando
       hasta el final. Ni corte de línea ni ciclos, porque no hay nada que
       comprimir: la máquina estuvo despierta todo el tiempo. */
    if (!doSleep) {
      return [
        { phase: 'W',  label: 'Latencia de sueño', block: 'latency', lvl: [0, 0],     min: latency },
        { phase: 'RL', label: 'No llegó a dormirse', block: 'nowake', lvl: [0.5, 0.8], min: totalMin - latency }
      ];
    }

    const relax = SESSION_PLAN[0].min * scale;
    const cut = SESSION_PLAN[1].min * scale;

    // micro-despertares: nunca más cortos que el 0,8 % del periodo, para que
    // en un periodo de prueba sigan siendo visibles
    const microMin = Math.max(totalMin * 0.008, 0.6 * scale);
    const micros = [];
    const nMicro = Math.round((prof.micro || 0) * 4);
    for (let i = 0; i < nMicro; i++) {
      micros.push({
        phase: 'W', label: 'Micro-despertar ' + (i + 1), block: 'micro',
        // pendiente [1.2, 0.2]: se ve cómo la onda lenta se aplana, sube la
        // beta y después vuelve a bajar al siguiente N2
        lvl: [1.2, 0.2],
        min: Math.max(rnd(0.6, 1.8) * scale, microMin)
      });
    }
    const microTotal = micros.reduce((s, x) => s + x.min, 0);

    // el resto de minutos se reparte entre las fases flexibles con variación
    const flex = SESSION_PLAN.filter((x) => !x.fixed);
    const flexTarget = Math.max(0, totalMin - relax - cut - latency - microTotal);
    const jittered = flex.map((x) => x.min * rnd(0.86, 1.16));
    const jSum = jittered.reduce((s, v) => s + v, 0) || 1;
    const scaled = jittered.map((v) => v * flexTarget / jSum);

    const out = [
      { phase: 'W',   label: 'Latencia de sueño', block: 'latency', lvl: [0, 0], min: latency },
      { ...SESSION_PLAN[0], min: relax },
      { ...SESSION_PLAN[1], min: cut }
    ];
    let mi = 0;
    flex.forEach((x, i) => {
      if (x.phase === 'N3' && mi < micros.length && Math.random() < 0.6) out.push(micros[mi++]);
      out.push({ ...x, min: scaled[i] });
    });
    while (mi < micros.length) out.splice(out.length - 1, 0, micros[mi++]);
    return out;
  }

  /* ---------- generador de sueños (combinatorio) ---------- */
  const DREAM = {
    lugares: [
      'un pasillo de biblioteca sin fin', 'una piscina pública a las 3 a. m.',
      'el último piso de un edificio que no existe', 'una carretera entre dos ciudades sin nombre',
      'un laboratorio lleno de acuarios', 'una plaza con todas las fuentes apagadas',
      'un ascensor que baja 40 pisos en 4 segundos', 'una playa de vidrio bajo lluvia vertical',
      'una copia de sala con la puerta cerrada', 'un mercado de barrio con cajeros automáticos'
    ],
    acciones: [
      'corro sin llegar a ningún sitio', 'busco una respuesta en un examen que no estudio',
      'conozco a mis profesores de la primaria, intactos', 'cruzo puertas y todas dan al mismo cuarto',
      'intento agarrar algo que se aleja cada vez más rápido', 'repito una conversación que ya tuve',
      'apago todas las luces una por una y el ruido continúa', 'escribo un examen con la mano izquierda',
      'cambio de idioma a mitad de una frase', 'espero un bus que llega lleno de gente que conozco'
    ],
    reglas: [
      'nadie me reconoce cuando digo mi nombre',
      'el tiempo va hacia atrás cada vez que me acerco a una puerta',
      'mis llaves abren todas las puertas menos la que necesito',
      'cada vez que parpadeo cambia la hora del día',
      'el agua sube despacio y nadie tiene miedo',
      'los sonidos llegan un segundo antes que la imagen',
      'el frío solo existe en los objetos que toco',
      'hay un zumbido de 8 Hz que sigue toda la escena'
    ],
    cierres: [
      'despierto con la sensación de que ya había hecho esto',
      'algo se rompe justo antes de que entienda qué',
      'el sueño se reinicia solo desde el principio, más lento',
      'me quedo quieto esperando que termine, y termina',
      'me despierto con el corazón acelerado pero tranquilo',
      'sueño que llevo un rato despierto, y despierto'
    ],
    temas: {
      examen: { t: 'De evaluación', k: ['Memoria de trabajo', 'Ansiedad', 'Presión'],
        f: 'De fondo se oye una campana de examen que nadie está tocando.' },
      practico: { t: 'De trabajo', k: ['Carga cognitiva', 'Reloj interno', 'Metacognición'],
        f: 'Repito la misma tarea endless vez y cada intento sale distinto.' },
      narrativo: { t: 'Narrativo', k: ['Creatividad', 'Símbolo de paso', 'Narrador ambiguo'],
        f: 'Alguien me narra lo que pasa y no sé si me lo cuenta o me lo recuerda.' },
      neutro: { t: 'Neutro', k: ['Transición', 'Digestión', 'Deriva'],
        f: 'No pasa nada urgente y por eso el sueño no se termina nunca.' }
    }
  };

  function makeDream(t0, t1, cycle, profile) {
    const prof = profile || PROFILES[0];
    const kind = pickWeighted(prof.themes);
    const meta = DREAM.temas[kind];
    return {
      id: 'dr' + Math.random().toString(36).slice(2, 8),
      from: t0, to: t1, cycle,
      kind: meta.t,
      keywords: meta.k,
      title: 'Ciclo ' + cycle + ' · ' + meta.t,
      text: 'Soñaba en ' + pick(DREAM.lugares) + ' donde ' + pick(DREAM.acciones) +
            '. ' + meta.f + ' En algún punto ' + pick(DREAM.reglas) +
            '. Al final ' + pick(DREAM.cierres) + '.',
      oai: Math.round(rnd(prof.oai[0], prof.oai[1]) * 100) / 100,
      intensity: Math.round(rnd(prof.intensity[0], prof.intensity[1]))
    };
  }

  /* ---------- nombres de dispositivo ---------- */
  const NO_SUFIJOS = ['CASTILLO', 'MORALES', 'QUINTERO', 'RANGEL', 'OJEDA', 'PARRA', 'VILLA', 'MENA'];

  const mac = (seed) => {
    let s = seed !== undefined ? (seed | 0) : (Math.random() * 0x7fffffff) | 0;
    if (!s) s = 12345;
    const r = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s; };
    return Array.from({ length: 3 }, () =>
      (r() & 0xFF).toString(16).padStart(2, '0').toUpperCase()).join(':');
  };

  /* otros dispositivos que aparecen en el escaneo */
  const NOISE_DEVICES = [
    { name: 'Auriculares WH-1000XM5', kind: 'audio' },
    { name: 'Teclado MX Keys Mini', kind: 'periférico' },
    { name: 'Smartwatch Serie 9', kind: 'reloj' },
    { name: 'Impresora LBP-220', kind: 'impresora' },
    { name: 'Bocina Portable Go', kind: 'audio' }
  ];

  /* ══════════════════════════════════════════════
     MaskLink — enlace con el dispositivo por BLE
     ══════════════════════════════════════════════ */
  class MaskLink {
    constructor(opts) {
      const o = opts || {};
      this.seed = (o.seed | 0) || (Math.random() * 0x7fffffff) | 0;
      this.name = 'PAUSA-01';
      this.mac = 'C4:2F:1A:' + mac(this.seed);
      this.owner = NO_SUFIJOS[Math.abs(this.seed) % NO_SUFIJOS.length];
      this.battery = Math.round(rnd(62, 94));
      this.state = 'idle';          // idle | scanning | found | pairing | linked | live | done
      this.session = null;
      // una fuente de ruido por canal, con semillas distintas derivadas de
      // la semilla del enlace: recargar la página no cambia la señal
      const SEED_C = [11, 47, 83, 129];
      this.noise = SEED_C.map((k) => makeNoise((this.seed ^ (k * 2654435761)) | 0));
      this.t0 = performance.now();
    }

    get id() { return this.name; }

    /* lista de dispositivos cercanos que devuelve el escaneo */
    nearby() {
      const out = [{
        id: this.name, name: this.name, kind: 'mask', mac: this.mac,
        rssi: -Math.round(rnd(38, 72)), paired: false
      }];
      const pool = NOISE_DEVICES.slice();
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const pickIdx = Math.floor(Math.random() * pool.length);
        const d = pool.splice(pickIdx, 1)[0];
        out.push({
          id: d.name, name: d.name, kind: d.kind,
          mac: mac(), rssi: -Math.round(rnd(58, 92)), paired: true
        });
      }
      return out.sort((a, b) => b.rssi - a.rssi);
    }

    /* ---- handshake BLE ---- */
    scan() {
      this.state = 'scanning';
      return new Promise((resolve) => {
        setTimeout(() => {
          // 12 % de probabilidad: no hay máscara cerca
          if (Math.random() < 0.12) {
            this.state = 'idle';
            return resolve({ ok: false, reason: 'empty' });
          }
          this.state = 'found';
          resolve({ ok: true, devices: this.nearby() });
        }, rnd(1600, 2600));
      });
    }

    /* Emparejamiento: la clave se valida en el dispositivo. */
    pair(pin) {
      this.state = 'pairing';
      return new Promise((resolve) => {
        setTimeout(() => {
          if (!/^\d{6}$/.test(String(pin || '').trim())) {
            this.state = 'found';
            return resolve({ ok: false, reason: 'format' });
          }
          this.state = 'linked';
          this.pin = String(pin).trim();
          resolve({ ok: true, services: ['HRM', 'SPO2', 'IMU', 'TEMPE', 'BLE-PEP-0xF0'] });
        }, rnd(1100, 1700));
      });
    }

    _shutdown() {
      this._pump = null;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    disconnect() {
      this._shutdown();
      this.state = 'idle';
      this.session = null;
    }

    /* ---- arranca una sesión y llama onTick(telemetría) cada frame ----
       Corre a tiempo real: 1 s de reloj = 1 s de sesión. `opts.minutes`
       define el periodo (1, 3, 5 o 180), `opts.trial` si es periodo de
       prueba, `opts.profile` el perfil y `opts.asleep` si llegó a dormirse.
       `opts.startedAt` permite retomar una sesión pausada y `opts.plan`
       reutiliza el plan ya calculado, para que una sesión reanudada siga
       exactamente la misma noche y no se vuelva a tirar los dados.      */
    start(onTick, onDream, onEnd, opts) {
      const options = opts || {};
      const totalMin = options.minutes || 180;
      const trial = !!options.trial;
      const profile = options.profile || PROFILES[0];
      // reloj de pared: si la sesión se reanuda tras una recarga, el tiempo
      // que pasó con la pestaña cerrada también cuenta
      const startedAt = options.startedAt || Date.now();
      this.state = 'live';
      this.totalMin = totalMin;
      this.trial = trial;
      this.profile = profile;
      this.startedAt = startedAt;

      // suavizado de parámetros hacia el estado actual
      const cur = options.telemetry
        ? Object.assign({}, options.telemetry)
        : { hr: 68 + (profile.hrBias || 0) * 0.4, hrv: 52 + (profile.hrvBias || 0) * 0.4, spo2: 97, temp: 33.7 };
      let lastDream = options.lastDream || null;

      const plan = options.plan || buildPlan(totalMin, profile, options.asleep);
      this.plan = plan;

      // momento en que la persona pasa de alpha a theta: a partir de ahí duerme
      const lat = plan.find((p) => p.block === 'latency');
      const relax = plan.find((p) => p.block === 'relax');
      const never = plan.some((p) => p.block === 'nowake');
      this.fellAsleep = !never;
      this.asleepAt = never
        ? Infinity
        : (lat ? lat.min : 0) + (relax ? relax.min * 0.75 : 0);
      this.totals = plan.reduce((acc, p) => {
        acc[p.phase] = (acc[p.phase] || 0) + p.min;
        return acc;
      }, {});

      // La función de onda se construye UNA vez: es pura y ya lleva calculado
      // el recorrido del plan, así que no hace falta repetirlo en cada tick.
      const waveFn = this.waveFnFor(plan, profile, totalMin);
      this.waveFn = waveFn;

      let cursor = 0;
      let idx = 0;
      let cycles = 0;
      let segStart = plan[0].min;
      let segEnd = plan[0].min;

      const loop = () => {
        if (this.state !== 'live') return;
        const t = clamp((Date.now() - startedAt) / 60000, 0, totalMin);

        // avanza de segmento
        while (t >= segEnd && idx < plan.length - 1) {
          cursor = segEnd;
          idx++;
          segStart = segEnd;
          segEnd += plan[idx].min;
          if (plan[idx].phase === 'R') {
            cycles++;
            const d = makeDream(cursor, segEnd, cycles, profile);
            if (onDream) onDream(d);
            lastDream = d;
          }
        }

        const seg = plan[idx];
        const p = PHASES[seg.phase];
        const b = BANDS[seg.phase];
        const local = clamp((t - segStart) / Math.max(seg.min, 0.001), 0, 1);
        // rampa de entrada/salida del estado para que los gauges no den saltos
        const ease = Math.sin(clamp(local, 0, 1) * Math.PI) * 0.35 + 0.65;

        // el perfil desplaza la fisiología: un estresado mantiene el pulso
        // más alto y la variabilidad más baja que un atleta
        const hb = profile.hrBias || 0, vb = profile.hrvBias || 0;
        const target = PHY[seg.phase] || PHY.W;
        const k = seg.phase === 'CUT' ? 0.02 : 0.06;   // durante el corte, los valores "se pierden"
        cur.hr   = lerp(cur.hr,   clamp(rnd(target.hr[0], target.hr[1]) + hb * 0.4, 38, 120), k * ease);
        cur.hrv  = lerp(cur.hrv,  clamp(rnd(target.hrv[0], target.hrv[1]) + vb * 0.5, 14, 160), k * ease);
        cur.spo2 = lerp(cur.spo2, rnd(target.spo2[0], target.spo2[1]), k * ease);
        cur.temp = lerp(cur.temp, rnd(target.temp[0], target.temp[1]), k * ease);

        // Corte de línea: el EEG se aplana. Solo queda ruido de electrodo.
        const cut = seg.phase === 'CUT';

        // profundidad continua del sueño en este instante
        const lvl = lerp(seg.lvl[0], seg.lvl[1], local);
        const wave = waveAt(lvl, cut);

        // Las ondas NO se muestrean aquí: se entrega `waveFn`, una función
        // pura del tiempo. El lienzo la evalúa en cada punto de la traza, así
        // que la forma real de cada estado (delta lenta, beta rápida, espigas)
        // se dibuja bien y no se duplica un valor por frame.
        if (onTick) {
          onTick({
            elapsedMin: t,
            totalMin,
            phase: p,
            segment: seg,
            segmentIndex: idx,
            band: wave.band,
            bandDesc: b.desc,
            // sigue despierta si la señal aún no ha pasado de alpha a theta
            awakeNow: !!p.awake,
            level: lvl,
            signalCut: cut,
            // ritmo dominante y amplitud: el lienzo los usa para elegir
            // cuántos segundos mostrar y cuánto estirar la traza
            waveAmp: wave.amp,
            waveFreq: wave.dom,
            waveBand: wave.band,
            asleep: t >= this.asleepAt,
            asleepAt: this.asleepAt,
            fellAsleep: this.fellAsleep,
            // proyectado a 3 h: en los periodos de prueba 0,15 min no sirve
            asleepAtProj: isFinite(this.asleepAt) ? this.asleepAt * (180 / totalMin) : Infinity,
            asleepProj: t >= this.asleepAt ? (t - this.asleepAt) * (180 / totalMin) : 0,
            segLocal: local,
            segTotalMin: seg.min,
            progress: t / totalMin,
            leftMin: totalMin - t,
            hr: cur.hr, hrv: cur.hrv, spo2: cur.spo2, temp: cur.temp,
            waveFn,
            motion: seg.phase === 'R' ? rnd(0.15, 0.55) : rnd(0.01, 0.09),
            battery: this.battery
          });
        }

        if (t >= totalMin) {
          this.state = 'done';
          this._pump = null;
          this._perfStart = null;
          if (onEnd) onEnd(this.buildReport(plan, cur, lastDream, totalMin, trial, profile));
          return;
        }
      };

      /* rAF se congela si la pestaña no dibuja (minimizada o en background),
         así que el mismo tick también lo dispara un interval de 40 ms.
         Como el tiempo se lee del reloj de pared, una pestaña en segundo plano
         que se despierte recupera los minutos perdidos sin saltos. */
      this._pump = loop;
      this._perfStart = performance.now();
      const rafId = () => {
        if (this._pump !== loop) return;
        requestAnimationFrame(() => rafId());
        loop();
      };
      this._timer = setInterval(() => {
        if (this._pump === loop) loop();
      }, 40);
      rafId();
    }

    stop() { this.state = 'linked'; this._shutdown(); this._perfStart = null; }

    /* Genera la función de onda del EEG: `fn(segundos, canal)` → [-1, 1].
       Es pura y determinista, así que el lienzo puede pedirle un punto por
       píxel y obtener la morfología real de cada estado en vez de un ruido.

       Cada canal es una derivación distinta con su propio factor:
         AF7  frontal izquierda   -> marcada en beta, la primera en calmarse
         AF3  frontal derecha     -> referencia, más estable
         F7   temporal izquierda  -> la portadora del sueño lento
         F8   occipital derecha   -> alpha de ojos cerrados y aflojamiento
                                       visual en REM                                */
    waveFnFor(plan, profile, totalMin) {
      const prof = profile || PROFILES[0];
      const e = prof.eeg || { amp: 1, noise: 1, beta: 0.5, emg: 1 };
      const CH_F = [1.06, 0.94, 1.0, 1.12];   // frecuencia relativa por canal
      const CH_A = [0.74, 1.0, 1.16, 0.86];    // amplitud relativa por canal
      const CH_AL = [0.85, 1.0, 0.9, 1.2];     // alpha de ojos cerrados, occipital
      const seeds = [11.3, 47.9, 83.1, 129.7];

      // límites del plan, calculados una sola vez
      const bounds = [];
      plan.forEach((p) => {
        const s0 = bounds.length ? bounds[bounds.length - 1].s1 : 0;
        bounds.push({ s0, s1: s0 + p.min, min: p.min, seg: p });
      });

      const segAt = (sec) => {
        const m = clamp(sec / 60, 0, totalMin);
        for (let i = 0; i < bounds.length; i++) {
          if (m < bounds[i].s1 || i === bounds.length - 1) {
            const local = clamp((m - bounds[i].s0) / Math.max(bounds[i].min, 1e-6), 0, 1);
            return { i, local, seg: bounds[i].seg, b: bounds[i] };
          }
        }
        return { i: 0, local: 1, seg: plan[0], b: bounds[0] };
      };

      /* Profundidad en un instante. Se promedia con los segundos vecinos
         para que el paso de un tramo al siguiente sea una pendiente visible
         y no un salto: es lo que permite ver conciliarse y despertarse. */
      const lvlAt = (sec) => {
        const one = (s) => {
          const { local, seg } = segAt(s);
          if (!seg.lvl) return seg.phase === 'CUT' ? 2.6 : 2;
          return lerp(seg.lvl[0], seg.lvl[1], local);
        };
        return (one(sec - 0.8) + one(sec) + one(sec + 0.8)) / 3;
      };

      // atenuación del corte: cae a 0 en el 6 % inicial y vuelve en el 6 % final
      const cutAlpha = (local) => {
        const a = clamp(local / 0.06, 0, 1);
        const b = clamp((1 - local) / 0.06, 0, 1);
        return Math.min(a, b);
      };

      // caché de una posición: el lienzo recorre la ventana canal a canal y
      // para el mismo segundo pide los cuatro canales seguidos
      let lastSec = NaN, lastWave = null, lastCut = false, lastAl = 1;

      const stateAt = (sec) => {
        if (sec === lastSec) return;
        lastSec = sec;
        const { local, seg } = segAt(sec);
        const cut = seg.phase === 'CUT';
        lastCut = cut;
        lastAl = cut ? cutAlpha(local) : 1;
        lastWave = waveAt(lvlAt(sec), cut);
      };

      return (sec, ch) => {
        stateAt(sec);
        const m = lastWave;

        if (lastCut) {
          return this.noise[ch](sec * 6 + ch * 31) * 0.055 * lastAl;
        }

        const sd = seeds[ch];
        const f = m.freq * CH_F[ch];

        // portadora principal: la banda que define el estado
        let v = Math.sin(sec * f * Math.PI * 2 + sd);
        // armónico: le da cuerpo sin perder el ritmo base
        v += Math.sin(sec * f * 2.03 * Math.PI * 2 + sd * 1.7) * 0.18;
        // subarmónico lento: en delta y theta es lo que da el bamboleo
        v += Math.sin(sec * f * 0.5 * Math.PI * 2 + sd) * (f < 3 ? 0.34 : 0.12);

        /* Alpha de ojos cerrados: ritmo posterior regular de ~9,6 Hz. En el
           tramo relajado es la portadora (WAVE.relax.freq), así que aquí solo
           queda el reguero que sobrevive cuando el sueño ya entra: la
           diferencia visible entre la persona relajada pero despierta y la que
           sigue en beta, y la primera señal de que se está conciliando. */
        if (m.alpha) {
          const af = 9.6 * CH_F[ch];
          const am = Math.sin(sec * 0.35 + sd) * 0.12 + 0.88;   // modulación lenta
          v += Math.sin(sec * af * Math.PI * 2 + sd * 2.1) * 0.42 * m.alpha * am * CH_AL[ch];
        }

        /* Beta de fondo: la "pelusa" sobre la portadora. Es la diferencia
           visible entre un perfil relajado y uno estresado, y cae conforme
           entra el sueño: fuerte en beta, casi apagada en N3 y REM. */
        if (e.beta && m.beta) {
          v += whiteNoise(sec * 21 + ch * 7.3) * 0.42 * e.beta * m.beta;
        }

        /* Artefacto muscular: solo con los ojos abiertos. Da la textura
           nerviosa e irregular delEEG de quien todavía está despierto. */
        if (e.emg && m.emg) {
          v += whiteNoise(sec * 47 + ch * 13.1) * 0.5 * (e.emg || 1) * m.emg;
        }

        /* Espigas de sueño (N2): ráfagas breve de 13 Hz. Van por encima del
           umbral solo una parte del tiempo, así que se ven como trazos
           puntiagudos aislados sobre la sigma y no como una portadora
           continua que domine el conteo de ondas. */
        if (m.spindle) {
          const env = Math.sin(sec * 1.15 + ch * 0.8);
          const burst = env > 0.86 ? 1 : 0;
          v += Math.sin(sec * 13 * Math.PI * 2 + sd * 2.3) * 0.7 * burst;
        }

        // dientes de sierra del REM (movimiento ocular rápido)
        if (m.saw) {
          const sawT = (sec * f * 1.4) % 1;
          v += (sawT * 2 - 1) * m.saw * (ch === 3 ? 1.35 : 0.55);
        }

        // ruido de fondo y micro-despertos cardiacos
        v += this.noise[ch](sec * f * 3.2 + ch * 9) * m.noise;

        // el perfil modula amplitud global y ruido
        v *= m.amp * CH_A[ch] * e.amp;

        return clamp(v, -1, 1);
      };
    }

    buildReport(plan, cur, lastDream, totalMin, trial, profile) {
      const prof = profile || PROFILES[0];
      const factor = 180 / (totalMin || 180);
      const byPhase = {};
      const projPhase = {};
      plan.forEach((p) => {
        byPhase[p.phase] = (byPhase[p.phase] || 0) + p.min;
        projPhase[p.phase] = (projPhase[p.phase] || 0) + p.min * factor;
      });

      /* No se durmió: el informe lo dice y no inventa nada. Sin puntuación,
         sin ciclos, sin sueños: la máquina estuvo vigilando a alguien que
         estuvo despierto todo el rato, y eso es el resultado. */
      if (plan.some((p) => p.block === 'nowake')) {
        const awakeMin = totalMin;
        const lastSeg = plan[plan.length - 1];
        return {
          score: null,
          trial,
          fellAsleep: false,
          totalMin,
          profileId: prof.id,
          profileName: prof.name,
          realMin: totalMin,
          equivalentMin: 0,
          equivalentHours: 0,
          byPhase, projPhase,
          remMin: 0, deepMin: 0, relaxMin: 0, cutMin: 0,
          latency: null, micros: 0, eff: 0,
          asleepMin: 0, consolidation: 0, spindles: 0,
          cycles: 0,
          awakeMin, awakeMinProj: awakeMin * factor,
          wakePhase: lastSeg.phase,
          wakeLabel: PHASES[lastSeg.phase].name,
          dreams: 0,
          hr: cur.hr, hrv: cur.hrv, spo2: cur.spo2,
          lastDream: null,
          advice: [
            'No llegaste a dormirte en ' + fmtHM(totalMin) + '.',
            'La señal se quedó en beta y alpha todo el rato: ojos abiertos al principio, ojos cerrados después, pero sin theta, sin espigas y sin onda lenta. Eso es lo que se ve cuando alguien se acuesta con la cabeza encendida.',
            prof.tip,
            'Repite el periodo con la habitación a oscuras y el móvil fuera: en la mayoría de los casos el theta aparece en los primeros minutos.'
          ]
        };
      }

      const remMin = Math.round(projPhase.R || 0);
      const deepMin = Math.round(projPhase.N3 || 0);
      const latency = Math.round(plan[0].min * factor);
      const relaxMin = Math.round(plan.filter((p) => p.block === 'relax')
        .reduce((s, p) => s + p.min * factor, 0));
      const cutMin = Math.round(projPhase.CUT || 0);
      const micros = plan.filter((p) => p.block === 'micro').length;
      const wakeSeg = plan[plan.length - 1];
      const eff = clamp(Math.round(remMin * 2.1), 20, 100);
      const score = clamp(Math.round(44 + deepMin * 0.42 + eff * 0.12 + rnd(-4, 5)), 40, 99);
      const consolidation = clamp(Math.round(34 + deepMin * 0.72 - latency * 0.8 + rnd(-5, 5)), 25, 99);
      const spindles = Math.round(deepMin * rnd(4, 7));

      const advice = [prof.tip];
      if (trial) {
        advice.push('Periodo de prueba: ' + fmtHM(totalMin) + ' reales. El protocolo completo son 3 h, así que este ensayo corre a escala ' +
          Math.round(factor) + '× sin cambiar los tiempos relativos.');
      } else {
        advice.push('Sesión real de 3 h completa, sin aceleración: cada segundo de la línea es un segundo de reloj.');
      }
      advice.push('Te dormiste en ' + latency + ' min' +
        (micros ? ' y tuviste ' + micros + (micros === 1 ? ' micro-despertar' : ' micro-despertares') + ' durante la noche' : ' y no registraste micro-despertares') + '.');
      advice.push('El corte de línea recuperó la señal en ' + cutMin +
        ' min de las ' + fmtHM(35 * factor) + ' que dura el protocolo de corte.');
      if (deepMin < 62) advice.push('Tu onda lenta bajó de lo normal. Mañana repite la sesión de 3 h con la máscara bien ajustada para recuperar la consolidación de memoria.');
      else advice.push('Consolidación de memoria excelente. Este es el perfil de sueño ideal antes de un examen.');
      if (remMin > 34) advice.push('Dormiste REM de sobra: si te cuesta despertar, prueba a usar la función de fin de sesión más temprana en la próxima noche.');
      else advice.push('REM un poco corto. Mantén la sesión completa de 3 h: los ciclos oníricos se recuperan en la segunda mitad.');
      advice.push(pick([
        'El patrón onírico de anoche coincide con tus parciales de las últimas 3 semanas.',
        'Tus sueños de esta semana traen 3 veces más elementos verbales que la media.',
        'La señal volvió del corte sin artefactos: los 4 electrodos re-sincronizaron a la primera.',
        'Tu variabilidad de frecuencia cardíaca subió 14 ms al dormirte: te fuiste relajado.'
      ]));

      return {
        score,
        trial,
        fellAsleep: true,
        totalMin,
        profileId: prof.id,
        profileName: prof.name,
        realMin: totalMin,
        equivalentMin: totalMin * COMPRESSION,
        equivalentHours: (totalMin * COMPRESSION) / 60,
        byPhase, projPhase, remMin, deepMin, relaxMin, cutMin, latency, micros, eff,
        asleepMin: Math.round((totalMin - plan[0].min) * factor),
        consolidation, spindles,
        cycles: plan.filter((p) => p.phase === 'R').length,
        // en qué estado terminó el sueño: la ventana de despertado
        wakePhase: wakeSeg.phase,
        wakeLabel: PHASES[wakeSeg.phase].name,
        wakeAt: totalMin - wakeSeg.min * factor,
        dreams: plan.filter((p) => p.phase === 'R').length,
        hr: cur.hr, hrv: cur.hrv, spo2: cur.spo2,
        lastDream,
        advice
      };
    }
  }

  const fmtHM = (min) => {
    if (!isFinite(min)) return '—';
    const m = Math.round(min);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
  };

  /* ══════════════════════════════════════════════
     Memoria del navegador
     ══════════════════════════════════════════════
     El flujo de la noche se guarda en el mismo navegador para poder cerrar
     la pestaña y retomarla sin perder nada. Vive en localStorage, que
     sobrevive al cierre del navegador, con dos límites:

       · una caducidad (TTL): lo guardado se considera vigente durante
         6 h desde su última escritura. Pasado ese tiempo se descarta solo.
       · el tamaño: no se guarda la traza píxel a píxel sino el hipnograma
         muestreado y los registros oníricos, que es lo que hace falta para
         reconstruir la noche.

     Si localStorage no está disponible (modo privado estricto, file:// sin
     permiso), la memoria cae a sessionStorage y, si tampoco, a memoria
     volátil: la app sigue funcionando, solo que no sobrevive a la recarga. */
  const STORE = {
    KEY: 'ponte-en-pausa:noche',
    TTL_MS: 6 * 60 * 60 * 1000,   // 6 horas de vigencia
    MEM: null,
    memKey: null,
    _backend: null
  };

  function storeBackend() {
    if (STORE._backend) return STORE._backend;
    const probe = '__pep_probe__';
    try {
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      STORE._backend = global.localStorage;
      return STORE._backend;
    } catch (e) {
      try {
        global.sessionStorage.setItem(probe, '1');
        global.sessionStorage.removeItem(probe);
        STORE._backend = global.sessionStorage;
      } catch (e2) {
        STORE._backend = STORE;   // sin almacenamiento: memoria de la pestaña
      }
      return STORE._backend;
    }
  }

  function storeRead() {
    const b = storeBackend();
    let raw;
    if (b === STORE) {
      raw = STORE.MEM && STORE.memKey === STORE.KEY ? STORE.MEM : null;
    } else {
      try { raw = b.getItem(STORE.KEY); } catch (e) { raw = null; }
    }
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || typeof data !== 'object') return null;

    // caducidad: si pasó el TTL desde la última escritura, la noche se va
    if (STORE.TTL_MS > 0 && (!data.savedAt || Date.now() - data.savedAt > STORE.TTL_MS)) {
      storeClear();
      return null;
    }
    return data;
  }

  function storeWrite(data) {
    const payload = Object.assign({}, data, { savedAt: Date.now(), v: 1 });
    const raw = JSON.stringify(payload);
    const b = storeBackend();
    if (b === STORE) { STORE.MEM = raw; STORE.memKey = STORE.KEY; return payload; }
    try { b.setItem(STORE.KEY, raw); } catch (e) {
      // cuota llena: se recortan los registros oníricos y se reintenta una vez
      if (Array.isArray(payload.dreams) && payload.dreams.length) {
        payload.dreams = payload.dreams.slice(-6);
        try { b.setItem(STORE.KEY, JSON.stringify(payload)); } catch (e2) { /* se deja igual */ }
      }
    }
    return payload;
  }

  function storeClear() {
    const b = storeBackend();
    if (b === STORE) { STORE.MEM = null; STORE.memKey = null; return; }
    try { b.removeItem(STORE.KEY); } catch (e) { /* sin permiso: nada que borrar */ }
  }

  global.NEBULA = {
    MaskLink, PHASES, BANDS, SESSION_PLAN, SESSION_MODES, CUT_MIN, COMPRESSION,
    PROFILES, buildPlan, pickWeighted, willSleep,
    WAVE, LVL, LADDER, waveAt, mixWave,
    fmtHM, makeDream, clamp, lerp, rnd, pick, makeNoise,
    store: { read: storeRead, write: storeWrite, clear: storeClear, KEY: STORE.KEY, TTL_MS: STORE.TTL_MS }
  };
})(window);