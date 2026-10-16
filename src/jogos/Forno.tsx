// "Tira do Forno" — passatempo da tela de carregamento.
// Vista frontal de um forno de lastro com boca arqueada de tijolos. Quatro pães assam na
// assadeira; o jogador tira cada um (clique/toque ou teclas 1–4) quando a crosta fica dourada.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { JogoProps } from './tipos';
import { ALTURA, COR, FONTE, FONTE_SERIFA, LARGURA, pontoNoQuadro, prefereMenosMovimento, prepararCanvas } from './tipos';

// ───────────────────────── tipos ─────────────────────────

type Fase = 'pronto' | 'jogando' | 'fim';
type EstadoPao = 'vazio' | 'espera' | 'entrando' | 'assando' | 'carvao';
type Rgb = [number, number, number];

interface Slot {
  estado: EstadoPao;
  tipo: number; // 0 francês · 1 baguete · 2 sonho · 3 pão de queijo
  c: number; // nível de cozimento: 0 cru → P dourado → QUEIMA carvão
  vel: number; // cozimento por segundo
  w: number; // meia-janela do ponto perfeito
  gA: number; // folga "bom" antes da janela
  gD: number; // folga "bom" depois da janela
  espera: number; // segundos até a massa entrar
  anim: number; // tempo no estado atual
  pouso: number; // tempo desde que pousou na assadeira (squash)
}

interface Part {
  tipo: 'fumaca' | 'faisca' | 'migalha' | 'vapor' | 'brasa';
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  dur: number;
  tam: number;
  cor: string; // "r,g,b"
  giro: number;
}

interface Voo {
  tipo: number;
  c: number;
  x: number;
  y: number;
  t: number;
  dir: number;
}

interface Txt {
  x: number;
  y: number;
  txt: string;
  cor: string;
  t: number;
  dur: number;
  tam: number;
  serifa: boolean;
  atraso: number;
}

interface Estado {
  fase: Fase;
  relogio: number;
  tempo: number;
  pontos: number;
  vidas: number;
  perdaT: number[];
  slots: Slot[];
  parts: Part[];
  voando: Voo[];
  textos: Txt[];
  tremor: number;
  fimT: number;
  novoRecorde: boolean;
  recordeFim: number;
  terminou: boolean;
  perfeitos: number;
  bons: number;
  hover: number;
  flash: number[];
  pontosPop: number;
  menos: boolean;
}

interface Ganchos {
  recorde: () => number;
  aoPontos: (n: number) => void;
  aoFim: (n: number) => void;
}

// ───────────────────────── constantes ─────────────────────────

const BOCA_CX = 245;
const BOCA_Y = 118; // linha de nascença do arco
const BOCA_RX = 185;
const BOCA_RY = 72;
const BOCA_ESQ = BOCA_CX - BOCA_RX; // 60
const BOCA_DIR = BOCA_CX + BOCA_RX; // 430
const PISO = 208;
const BASE_Y = 195; // onde o pão encosta na assadeira
const SLOT_X = [113, 201, 289, 377];
const MEDIDOR_Y = 142;

const P = 0.6; // centro do ponto perfeito
const QUEIMA = 0.92; // vira carvão
const ENTRADA = 0.36; // duração da queda da massa

const LARG = [58, 78, 46, 70];
const QUEIJO: [number, number][] = [
  [-22, 11.5],
  [22, 11.5],
  [0, 13],
];

const TIJOLOS = ['#8F5537', '#9A5C3B', '#86502F', '#A3653F', '#7E4A2D', '#94583A'];

// ───────────────────────── utilidades ─────────────────────────

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (c: Rgb, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const misturar = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function semente(n: number) {
  let a = n >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROSTA: [number, Rgb][] = [
  [0, hex('#F2E6CF')],
  [0.25, hex('#EEDBAE')],
  [0.42, hex('#E6BD70')],
  [0.6, hex('#CC8B36')],
  [0.7, hex('#A5642A')],
  [0.8, hex('#6B3D1C')],
  [0.87, hex('#3A2416')],
  [0.92, hex('#1F1610')],
  [1, hex('#16110C')],
];

function corCrosta(c: number, tipo: number): Rgb {
  let cor: Rgb = CROSTA[CROSTA.length - 1][1];
  for (let k = 0; k < CROSTA.length - 1; k++) {
    const [c0, a] = CROSTA[k];
    const [c1, b] = CROSTA[k + 1];
    if (c <= c1) {
      cor = misturar(a, b, clamp01((c - c0) / (c1 - c0)));
      break;
    }
  }
  // pão de queijo puxa para o amarelo do queijo enquanto não escurece
  if (tipo === 3) cor = misturar(cor, [236, 200, 110], 0.2 * (1 - clamp01((c - 0.62) / 0.2)));
  return cor;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]) {
  const [a, b, c, d] = typeof r === 'number' ? [r, r, r, r] : r;
  ctx.beginPath();
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + b);
  ctx.lineTo(x + w, y + h - c);
  ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h);
  ctx.lineTo(x + d, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - d);
  ctx.lineTo(x, y + a);
  ctx.quadraticCurveTo(x, y, x + a, y);
  ctx.closePath();
}

function caminhoBoca(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(BOCA_ESQ, PISO);
  ctx.lineTo(BOCA_ESQ, BOCA_Y);
  ctx.ellipse(BOCA_CX, BOCA_Y, BOCA_RX, BOCA_RY, 0, Math.PI, Math.PI * 2);
  ctx.lineTo(BOCA_DIR, PISO);
  ctx.closePath();
}

function dific(s: Estado) {
  return clamp01(s.tempo / 110);
}

function noPonto(p: Slot) {
  return p.estado === 'assando' && Math.abs(p.c - P) <= p.w;
}

function slotEm(x: number, y: number) {
  if (y < 96 || y > 246) return -1;
  for (let i = 0; i < 4; i++) if (Math.abs(x - SLOT_X[i]) <= 44) return i;
  return -1;
}

// ───────────────────────── estado e regras ─────────────────────────

function slotVazio(): Slot {
  return { estado: 'vazio', tipo: 0, c: 0, vel: 0, w: 0.065, gA: 0.13, gD: 0.1, espera: 0, anim: 0, pouso: 9 };
}

function criarEstado(): Estado {
  const demo = [0.14, 0.6, 0.4, 0.8];
  return {
    fase: 'pronto',
    relogio: 0,
    tempo: 0,
    pontos: 0,
    vidas: 3,
    perdaT: [-1, -1, -1],
    slots: demo.map((c, i) => ({ ...slotVazio(), estado: 'assando' as EstadoPao, tipo: i, c, w: 0.06 })),
    parts: [],
    voando: [],
    textos: [],
    tremor: 0,
    fimT: 0,
    novoRecorde: false,
    recordeFim: 0,
    terminou: false,
    perfeitos: 0,
    bons: 0,
    hover: -1,
    flash: [0, 0, 0, 0],
    pontosPop: 9,
    menos: false,
  };
}

/** Segundos até a massa do slot chegar ao ponto, ou null se não importa mais. */
function tempoAtePonto(p: Slot): number | null {
  if (p.vel <= 0) return null;
  if (p.estado === 'espera') return p.espera + ENTRADA + P / p.vel;
  if (p.estado === 'entrando') return Math.max(0, ENTRADA - p.anim) + P / p.vel;
  if (p.estado === 'assando' && p.c < P) return (P - p.c) / p.vel;
  return null;
}

/** Coloca uma massa nova no slot, escolhendo a velocidade para não coincidir o ponto com os vizinhos. */
function novaMassa(s: Estado, i: number, atraso = rand(0.45, 1.1)) {
  const d = dific(s);
  const extra = 1 + Math.min(0.6, Math.max(0, s.tempo - 110) * 0.006);
  const tMin = lerp(5.4, 2.6, d) / extra;
  const tMax = lerp(8.2, 4.2, d) / extra;
  let melhorT = rand(tMin, tMax);
  let melhorSep = -1;
  for (let k = 0; k < 10; k++) {
    const T = rand(tMin, tMax);
    const tp = atraso + ENTRADA + T;
    let sep = Infinity;
    for (let j = 0; j < 4; j++) {
      if (j === i) continue;
      const tj = tempoAtePonto(s.slots[j]);
      if (tj !== null) sep = Math.min(sep, Math.abs(tp - tj));
    }
    if (sep > melhorSep) {
      melhorSep = sep;
      melhorT = T;
    }
    if (sep >= 0.75) break;
  }
  const anterior = s.slots[i].tipo;
  let tipo = Math.floor(Math.random() * 4);
  if (tipo === anterior && Math.random() < 0.6) tipo = (tipo + 1 + Math.floor(Math.random() * 3)) % 4;
  const vel = P / melhorT;
  // Janelas nunca ficam curtas demais em tempo real: o ponto perfeito dura pelo menos
  // ~0,4 s e as folgas "bom" ~0,3 s antes e ~0,22 s depois, por mais rápida que seja a forneada.
  s.slots[i] = {
    estado: 'espera',
    tipo,
    c: 0,
    vel,
    w: Math.max(lerp(0.065, 0.032, d), vel * 0.2),
    gA: Math.max(lerp(0.13, 0.1, d), vel * 0.3),
    gD: Math.max(lerp(0.1, 0.075, d), vel * 0.22),
    espera: atraso,
    anim: 0,
    pouso: 9,
  };
}

function emitir(s: Estado, p: Omit<Part, 't' | 'giro'> & { giro?: number }) {
  if (s.parts.length > 240) return;
  s.parts.push({ ...p, t: 0, giro: p.giro ?? 0 });
}

function fumaca(s: Estado, x: number, y: number, escura = false) {
  emitir(s, {
    tipo: 'fumaca',
    x: x + rand(-12, 12),
    y: y + rand(-4, 4),
    vx: rand(-6, 6),
    vy: rand(-42, -26),
    dur: rand(1.6, 2.5),
    tam: rand(5, 8),
    cor: escura ? '38,33,29' : '72,66,60',
  });
}

function texto(s: Estado, x: number, y: number, txt: string, cor: string, tam: number, serifa: boolean, atraso = 0) {
  s.textos.push({ x, y, txt, cor, t: 0, dur: 0.95, tam, serifa, atraso });
}

function terminar(s: Estado, g: Ganchos) {
  if (s.terminou) return;
  s.terminou = true;
  s.fase = 'fim';
  s.fimT = 0;
  const anterior = g.recorde();
  s.novoRecorde = s.pontos > anterior;
  s.recordeFim = Math.max(anterior, s.pontos);
  g.aoFim(s.pontos);
}

function perderVida(s: Estado, g: Ganchos) {
  if (s.fase !== 'jogando') return;
  s.vidas = Math.max(0, s.vidas - 1);
  s.perdaT[s.vidas] = 0;
  if (!s.menos) s.tremor = 0.35;
  if (s.vidas <= 0) terminar(s, g);
}

function iniciar(s: Estado, g: Ganchos) {
  s.fase = 'jogando';
  s.tempo = 0;
  s.pontos = 0;
  s.vidas = 3;
  s.perdaT = [-1, -1, -1];
  s.slots = [slotVazio(), slotVazio(), slotVazio(), slotVazio()];
  s.voando = [];
  s.textos = [];
  s.tremor = 0;
  s.fimT = 0;
  s.novoRecorde = false;
  s.terminou = false;
  s.perfeitos = 0;
  s.bons = 0;
  s.flash = [0, 0, 0, 0];
  const ordem = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  // começo suave: os pães entram um a um, para a primeira fornada não queimar tudo de uma vez
  const atrasos = [0.3, 1.9, 3.6, 5.4];
  ordem.forEach((i, k) => novaMassa(s, i, atrasos[k]));
  g.aoPontos(0);
}

function tentarIniciar(s: Estado, g: Ganchos) {
  if (s.fase === 'pronto' || (s.fase === 'fim' && s.fimT > 0.6)) iniciar(s, g);
}

function tirar(s: Estado, i: number, g: Ganchos) {
  if (s.fase !== 'jogando') return;
  const p = s.slots[i];
  s.flash[i] = 0.25;
  if (p.estado !== 'assando') return;
  const x = SLOT_X[i];
  const c = p.c;
  const lo = P - p.w;
  const hi = P + p.w;
  const f = s.menos ? 0.35 : 1;
  const antes = s.pontos;

  if (c >= lo && c <= hi) {
    s.pontos += 3;
    s.perfeitos++;
    texto(s, x, 150, 'Perfeito!', COR.verde, 20, true);
    texto(s, x, 170, '+3', COR.verde, 13, false, 0.08);
    const n = Math.round(16 * f);
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + rand(-1.3, 1.3);
      const v = rand(70, 170);
      emitir(s, {
        tipo: 'faisca',
        x: x + rand(-10, 10),
        y: BASE_Y - 16,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        dur: rand(0.45, 0.85),
        tam: rand(1.2, 2.2),
        cor: k % 4 === 0 ? '5,150,105' : k % 2 ? '255,243,196' : '240,210,122',
      });
    }
    for (let k = 0; k < Math.round(5 * f); k++) vapor(s, x, BASE_Y - 24);
  } else if (c >= lo - p.gA && c <= hi + p.gD) {
    s.pontos += 1;
    s.bons++;
    texto(s, x, 152, 'Bom', COR.verde, 17, true);
    texto(s, x, 170, '+1', COR.verde, 12, false, 0.08);
    for (let k = 0; k < Math.round(3 * f); k++) vapor(s, x, BASE_Y - 22);
  } else if (c < lo - p.gA) {
    texto(s, x, 152, 'Cru!', COR.rosa, 19, true);
    perderVida(s, g);
  } else {
    texto(s, x, 152, 'Queimou!', COR.rosa, 19, true);
    for (let k = 0; k < Math.round(8 * f); k++) fumaca(s, x, BASE_Y - 18, true);
    perderVida(s, g);
  }

  s.voando.push({ tipo: p.tipo, c, x, y: BASE_Y, t: 0, dir: i < 2 ? -1 : 1 });
  const cor = corCrosta(c, p.tipo);
  for (let k = 0; k < Math.round(6 * f); k++) {
    emitir(s, {
      tipo: 'migalha',
      x: x + rand(-18, 18),
      y: BASE_Y - rand(4, 14),
      vx: rand(-70, 70),
      vy: rand(-110, -30),
      dur: rand(0.7, 1.1),
      tam: rand(1.3, 2.6),
      cor: `${cor[0] | 0},${cor[1] | 0},${cor[2] | 0}`,
      giro: rand(0, Math.PI),
    });
  }
  if (s.pontos !== antes) {
    s.pontosPop = 0;
    g.aoPontos(s.pontos);
  }
  novaMassa(s, i);
}

function vapor(s: Estado, x: number, y: number) {
  emitir(s, {
    tipo: 'vapor',
    x: x + rand(-14, 14),
    y,
    vx: rand(-5, 5),
    vy: rand(-34, -20),
    dur: rand(0.9, 1.4),
    tam: rand(3, 5),
    cor: '255,250,240',
    giro: rand(0, 6),
  });
}

function atualizar(s: Estado, dt: number, g: Ganchos) {
  s.relogio += dt;
  const f = s.menos ? 0.35 : 1;

  if (s.fase === 'jogando') {
    s.tempo += dt;
    for (let i = 0; i < 4; i++) {
      const p = s.slots[i];
      p.anim += dt;
      p.pouso += dt;
      if (p.estado === 'espera') {
        p.espera -= dt;
        if (p.espera <= 0) {
          p.estado = 'entrando';
          p.anim = 0;
        }
      } else if (p.estado === 'entrando') {
        if (p.anim >= ENTRADA) {
          p.estado = 'assando';
          p.anim = 0;
          p.pouso = 0;
          // nuvenzinha de farinha ao pousar
          for (let k = 0; k < Math.round(4 * f); k++) {
            emitir(s, {
              tipo: 'vapor',
              x: SLOT_X[i] + rand(-22, 22),
              y: BASE_Y - 2,
              vx: rand(-20, 20),
              vy: rand(-16, -6),
              dur: rand(0.4, 0.7),
              tam: rand(2, 3.5),
              cor: '250,244,230',
            });
          }
        }
      } else if (p.estado === 'assando') {
        p.c += p.vel * dt;
        if (p.c >= QUEIMA) {
          p.c = QUEIMA;
          p.estado = 'carvao';
          p.anim = 0;
          for (let k = 0; k < Math.round(10 * f); k++) fumaca(s, SLOT_X[i], BASE_Y - 16, true);
          texto(s, SLOT_X[i], 152, 'Queimou!', COR.rosa, 19, true);
          perderVida(s, g);
        }
      } else if (p.estado === 'carvao') {
        if (p.anim >= 1.1) {
          for (let k = 0; k < Math.round(8 * f); k++) {
            emitir(s, {
              tipo: 'migalha',
              x: SLOT_X[i] + rand(-20, 20),
              y: BASE_Y - rand(2, 12),
              vx: rand(-40, 40),
              vy: rand(-60, -10),
              dur: rand(0.5, 0.9),
              tam: rand(1.5, 3),
              cor: '30,22,16',
              giro: rand(0, 3),
            });
          }
          novaMassa(s, i);
        }
      }
    }
  } else if (s.fase === 'fim') {
    s.fimT += dt;
  }

  // fumaça contínua dos pães passados do ponto
  for (let i = 0; i < 4; i++) {
    const p = s.slots[i];
    let taxa = 0;
    if (p.estado === 'assando') {
      const lim = P + p.w + p.gD;
      if (p.c > lim) taxa = 5 + 30 * clamp01((p.c - lim) / (QUEIMA - lim));
    } else if (p.estado === 'carvao') taxa = 26;
    if (Math.random() < taxa * f * dt) fumaca(s, SLOT_X[i], BASE_Y - 16, p.estado === 'carvao');
  }

  // brasas subindo da lenha
  if (s.fase !== 'fim' && Math.random() < 2.6 * f * dt) {
    const lado = Math.random() < 0.5 ? 82 : 408;
    emitir(s, {
      tipo: 'brasa',
      x: lado + rand(-8, 8),
      y: PISO - 14,
      vx: rand(-10, 10),
      vy: rand(-55, -30),
      dur: rand(0.9, 1.7),
      tam: rand(0.8, 1.6),
      cor: '255,170,70',
      giro: rand(0, 6),
    });
  }

  // partículas
  let n = 0;
  for (const q of s.parts) {
    q.t += dt;
    if (q.t >= q.dur) continue;
    if (q.tipo === 'fumaca') {
      q.vx += 5 * dt;
      q.vy *= 1 - 0.25 * dt;
    } else if (q.tipo === 'faisca') {
      q.vy += 240 * dt;
      q.vx *= 1 - 1.5 * dt;
    } else if (q.tipo === 'migalha') {
      q.vy += 520 * dt;
      q.giro += q.vx * 0.05 * dt;
    } else if (q.tipo === 'vapor') {
      q.x += Math.sin(q.t * 5 + q.giro) * 10 * dt;
    } else if (q.tipo === 'brasa') {
      q.x += Math.sin(q.t * 7 + q.giro) * 14 * dt;
    }
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    s.parts[n++] = q;
  }
  s.parts.length = n;

  s.voando = s.voando.filter((v) => (v.t += dt) < 0.6);
  s.textos = s.textos.filter((t) => (t.t += dt) < t.atraso + t.dur);
  for (let k = 0; k < 3; k++) if (s.perdaT[k] >= 0) s.perdaT[k] += dt;
  for (let k = 0; k < 4; k++) s.flash[k] = Math.max(0, s.flash[k] - dt);
  s.tremor = Math.max(0, s.tremor - dt);
  s.pontosPop += dt;
}

// ───────────────────────── desenho: cenário fixo ─────────────────────────

function pedra(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#DFD1B4');
  g.addColorStop(1, '#BCA884');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x, y, w, 1);
  ctx.strokeStyle = 'rgba(78,49,34,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function desenharFundo(ctx: CanvasRenderingContext2D) {
  const W = LARGURA;
  const H = ALTURA;

  // parede de azulejo creme
  let g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#F8F4EB');
  g.addColorStop(1, '#EAE2D2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  for (let y = 0, row = 0; y < 240; y += 16, row++) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    for (let x = row % 2 ? 0 : 16; x < W; x += 32) {
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + 16);
    }
  }
  ctx.strokeStyle = 'rgba(23,21,15,0.05)';
  ctx.lineWidth = 1;
  ctx.stroke();
  g = ctx.createRadialGradient(245, 160, 20, 245, 160, 330);
  g.addColorStop(0, 'rgba(236,150,70,0.16)');
  g.addColorStop(1, 'rgba(236,150,70,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // balcão de madeira
  g = ctx.createLinearGradient(0, 240, 0, 250);
  g.addColorStop(0, '#DCC197');
  g.addColorStop(1, '#C7A271');
  ctx.fillStyle = g;
  ctx.fillRect(0, 240, W, 10);
  g = ctx.createLinearGradient(0, 250, 0, H);
  g.addColorStop(0, '#9F7448');
  g.addColorStop(1, '#6E4A2B');
  ctx.fillStyle = g;
  ctx.fillRect(0, 250, W, H - 250);
  ctx.fillStyle = 'rgba(255,240,210,0.55)';
  ctx.fillRect(0, 240, W, 1);
  ctx.fillStyle = 'rgba(40,22,8,0.35)';
  ctx.fillRect(0, 250, W, 1.2);
  ctx.strokeStyle = 'rgba(50,28,10,0.16)';
  for (let k = 0; k < 5; k++) {
    const y0 = 256 + k * 5.2;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y0 + Math.sin(x * 0.03 + k * 1.7) * 1.4);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(40,22,8,0.22)';
  for (const x of [140, 330, 470]) ctx.fillRect(x, 251, 1, H - 251);

  // sombra do forno no balcão
  ctx.save();
  ctx.translate(245, 246);
  ctx.scale(1, 0.045);
  g = ctx.createRadialGradient(0, 0, 0, 0, 0, 260);
  g.addColorStop(0, 'rgba(35,18,6,0.5)');
  g.addColorStop(1, 'rgba(35,18,6,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-270, -270, 540, 540);
  ctx.restore();

  // corpo de tijolos
  ctx.save();
  ctx.shadowColor = 'rgba(23,21,15,0.35)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 6;
  rr(ctx, 20, 14, 450, 232, [16, 16, 3, 3]);
  ctx.fillStyle = '#6B4631';
  ctx.fill();
  ctx.restore();

  ctx.save();
  rr(ctx, 20, 14, 450, 232, [16, 16, 3, 3]);
  ctx.clip();
  const sorte = semente(7);
  for (let row = 0; row * 13 < 236; row++) {
    const y = 14 + row * 13;
    const off = row % 2 ? 0 : -17;
    for (let x = 20 + off; x < 470; x += 34) {
      ctx.fillStyle = TIJOLOS[Math.floor(sorte() * TIJOLOS.length)];
      ctx.fillRect(x + 1, y + 1, 32, 11);
      ctx.fillStyle = 'rgba(255,222,186,0.13)';
      ctx.fillRect(x + 1, y + 1, 32, 1.2);
      ctx.fillStyle = 'rgba(30,14,6,0.16)';
      ctx.fillRect(x + 1, y + 10.8, 32, 1.2);
      if (sorte() < 0.25) {
        ctx.fillStyle = 'rgba(30,14,6,0.12)';
        ctx.fillRect(x + 4 + sorte() * 22, y + 3 + sorte() * 5, 3, 2);
      }
    }
  }
  // fuligem acima da boca
  ctx.save();
  ctx.translate(BOCA_CX, 40);
  ctx.scale(1, 0.45);
  g = ctx.createRadialGradient(0, 0, 0, 0, 0, 150);
  g.addColorStop(0, 'rgba(28,16,10,0.5)');
  g.addColorStop(1, 'rgba(28,16,10,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-160, -160, 320, 320);
  ctx.restore();
  g = ctx.createRadialGradient(245, 150, 110, 245, 150, 320);
  g.addColorStop(0, 'rgba(20,10,5,0)');
  g.addColorStop(1, 'rgba(20,10,5,0.42)');
  ctx.fillStyle = g;
  ctx.fillRect(20, 14, 450, 232);
  ctx.restore();

  // cornija de pedra
  rr(ctx, 12, 8, 466, 13, 4);
  g = ctx.createLinearGradient(0, 8, 0, 21);
  g.addColorStop(0, '#E8DDC5');
  g.addColorStop(1, '#B6A47F');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,45,25,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(16, 9, 458, 1);
  ctx.fillStyle = 'rgba(20,10,5,0.25)';
  ctx.fillRect(20, 21, 450, 2);

  // rodapé
  rr(ctx, 16, 239, 458, 8, 2);
  g = ctx.createLinearGradient(0, 239, 0, 247);
  g.addColorStop(0, '#C8B58F');
  g.addColorStop(1, '#8F7D5C');
  ctx.fillStyle = g;
  ctx.fill();

  // ombreiras de pedra
  const blocos = [118, 141, 164, 187, PISO];
  for (let k = 0; k < 4; k++) {
    const y = blocos[k];
    const h = blocos[k + 1] - y;
    const larg = k % 2 ? 24 : 18;
    pedra(ctx, BOCA_ESQ - larg, y, larg, h);
    pedra(ctx, BOCA_DIR, y, k % 2 ? 18 : 24, h);
  }

  // aduelas do arco
  const N = 15;
  for (let k = 0; k < N; k++) {
    const a0 = Math.PI + (k * Math.PI) / N;
    const a1 = Math.PI + ((k + 1) * Math.PI) / N;
    const chave = k === 7;
    const ro = chave ? 26 : 18;
    ctx.beginPath();
    ctx.ellipse(BOCA_CX, BOCA_Y, BOCA_RX + ro, BOCA_RY + ro, 0, a0, a1, false);
    ctx.ellipse(BOCA_CX, BOCA_Y, BOCA_RX, BOCA_RY, 0, a1, a0, true);
    ctx.closePath();
    if (chave) {
      g = ctx.createLinearGradient(0, BOCA_Y - BOCA_RY - ro, 0, BOCA_Y - BOCA_RY);
      g.addColorStop(0, '#EDE2C9');
      g.addColorStop(1, '#C3AF88');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = k % 2 ? '#A9683F' : '#9A5B37';
    }
    ctx.fill();
    ctx.strokeStyle = '#4E3122';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  // detalhe dourado na pedra-chave
  ctx.beginPath();
  ctx.arc(BOCA_CX, BOCA_Y - BOCA_RY - 12, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = COR.dourado;
  ctx.fill();
  ctx.strokeStyle = COR.douradoTexto;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // boca (o interior vivo é desenhado por cima a cada quadro)
  caminhoBoca(ctx);
  ctx.fillStyle = '#1C0A04';
  ctx.fill();

  // soleira
  rr(ctx, 38, 207, 414, 13, 3);
  g = ctx.createLinearGradient(0, 207, 0, 220);
  g.addColorStop(0, '#EADFC6');
  g.addColorStop(0.35, '#D3C3A2');
  g.addColorStop(1, '#AE9C7A');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,45,25,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillRect(41, 207.5, 408, 1);
  g = ctx.createLinearGradient(0, 220, 0, 227);
  g.addColorStop(0, 'rgba(20,10,5,0.35)');
  g.addColorStop(1, 'rgba(20,10,5,0)');
  ctx.fillStyle = g;
  ctx.fillRect(40, 220, 410, 7);

  // plaquinhas 1–4
  for (let i = 0; i < 4; i++) {
    const x = SLOT_X[i];
    rr(ctx, x - 11, 224, 22, 14, 4);
    g = ctx.createLinearGradient(0, 224, 0, 238);
    g.addColorStop(0, '#F5E2A0');
    g.addColorStop(1, COR.dourado);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = COR.douradoTexto;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = COR.tinta;
    ctx.font = `600 10px ${FONTE}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, 231.5);
  }

  // termômetro (parte fixa)
  ctx.save();
  ctx.shadowColor = 'rgba(23,21,15,0.18)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  rr(ctx, 492, 74, 46, 162, 10);
  g = ctx.createLinearGradient(492, 0, 538, 0);
  g.addColorStop(0, '#FDFBF6');
  g.addColorStop(1, '#ECE5D6');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  rr(ctx, 492, 74, 46, 162, 10);
  ctx.strokeStyle = COR.borda;
  ctx.lineWidth = 1;
  ctx.stroke();
  rr(ctx, 495, 77, 40, 156, 8);
  ctx.strokeStyle = 'rgba(201,162,39,0.35)';
  ctx.stroke();
  ctx.fillStyle = COR.texto3;
  ctx.font = `600 8px ${FONTE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('°C', 515, 85);
  rr(ctx, 510, 92, 10, 122, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,110,95,0.5)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(515, 220, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(94,89,79,0.55)';
  ctx.beginPath();
  for (let v = 0; v <= 10; v++) {
    const y = 204 - v * 10.6 + 0.5;
    ctx.moveTo(523, y);
    ctx.lineTo(v % 5 === 0 ? 531 : 527, y);
  }
  ctx.stroke();
  ctx.fillStyle = COR.texto3;
  ctx.font = `8px ${FONTE}`;
  ctx.textAlign = 'right';
  ctx.fillText('100', 508.5, 204);
  ctx.fillText('200', 508.5, 151);
  ctx.fillText('300', 508.5, 98);
}

function criarFundo(): HTMLCanvasElement {
  const off = document.createElement('canvas');
  const c = prepararCanvas(off);
  if (c) desenharFundo(c);
  return off;
}

// ───────────────────────── desenho: pães ─────────────────────────

function caminhoCorpo(ctx: CanvasRenderingContext2D, tipo: number) {
  ctx.beginPath();
  if (tipo === 0) {
    ctx.moveTo(-28, -1);
    ctx.bezierCurveTo(-31, -15, -17, -26, 0, -26);
    ctx.bezierCurveTo(17, -26, 31, -15, 28, -1);
    ctx.quadraticCurveTo(0, 2, -28, -1);
  } else if (tipo === 1) {
    ctx.moveTo(-38, -1);
    ctx.bezierCurveTo(-41, -11, -33, -18, -23, -18);
    ctx.lineTo(23, -18);
    ctx.bezierCurveTo(33, -18, 41, -11, 38, -1);
    ctx.quadraticCurveTo(0, 2, -38, -1);
  } else if (tipo === 2) {
    ctx.moveTo(-22, -1);
    ctx.bezierCurveTo(-25, -22, -12, -31, 0, -31);
    ctx.bezierCurveTo(12, -31, 25, -22, 22, -1);
    ctx.quadraticCurveTo(0, 2, -22, -1);
  } else {
    for (const [bx, r] of QUEIJO) {
      ctx.moveTo(bx + r, -r);
      ctx.arc(bx, -r, r, 0, Math.PI * 2);
    }
  }
}

function estrela(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

function desenharPao(
  ctx: CanvasRenderingContext2D,
  tipo: number,
  x: number,
  y: number,
  c: number,
  sx: number,
  sy: number,
  brilho: number,
  rel: number,
  sombra = true,
) {
  const base = corCrosta(c, tipo);
  const queimado = clamp01((c - 0.7) / 0.2);
  const claro = misturar(base, [255, 243, 214], 0.38 * (1 - queimado));
  const escuro = misturar(base, [20, 12, 6], 0.32);
  const miolo = misturar(base, [246, 231, 196], 0.55 * (1 - clamp01((c - 0.72) / 0.18)));
  const h = tipo === 1 ? 18 : tipo === 2 ? 31 : 26;

  ctx.save();
  ctx.translate(x, y);
  if (sombra) {
    ctx.fillStyle = 'rgba(10,5,2,0.42)';
    ctx.beginPath();
    ctx.ellipse(0, 0.5, LARG[tipo] * 0.5 * sx, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.scale(sx, sy);

  if (tipo === 3) {
    // pão de queijo: três bolinhas, a do meio na frente
    for (const [bx, r] of QUEIJO) {
      const g = ctx.createRadialGradient(bx - r * 0.35, -r * 1.4, 1, bx, -r, r * 1.05);
      g.addColorStop(0, rgba(claro));
      g.addColorStop(0.6, rgba(base));
      g.addColorStop(1, rgba(escuro));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, -r, r, 0, Math.PI * 2);
      ctx.fill();
      const k = r / 13;
      ctx.fillStyle = rgba(escuro, 0.35);
      for (const [dx, dy] of [
        [-4, -4],
        [3, -7],
        [5, -2],
        [-2, 2],
        [1, -9],
      ]) {
        ctx.beginPath();
        ctx.arc(bx + dx * k, -r + dy * k, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,244,205,0.45)';
      for (const [dx, dy] of [
        [-6, -1],
        [2, -4],
        [6, 3],
      ]) {
        ctx.beginPath();
        ctx.arc(bx + dx * k, -r + dy * k, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // rachadinha no topo
    ctx.strokeStyle = rgba(escuro, 0.55);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-4, -24.5);
    ctx.quadraticCurveTo(0, -22.5, 4, -24.8);
    ctx.stroke();
  } else {
    const g = ctx.createLinearGradient(0, -h, 0, 0);
    g.addColorStop(0, rgba(claro));
    g.addColorStop(0.55, rgba(base));
    g.addColorStop(1, rgba(escuro));
    caminhoCorpo(ctx, tipo);
    ctx.fillStyle = g;
    ctx.fill();

    if (tipo === 0) {
      // pestana do pão francês
      ctx.beginPath();
      ctx.moveTo(-19, -14);
      ctx.quadraticCurveTo(-2, -27, 20, -19);
      ctx.quadraticCurveTo(0, -20.5, -19, -14);
      ctx.fillStyle = rgba(miolo);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-19, -14);
      ctx.quadraticCurveTo(-2, -27, 20, -19);
      ctx.strokeStyle = rgba(escuro, 0.7);
      ctx.lineWidth = 0.9;
      ctx.stroke();
    } else if (tipo === 1) {
      // cortes da baguete
      for (const xc of [-24, -8, 8, 24]) {
        ctx.beginPath();
        ctx.moveTo(xc - 8, -9);
        ctx.quadraticCurveTo(xc - 1, -17.5, xc + 8, -15.5);
        ctx.quadraticCurveTo(xc, -12.5, xc - 8, -9);
        ctx.fillStyle = rgba(miolo);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(xc - 8, -9);
        ctx.quadraticCurveTo(xc - 1, -17.5, xc + 8, -15.5);
        ctx.strokeStyle = rgba(escuro, 0.65);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    } else {
      // sonho: cinturinha clara e açúcar
      ctx.save();
      caminhoCorpo(ctx, 2);
      ctx.clip();
      ctx.fillStyle = rgba(misturar(base, [248, 236, 210], 0.6 * (1 - queimado)), 0.9);
      ctx.fillRect(-30, -11, 60, 4.5);
      ctx.restore();
      ctx.fillStyle = 'rgba(255,253,248,0.85)';
      for (const [dx, dy, r] of [
        [-8, -25, 1.1],
        [-2, -28.5, 1],
        [5, -26, 1.2],
        [10, -22, 0.9],
        [-12, -20, 0.9],
        [1, -23, 1],
        [7, -29, 0.8],
        [-5, -21.5, 0.8],
        [-14, -15, 0.7],
        [14, -16, 0.8],
      ]) {
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // reflexo quente do forno no topo
    ctx.save();
    caminhoCorpo(ctx, tipo);
    ctx.clip();
    const rg = ctx.createRadialGradient(-LARG[tipo] * 0.18, -h * 0.85, 1, -LARG[tipo] * 0.18, -h * 0.85, LARG[tipo] * 0.45);
    rg.addColorStop(0, `rgba(255,236,200,${0.28 * (1 - queimado * 0.7)})`);
    rg.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(-45, -40, 90, 42);
    ctx.restore();
  }

  // brasinhas no pão virando carvão
  if (c >= QUEIMA) {
    ctx.fillStyle = `rgba(255,120,40,${0.35 + 0.3 * Math.sin(rel * 9)})`;
    for (const [dx, dy] of [
      [-8, -8],
      [6, -12],
      [12, -5],
    ]) {
      ctx.beginPath();
      ctx.arc(dx, dy, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // brilho de "no ponto"
  if (brilho > 0) {
    ctx.save();
    caminhoCorpo(ctx, tipo);
    ctx.clip();
    const fx = ((rel * 70) % 140) - 70;
    const lg = ctx.createLinearGradient(fx - 16, -30, fx + 16, 0);
    lg.addColorStop(0, 'rgba(255,250,230,0)');
    lg.addColorStop(0.5, `rgba(255,250,230,${0.5 * brilho})`);
    lg.addColorStop(1, 'rgba(255,250,230,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(-45, -40, 90, 42);
    ctx.restore();
    ctx.fillStyle = `rgba(255,248,220,${0.9 * brilho})`;
    const t1 = 0.5 + 0.5 * Math.sin(rel * 8);
    const t2 = 0.5 + 0.5 * Math.sin(rel * 8 + 2.2);
    estrela(ctx, -LARG[tipo] * 0.28, -h * 0.8, 3.5 * t1 * brilho + 0.5);
    estrela(ctx, LARG[tipo] * 0.3, -h * 0.55, 2.8 * t2 * brilho + 0.5);
  }
  ctx.restore();
}

function medidor(ctx: CanvasRenderingContext2D, x: number, y: number, p: Slot, rel: number) {
  const r = 7;
  const a0 = -Math.PI / 2;
  const ang = (v: number) => a0 + (clamp01(v / QUEIMA) * Math.PI * 2);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = 'rgba(255,236,210,0.16)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(240,210,122,0.35)';
  ctx.beginPath();
  ctx.arc(x, y, r, ang(P - p.w - p.gA), ang(P + p.w + p.gD));
  ctx.stroke();
  ctx.strokeStyle = COR.douradoClaro;
  ctx.beginPath();
  ctx.arc(x, y, r, ang(P - p.w), ang(P + p.w));
  ctx.stroke();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(x, y, r - 2.6, a0, ang(p.c));
  ctx.stroke();
  const an = ang(p.c);
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(x + Math.cos(an) * r, y + Math.sin(an) * r, 1.9, 0, Math.PI * 2);
  ctx.fill();
  if (noPonto(p)) {
    const pulso = 0.6 + 0.4 * Math.sin(rel * 12);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
    g.addColorStop(0, `rgba(240,210,122,${0.7 * pulso})`);
    g.addColorStop(1, 'rgba(240,210,122,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ───────────────────────── desenho: interior vivo ─────────────────────────

function lenha(ctx: CanvasRenderingContext2D, x: number, y: number, rel: number) {
  for (const [dx, rot] of [
    [-4, -0.18],
    [5, 0.22],
  ]) {
    ctx.save();
    ctx.translate(x + dx, y);
    ctx.rotate(rot);
    rr(ctx, -15, -4, 30, 8, 4);
    ctx.fillStyle = '#2A160C';
    ctx.fill();
    ctx.strokeStyle = `rgba(255,140,50,${0.45 + 0.2 * Math.sin(rel * 5 + dx)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-12, -3.5);
    ctx.lineTo(12, -3.5);
    ctx.stroke();
    ctx.restore();
  }
}

function chamas(ctx: CanvasRenderingContext2D, cx: number, base: number, rel: number, semente: number) {
  for (let k = 0; k < 3; k++) {
    const x = cx + (k - 1) * 8;
    const alt = 26 + 9 * Math.sin(rel * 9 + k * 2.1 + semente) + 5 * Math.sin(rel * 15.3 + k + semente);
    const w = 7 - Math.abs(k - 1) * 2;
    const bal = 3 * Math.sin(rel * 6 + k + semente);
    const g = ctx.createLinearGradient(0, base, 0, base - alt);
    g.addColorStop(0, 'rgba(255,240,180,0.85)');
    g.addColorStop(0.45, 'rgba(255,150,40,0.55)');
    g.addColorStop(1, 'rgba(200,60,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w, base);
    ctx.quadraticCurveTo(x - w * 0.8 + bal, base - alt * 0.55, x + bal, base - alt);
    ctx.quadraticCurveTo(x + w * 0.8 + bal * 0.5, base - alt * 0.5, x + w, base);
    ctx.closePath();
    ctx.fill();
  }
}

function desenharInterior(ctx: CanvasRenderingContext2D, s: Estado) {
  const rel = s.relogio;
  const fl = 0.92 + 0.05 * Math.sin(rel * 7.3) + 0.03 * Math.sin(rel * 12.7 + 1.3);

  ctx.save();
  caminhoBoca(ctx);
  ctx.clip();

  let g = ctx.createRadialGradient(BOCA_CX, 205, 8, BOCA_CX, 190, 250);
  g.addColorStop(0, '#FFC979');
  g.addColorStop(0.22, '#F49A3C');
  g.addColorStop(0.5, '#B9461A');
  g.addColorStop(0.8, '#4E1A0A');
  g.addColorStop(1, '#1C0A04');
  ctx.fillStyle = g;
  ctx.fillRect(BOCA_ESQ, 40, BOCA_RX * 2, PISO - 40);

  // tijolos refratários do fundo
  ctx.beginPath();
  for (let y = 52, row = 0; y < PISO; y += 12, row++) {
    ctx.moveTo(BOCA_ESQ, y + 0.5);
    ctx.lineTo(BOCA_DIR, y + 0.5);
    for (let x = BOCA_ESQ + (row % 2 ? 0 : 14); x < BOCA_DIR; x += 28) {
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + 12);
    }
  }
  ctx.strokeStyle = 'rgba(40,12,4,0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // fuligem na abóbada
  g = ctx.createLinearGradient(0, 46, 0, 132);
  g.addColorStop(0, 'rgba(20,8,3,0.7)');
  g.addColorStop(1, 'rgba(20,8,3,0)');
  ctx.fillStyle = g;
  ctx.fillRect(BOCA_ESQ, 40, BOCA_RX * 2, 92);

  lenha(ctx, 82, PISO - 9, rel);
  lenha(ctx, 408, PISO - 9, rel);

  ctx.globalCompositeOperation = 'lighter';
  chamas(ctx, 82, PISO - 9, rel, 0);
  chamas(ctx, 408, PISO - 9, rel, 3.7);
  for (const q of s.parts) {
    if (q.tipo !== 'brasa') continue;
    const a = 1 - q.t / q.dur;
    ctx.fillStyle = `rgba(${q.cor},${a * (0.6 + 0.4 * Math.sin(q.t * 20 + q.giro))})`;
    ctx.beginPath();
    ctx.arc(q.x, q.y, q.tam, 0, Math.PI * 2);
    ctx.fill();
  }
  g = ctx.createRadialGradient(BOCA_CX, 195, 0, BOCA_CX, 195, 200);
  g.addColorStop(0, `rgba(255,150,60,${0.22 * fl})`);
  g.addColorStop(1, 'rgba(255,150,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(BOCA_ESQ, 40, BOCA_RX * 2, PISO - 40);

  // ondulação de calor
  const amp = s.menos ? 1.2 : 3;
  ctx.strokeStyle = 'rgba(255,230,190,0.06)';
  ctx.lineWidth = 5;
  for (let k = 0; k < 6; k++) {
    const x0 = 90 + k * 64 + Math.sin(rel * 0.6 + k * 1.7) * 12;
    ctx.beginPath();
    for (let y = 190; y >= 56; y -= 6) {
      const x = x0 + Math.sin(y * 0.07 + rel * 3.2 + k) * amp;
      if (y === 190) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  // lastro e assadeira
  g = ctx.createLinearGradient(0, 199, 0, PISO);
  g.addColorStop(0, '#6A2E14');
  g.addColorStop(1, '#2A1208');
  ctx.fillStyle = g;
  ctx.fillRect(BOCA_ESQ, 199, BOCA_RX * 2, PISO - 199);
  ctx.fillStyle = 'rgba(255,180,110,0.3)';
  ctx.fillRect(BOCA_ESQ, 199, BOCA_RX * 2, 1);
  g = ctx.createLinearGradient(0, 194, 0, 200);
  g.addColorStop(0, '#7A6C60');
  g.addColorStop(1, '#2E2722');
  ctx.fillStyle = g;
  ctx.fillRect(70, 194.5, 350, 5);
  ctx.fillStyle = `rgba(255,210,160,${0.45 + 0.1 * fl})`;
  ctx.fillRect(70, 194.5, 350, 0.9);
  ctx.fillStyle = '#3A322C';
  ctx.fillRect(68, 189, 3, 10.5);
  ctx.fillRect(419, 189, 3, 10.5);

  // pães
  for (let i = 0; i < 4; i++) {
    const p = s.slots[i];
    const x = SLOT_X[i];
    if (p.estado === 'vazio' || p.estado === 'espera') continue;

    if (s.fase === 'jogando' && s.hover === i) {
      ctx.globalCompositeOperation = 'lighter';
      g = ctx.createRadialGradient(x, BASE_Y, 0, x, BASE_Y, 44);
      g.addColorStop(0, 'rgba(255,236,190,0.22)');
      g.addColorStop(1, 'rgba(255,236,190,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 46, BASE_Y - 46, 92, 60);
      ctx.globalCompositeOperation = 'source-over';
    }

    const cres = 0.86 + 0.14 * clamp01(p.c / 0.45);
    let yOff = 0;
    let sx = 1;
    let sy = 1;
    if (p.estado === 'entrando') {
      const a = clamp01(p.anim / ENTRADA);
      yOff = -36 * (1 - a * a);
      sx = 0.9;
      sy = 1.12;
    } else {
      const sq = 0.17 * Math.sin(p.pouso * 22) * Math.exp(-p.pouso * 7);
      sx = 1 + sq;
      sy = 1 - sq;
    }
    if (p.estado === 'carvao') {
      const a = clamp01(p.anim / 1.1);
      sy *= 1 - 0.14 * a;
      sx *= 1 + 0.04 * a;
    }
    const perfeito = noPonto(p);
    const pulso = 0.75 + 0.25 * Math.sin(rel * 10);
    if (perfeito) {
      ctx.globalCompositeOperation = 'lighter';
      g = ctx.createRadialGradient(x, BASE_Y - 14, 0, x, BASE_Y - 14, 46);
      g.addColorStop(0, `rgba(255,214,120,${0.38 * pulso})`);
      g.addColorStop(1, 'rgba(255,214,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 48, BASE_Y - 62, 96, 70);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(240,210,122,${0.55 * pulso})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(x, BASE_Y + 1, LARG[p.tipo] * 0.5 + 8, 4.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    desenharPao(ctx, p.tipo, x, BASE_Y + yOff, p.estado === 'carvao' ? 1 : p.c, sx * cres, sy * cres, perfeito ? pulso : 0, rel);
    if (p.estado === 'assando') medidor(ctx, x, MEDIDOR_Y, p, rel);
  }

  // sombra interna da borda da boca
  ctx.beginPath();
  ctx.moveTo(BOCA_ESQ, PISO);
  ctx.lineTo(BOCA_ESQ, BOCA_Y);
  ctx.ellipse(BOCA_CX, BOCA_Y, BOCA_RX, BOCA_RY, 0, Math.PI, Math.PI * 2);
  ctx.lineTo(BOCA_DIR, PISO);
  ctx.strokeStyle = 'rgba(10,4,2,0.4)';
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.restore();

  // calor iluminando a fachada
  ctx.save();
  rr(ctx, 20, 14, 450, 232, [16, 16, 3, 3]);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  g = ctx.createRadialGradient(BOCA_CX, 200, 40, BOCA_CX, 200, 270);
  g.addColorStop(0, `rgba(255,140,60,${0.14 * fl})`);
  g.addColorStop(1, 'rgba(255,140,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(20, 14, 450, 232);
  ctx.restore();
}

// ───────────────────────── desenho: quadro completo ─────────────────────────

function textoContorno(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, cor: string) {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(252,251,248,0.94)';
  ctx.lineWidth = 4;
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = cor;
  ctx.fillText(txt, x, y);
}

function painel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.shadowColor = 'rgba(23,21,15,0.28)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  rr(ctx, x, y, w, h, 14);
  ctx.fillStyle = 'rgba(252,251,248,0.97)';
  ctx.fill();
  ctx.restore();
  rr(ctx, x, y, w, h, 14);
  ctx.strokeStyle = COR.borda;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = COR.dourado;
  ctx.fillRect(x + w / 2 - 18, y, 36, 2);
}

function desenhar(ctx: CanvasRenderingContext2D, fundo: HTMLCanvasElement, s: Estado) {
  const rel = s.relogio;
  ctx.fillStyle = COR.papel;
  ctx.fillRect(0, 0, LARGURA, ALTURA);
  ctx.save();
  if (s.tremor > 0 && !s.menos) {
    const k = (s.tremor / 0.35) * 4;
    ctx.translate((Math.random() - 0.5) * 2 * k, (Math.random() - 0.5) * 2 * k);
  }
  ctx.drawImage(fundo, 0, 0, LARGURA, ALTURA);
  desenharInterior(ctx, s);

  // partículas por cima da fachada
  for (const q of s.parts) {
    const p = q.t / q.dur;
    if (q.tipo === 'fumaca') {
      const r = q.tam * (0.6 + 1.8 * p);
      const a = 0.34 * (p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85);
      const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
      g.addColorStop(0, `rgba(${q.cor},${a})`);
      g.addColorStop(1, `rgba(${q.cor},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (q.tipo === 'vapor') {
      const r = q.tam * (0.7 + 1.5 * p);
      const a = 0.4 * (p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8);
      const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
      g.addColorStop(0, `rgba(${q.cor},${a})`);
      g.addColorStop(1, `rgba(${q.cor},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (q.tipo === 'faisca') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(${q.cor},${1 - p})`;
      ctx.lineWidth = q.tam;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - q.vx * 0.035, q.y - q.vy * 0.035);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    } else if (q.tipo === 'migalha') {
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.giro);
      ctx.fillStyle = `rgba(${q.cor},${p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1})`;
      ctx.fillRect(-q.tam / 2, -q.tam / 2, q.tam, q.tam * 0.75);
      ctx.restore();
    }
  }

  // pães saindo do forno em direção a quem joga
  for (const v of s.voando) {
    const p = v.t / 0.6;
    const yOff = -38 * easeOutCubic(Math.min(1, p / 0.4)) + 190 * Math.pow(Math.max(0, (p - 0.35) / 0.65), 2);
    const esc = 1 + 0.5 * p;
    const sq = 0.14 * Math.sin(p * Math.PI * 3) * (1 - p);
    ctx.save();
    ctx.globalAlpha = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
    ctx.translate(v.x + v.dir * 30 * p, v.y + yOff);
    ctx.rotate(v.dir * 0.5 * p * p);
    desenharPao(ctx, v.tipo, 0, 0, v.c, esc * (1 + sq), esc * (1 - sq), 0, rel, false);
    ctx.restore();
  }

  // plaquinhas acesas (passar o mouse / tecla)
  for (let i = 0; i < 4; i++) {
    const brilho = Math.max(s.flash[i] / 0.25, s.fase === 'jogando' && s.hover === i ? 0.45 : 0);
    if (brilho <= 0) continue;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    rr(ctx, SLOT_X[i] - 11, 224, 22, 14, 4);
    ctx.fillStyle = `rgba(255,240,190,${0.5 * brilho})`;
    ctx.fill();
    ctx.restore();
  }

  // pontos, vidas e termômetro (coluna direita)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COR.texto3;
  ctx.font = `600 8px ${FONTE}`;
  ctx.fillText('PONTOS', 515, 16);
  const pop = s.pontosPop < 0.3 ? 1 + 0.28 * (1 - easeOutCubic(s.pontosPop / 0.3)) : 1;
  ctx.save();
  ctx.translate(515, 36);
  ctx.scale(pop, pop);
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `600 22px ${FONTE_SERIFA}`;
  ctx.fillText(String(s.pontos), 0, 0);
  ctx.restore();
  for (let k = 0; k < 3; k++) {
    const x = 497 + k * 18;
    const y = 64;
    if (k < s.vidas) {
      desenharPao(ctx, 0, x, y, P, 0.3, 0.3, 0, rel, false);
    } else {
      ctx.save();
      ctx.globalAlpha = 0.2;
      desenharPao(ctx, 0, x, y, P, 0.3, 0.3, 0, rel, false);
      ctx.restore();
      const t = s.perdaT[k];
      if (t >= 0 && t < 0.5) {
        const e = 0.3 * (1 + 0.8 * easeOutCubic(t / 0.5));
        ctx.save();
        ctx.globalAlpha = 1 - t / 0.5;
        desenharPao(ctx, 0, x, y - 10 * t, QUEIMA, e, e, 0, rel, false);
        ctx.restore();
      }
    }
  }
  const nivel =
    s.fase === 'pronto'
      ? 0.55 + 0.02 * Math.sin(rel * 2)
      : 0.5 + 0.3 * dific(s) + 0.025 * Math.sin(rel * 2.3) + 0.012 * Math.sin(rel * 7);
  const topo = 204 - nivel * 106;
  const mg = ctx.createLinearGradient(0, topo, 0, 220);
  mg.addColorStop(0, '#EA580C');
  mg.addColorStop(1, COR.ambar);
  ctx.fillStyle = mg;
  rr(ctx, 512.5, topo, 5, 220 - topo, 2.5);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(515, 220, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(511.6, 96, 1, 108);
  ctx.beginPath();
  ctx.arc(512.5, 217.5, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // textos que surgem ("Perfeito!", "+3"…)
  for (const t of s.textos) {
    const tt = t.t - t.atraso;
    if (tt < 0) continue;
    const a = tt / t.dur;
    const esc = easeOutBack(clamp01(tt / 0.28));
    const sobe = -20 * easeOutCubic(a);
    ctx.save();
    ctx.globalAlpha = a > 0.6 ? 1 - (a - 0.6) / 0.4 : 1;
    ctx.translate(t.x, t.y + sobe);
    ctx.scale(esc, esc);
    ctx.font = t.serifa ? `600 ${t.tam}px ${FONTE_SERIFA}` : `700 ${t.tam}px ${FONTE}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    textoContorno(ctx, t.txt, 0, 0, t.cor);
    ctx.restore();
  }
  ctx.restore();

  if (s.fase === 'pronto') desenharInicio(ctx, s);
  else if (s.fase === 'fim') desenharFim(ctx, s);
}

function desenharInicio(ctx: CanvasRenderingContext2D, s: Estado) {
  const rel = s.relogio;
  ctx.fillStyle = 'rgba(23,21,15,0.3)';
  ctx.fillRect(0, 0, LARGURA, ALTURA);
  const x = 110;
  const y = 50;
  const w = 340;
  const h = 180;
  painel(ctx, x, y, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COR.tinta;
  ctx.font = `600 30px ${FONTE_SERIFA}`;
  ctx.fillText('Tira do Forno', 280, 88);
  ctx.fillStyle = COR.texto2;
  ctx.font = `13px ${FONTE}`;
  ctx.fillText('Tire cada pão quando a crosta ficar dourada.', 280, 114);

  // régua de cor: cru → no ponto → queimou
  const bx = 160;
  const bw = 240;
  const by = 132;
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  for (const [c, cor] of CROSTA) if (c <= QUEIMA) g.addColorStop(c / QUEIMA, rgba(cor));
  rr(ctx, bx, by, bw, 10, 5);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(23,21,15,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const px = bx + (P / QUEIMA) * bw;
  ctx.strokeStyle = COR.douradoClaro;
  ctx.lineWidth = 2;
  rr(ctx, px - 8, by - 2.5, 16, 15, 4);
  ctx.stroke();
  ctx.fillStyle = COR.dourado;
  ctx.beginPath();
  ctx.moveTo(px - 4, by - 8);
  ctx.lineTo(px + 4, by - 8);
  ctx.lineTo(px, by - 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.font = `11px ${FONTE}`;
  ctx.fillStyle = COR.texto3;
  ctx.fillText('cru', bx + (0.16 / QUEIMA) * bw, by + 22);
  ctx.fillText('queimou', bx + (0.84 / QUEIMA) * bw, by + 22);
  ctx.fillStyle = COR.verde;
  ctx.font = `600 11px ${FONTE}`;
  ctx.fillText('no ponto', px, by + 22);

  ctx.fillStyle = COR.texto3;
  ctx.font = `11.5px ${FONTE}`;
  ctx.fillText('Perfeito +3 · Bom +1 · cru ou queimado custa um pãozinho', 280, 180);

  ctx.globalAlpha = 0.65 + 0.35 * Math.sin(rel * 3.2);
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `600 13px ${FONTE}`;
  ctx.fillText('Toque ou aperte Espaço para começar', 280, 207);
  ctx.globalAlpha = 1;
}

function desenharFim(ctx: CanvasRenderingContext2D, s: Estado) {
  const rel = s.relogio;
  const a = easeOutCubic(clamp01(s.fimT / 0.4));
  ctx.fillStyle = `rgba(23,21,15,${0.38 * a})`;
  ctx.fillRect(0, 0, LARGURA, ALTURA);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(0, 12 * (1 - a));
  painel(ctx, 130, 46, 300, 188);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COR.tinta;
  ctx.font = `600 20px ${FONTE_SERIFA}`;
  ctx.fillText('Fornada encerrada', 280, 78);
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `600 48px ${FONTE_SERIFA}`;
  ctx.fillText(String(s.pontos), 280, 124);
  ctx.fillStyle = COR.texto3;
  ctx.font = `12px ${FONTE}`;
  ctx.fillText(s.pontos === 1 ? 'ponto' : 'pontos', 280, 153);
  if (s.novoRecorde) {
    const e = 1 + 0.06 * Math.sin(rel * 6);
    ctx.save();
    ctx.translate(280, 176);
    ctx.scale(e, e);
    ctx.fillStyle = COR.verde;
    ctx.font = `600 15px ${FONTE_SERIFA}`;
    ctx.fillText('Novo recorde!', 0, 0);
    ctx.restore();
  } else {
    ctx.fillStyle = COR.texto2;
    ctx.font = `13px ${FONTE}`;
    ctx.fillText(`Recorde: ${s.recordeFim}`, 280, 176);
  }
  ctx.fillStyle = COR.texto3;
  ctx.font = `11.5px ${FONTE}`;
  const pf = s.perfeitos === 1 ? '1 perfeito' : `${s.perfeitos} perfeitos`;
  const bn = s.bons === 1 ? '1 bom' : `${s.bons} bons`;
  ctx.fillText(`${pf} · ${bn}`, 280, 196);
  if (s.fimT > 0.6) {
    ctx.globalAlpha = a * (0.65 + 0.35 * Math.sin(rel * 3.2));
    ctx.fillStyle = COR.douradoTexto;
    ctx.font = `600 13px ${FONTE}`;
    ctx.fillText('Toque para jogar de novo', 280, 218);
  }
  ctx.restore();
}

// ───────────────────────── componente ─────────────────────────

export default function Forno(props: JogoProps) {
  const { recorde, aoTerminar } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const estadoRef = useRef<Estado | null>(null);
  if (!estadoRef.current) estadoRef.current = criarEstado();
  const [pontos, setPontos] = useState(0);

  const recordeRef = useRef(recorde);
  const aoTerminarRef = useRef(aoTerminar);
  useEffect(() => {
    recordeRef.current = recorde;
    aoTerminarRef.current = aoTerminar;
  }, [recorde, aoTerminar]);

  const ganchosRef = useRef<Ganchos>({
    recorde: () => recordeRef.current,
    aoPontos: (n) => setPontos(n),
    aoFim: (n) => aoTerminarRef.current(n),
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const s = estadoRef.current;
    if (!canvas || !s) return;
    let ctx = prepararCanvas(canvas);
    if (!ctx) return;
    s.menos = prefereMenosMovimento();
    let dpr = window.devicePixelRatio || 1;
    let fundo = criarFundo();
    const g = ganchosRef.current;

    let raf = 0;
    let ultimo = 0;
    const passo = (agora: number) => {
      const dt = ultimo ? Math.min(Math.max(0, (agora - ultimo) / 1000), 1 / 30) : 0;
      ultimo = agora;
      atualizar(s, dt, g);
      if (ctx) desenhar(ctx, fundo, s);
      raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);

    const aoTeclar = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement | null;
      if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && s.fase !== 'jogando') tentarIniciar(s, g);
        return;
      }
      const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
      const n = m ? Number(m[1]) - 1 : /^[1-4]$/.test(e.key) ? Number(e.key) - 1 : -1;
      if (n >= 0) {
        e.preventDefault();
        if (!e.repeat) tirar(s, n, g);
      }
    };
    const aoRedimensionar = () => {
      const novo = window.devicePixelRatio || 1;
      if (novo === dpr) return;
      dpr = novo;
      ctx = prepararCanvas(canvas);
      fundo = criarFundo();
    };
    window.addEventListener('keydown', aoTeclar);
    window.addEventListener('resize', aoRedimensionar);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', aoTeclar);
      window.removeEventListener('resize', aoRedimensionar);
    };
  }, []);

  const aoApontar = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = estadoRef.current;
    const cv = canvasRef.current;
    if (!s || !cv || e.button > 0) return;
    const g = ganchosRef.current;
    if (s.fase !== 'jogando') {
      tentarIniciar(s, g);
      return;
    }
    const { x, y } = pontoNoQuadro(cv, e.clientX, e.clientY);
    const i = slotEm(x, y);
    s.hover = e.pointerType === 'mouse' ? i : -1;
    if (i >= 0) tirar(s, i, g);
  };

  const aoMover = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = estadoRef.current;
    const cv = canvasRef.current;
    if (!s || !cv) return;
    const { x, y } = pontoNoQuadro(cv, e.clientX, e.clientY);
    s.hover = e.pointerType === 'mouse' ? slotEm(x, y) : -1;
    cv.style.cursor = s.fase !== 'jogando' || s.hover >= 0 ? 'pointer' : 'default';
  };

  const aoSair = () => {
    if (estadoRef.current) estadoRef.current.hover = -1;
  };

  return (
    <div className="w-full select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={aoApontar}
        onPointerMove={aoMover}
        onPointerLeave={aoSair}
        role="img"
        aria-label="Jogo Tira do Forno: tire cada pão do forno quando estiver dourado, clicando nele ou usando as teclas 1 a 4."
        className="block aspect-[2/1] w-full touch-none select-none rounded-xl border border-[#E5E0D6]"
      />
      <div className="mt-2 flex items-center justify-between gap-3 text-[13px] text-[#5E594F]">
        <span>Toque no pão (ou aperte 1–4) quando estiver dourado</span>
        <span className="shrink-0">
          Pontos <span className="font-semibold tabular-nums text-[#8A6D0F]">{pontos}</span> · Recorde{' '}
          <span className="font-semibold tabular-nums text-[#8A6D0F]">{Math.max(recorde, pontos)}</span>
        </span>
      </div>
    </div>
  );
}
