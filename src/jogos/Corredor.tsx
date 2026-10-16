// "Pãozinho Corredor" — corrida infinita de um botão. Um pão francês corre por uma rua
// de padaria à noite, pulando carimbos, pilhas de notas e bobinas de cupom, e colhendo trigo.
// Tudo desenhado em canvas 2D; física em passo fixo (1/240 s) para jogar igual em 60/120/144 Hz.

import { useEffect, useRef, useState } from 'react';
import { ALTURA, COR, FONTE, FONTE_SERIFA, LARGURA, prefereMenosMovimento, prepararCanvas } from './tipos';
import type { JogoProps } from './tipos';

// ---------------------------------------------------------------------------
// Constantes do mundo
// ---------------------------------------------------------------------------

const CHAO = 236; // linha da calçada (y lógico)
const PX = 96; // x do centro do pão
const HB_MEIA = 16; // meia largura da caixa de colisão do pão
const GRAV = 2200; // px/s²
const V_PULO = 620; // px/s — pulo curto alcança ~87 px
const SEGURAR_MAX = 0.2; // s em que segurar ainda "alivia" a gravidade
const GRAV_SEGURANDO = 0.42; // pulo segurado alcança ~146 px
const BUFFER_PULO = 0.12; // s de tolerância para apertar um pouco antes de pousar
const PASSO = 1 / 240;
const VEL0 = 250;
const VEL_MAX = 680;
const VEL_TAU = 55;
const GAP_MIN = 0.64; // s mínimos entre a saída de um obstáculo e a chegada do próximo
const PF = 900; // período da camada de fundo
const PM = 780; // período da camada do meio
const TECLAS = new Set(['Space', 'ArrowUp']);

type Estado = 'pronto' | 'jogando' | 'fim';
type TipoObst = 'carimbo' | 'notas' | 'bobina';

interface Obst {
  tipo: TipoObst;
  x: number;
  w: number;
  h: number;
  mult: number;
  ang: number;
  folga: number;
  passou: boolean;
  semente: number;
}
interface ItemPlano {
  tipo: TipoObst;
  dx: number;
  w: number;
  h: number;
}
interface Plano {
  itens: ItemPlano[];
  mult: number;
  largura: number;
}
interface Trigo {
  x: number;
  y: number;
  fase: number;
}
type TipoParticula = 'farinha' | 'brilho' | 'migalha';
interface Particula {
  tipo: TipoParticula;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  vida: number;
  max: number;
  rot: number;
  cor: string;
}
interface Texto {
  x: number;
  y: number;
  txt: string;
  t: number;
  dur: number;
  cor: string;
  tam: number;
}
interface Jogo {
  estado: Estado;
  t: number;
  tg: number;
  scroll: number;
  dist: number;
  vel: number;
  py: number;
  vy: number;
  noChao: boolean;
  segurando: boolean;
  tSeg: number;
  buffer: number;
  sq: number;
  sqV: number;
  est: number;
  fase: number;
  piscar: number;
  tPassos: number;
  obst: Obst[];
  trigos: Trigo[];
  parts: Particula[];
  textos: Texto[];
  ultimaSaida: number;
  gap: number;
  plano: Plano;
  proxTrigo: number;
  trigosPegos: number;
  tremor: number;
  tFim: number;
  morto: boolean;
  fim: { pontos: number; novo: boolean } | null;
  marcos: number;
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);
const easeOutBack = (k: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};
const fmt = (n: number) => Math.max(0, Math.floor(n)).toLocaleString('pt-BR');

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + k, y);
  c.lineTo(x + w - k, y);
  c.quadraticCurveTo(x + w, y, x + w, y + k);
  c.lineTo(x + w, y + h - k);
  c.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
  c.lineTo(x + k, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - k);
  c.lineTo(x, y + k);
  c.quadraticCurveTo(x, y, x + k, y);
  c.closePath();
}

function elipse(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
  c.fill();
}

/** Remove no próprio array os itens que não passam no teste (sem alocar um array novo a cada passo de 1/240 s). */
function compactar<T>(arr: T[], manter: (item: T) => boolean) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (manter(item)) arr[n++] = item;
  }
  arr.length = n;
}

function pontosDe(j: Jogo) {
  return Math.floor(j.dist / 10) + j.trigosPegos * 5;
}

function velocidade(t: number) {
  return VEL0 + (VEL_MAX - VEL0) * (1 - Math.exp(-t / VEL_TAU));
}

function criarCamada(w: number, h: number, pintar: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w * dpr);
  cv.height = Math.ceil(h * dpr);
  const c = cv.getContext('2d');
  if (c) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    pintar(c);
  }
  return cv;
}

// ---------------------------------------------------------------------------
// Planejamento de obstáculos (sempre puláveis)
// ---------------------------------------------------------------------------

function planejar(t: number): Plano {
  const d = Math.min(1, t / 90);
  const opcoes: [string, number][] = [
    ['notas', 1],
    ['carimbo', t > 3 ? 0.9 : 0],
    ['bobina', t > 18 ? 0.75 : 0],
    ['grupo', t > 40 ? 0.45 + d * 0.3 : 0],
  ];
  const total = opcoes.reduce((s, o) => s + o[1], 0);
  let r = Math.random() * total;
  let escolha = 'notas';
  for (const [nome, peso] of opcoes) {
    if (r < peso) {
      escolha = nome;
      break;
    }
    r -= peso;
  }
  const alturas = d < 0.25 ? [24, 30] : d < 0.6 ? [24, 30, 38] : [30, 38, 46];
  const altNotas = alturas[Math.floor(Math.random() * alturas.length)];
  switch (escolha) {
    case 'carimbo':
      return { itens: [{ tipo: 'carimbo', dx: 0, w: 54, h: 40 }], mult: 1, largura: 54 };
    case 'bobina':
      return { itens: [{ tipo: 'bobina', dx: 0, w: 30, h: 30 }], mult: 1.22, largura: 30 };
    case 'grupo':
      if (Math.random() < 0.5) {
        return {
          itens: [
            { tipo: 'notas', dx: 0, w: 40, h: 30 },
            { tipo: 'carimbo', dx: 45, w: 54, h: 40 },
          ],
          mult: 1,
          largura: 99,
        };
      }
      return {
        itens: [
          { tipo: 'notas', dx: 0, w: 40, h: 24 },
          { tipo: 'notas', dx: 45, w: 40, h: 32 },
        ],
        mult: 1,
        largura: 85,
      };
    default:
      return { itens: [{ tipo: 'notas', dx: 0, w: 40, h: altNotas }], mult: 1, largura: 40 };
  }
}

function novoJogo(): Jogo {
  return {
    estado: 'pronto',
    t: 0,
    tg: 0,
    scroll: 0,
    dist: 0,
    vel: 70,
    py: CHAO,
    vy: 0,
    noChao: true,
    segurando: false,
    tSeg: 0,
    buffer: 0,
    sq: 0,
    sqV: 0,
    est: 0,
    fase: 0,
    piscar: 2.5,
    tPassos: 0,
    obst: [],
    trigos: [],
    parts: [],
    textos: [],
    ultimaSaida: 2.1,
    gap: 0.4,
    plano: planejar(0),
    proxTrigo: 1.8,
    trigosPegos: 0,
    tremor: 0,
    tFim: 0,
    morto: false,
    fim: null,
    marcos: 0,
  };
}

// ---------------------------------------------------------------------------
// Cenário pré-renderizado (céu, prédios ao fundo, rua da padaria)
// ---------------------------------------------------------------------------

const ESTRELAS_DIN = (() => {
  const r = mulberry32(99);
  return Array.from({ length: 8 }, () => ({ x: r() * LARGURA, y: 8 + r() * 100, f: r() * 6, s: 0.8 + r() * 0.8 }));
})();

function pintarCeu(c: CanvasRenderingContext2D) {
  const g = c.createLinearGradient(0, 0, 0, CHAO);
  g.addColorStop(0, '#0E0C08');
  g.addColorStop(0.5, '#1A160F');
  g.addColorStop(0.82, '#36291A');
  g.addColorStop(1, '#4A361C');
  c.fillStyle = g;
  c.fillRect(0, 0, LARGURA, CHAO);
  // brilho quente da cidade no horizonte
  const h = c.createRadialGradient(LARGURA / 2, CHAO + 60, 20, LARGURA / 2, CHAO + 60, 380);
  h.addColorStop(0, 'rgba(240,180,90,0.22)');
  h.addColorStop(1, 'rgba(240,180,90,0)');
  c.fillStyle = h;
  c.fillRect(0, 0, LARGURA, CHAO);
  // estrelas fixas
  const r = mulberry32(7);
  for (let i = 0; i < 46; i++) {
    const x = r() * LARGURA;
    const y = r() * 130;
    c.fillStyle = `rgba(252,247,232,${0.18 + r() * 0.45})`;
    elipse(c, x, y, 0.5 + r() * 0.6, 0.5 + r() * 0.6);
  }
  // lua
  const lx = 478;
  const ly = 46;
  const halo = c.createRadialGradient(lx, ly, 6, lx, ly, 52);
  halo.addColorStop(0, 'rgba(240,210,122,0.28)');
  halo.addColorStop(1, 'rgba(240,210,122,0)');
  c.fillStyle = halo;
  c.fillRect(lx - 60, ly - 60, 120, 120);
  const disco = c.createRadialGradient(lx - 4, ly - 4, 2, lx, ly, 14);
  disco.addColorStop(0, '#FDF5DC');
  disco.addColorStop(1, '#E8D29A');
  c.fillStyle = disco;
  elipse(c, lx, ly, 13, 13);
  c.fillStyle = 'rgba(160,130,70,0.14)';
  elipse(c, lx + 4, ly - 3, 3, 2.6);
  elipse(c, lx - 3, ly + 5, 2.2, 2);
  elipse(c, lx + 5, ly + 6, 1.4, 1.3);
}

function pintarLonge(c: CanvasRenderingContext2D) {
  const r = mulberry32(11);
  // fileira de trás, mais enevoada
  let x = 0;
  while (x < PF) {
    let w = 34 + r() * 50;
    if (x + w > PF - 24) w = PF - x;
    const h = 80 + r() * 85;
    c.fillStyle = '#2A2318';
    c.fillRect(x, CHAO - h, w, h);
    for (let wy = CHAO - h + 8; wy < CHAO - 24; wy += 12) {
      for (let wx = x + 5; wx < x + w - 6; wx += 9) {
        if (r() < 0.16) {
          c.fillStyle = 'rgba(240,200,120,0.32)';
          c.fillRect(wx, wy, 4, 5);
        }
      }
    }
    x += w;
  }
  // fileira da frente, silhuetas escuras com janelas quentes
  x = 6;
  while (x < PF - 30) {
    let w = 56 + r() * 64;
    if (x + w > PF - 6) w = PF - 6 - x;
    if (w < 30) break;
    const h = 56 + r() * 86;
    const topo = CHAO - h;
    c.fillStyle = '#191510';
    c.fillRect(x, topo, w, h);
    const extra = r();
    if (extra < 0.35) {
      // caixa d'água
      c.fillRect(x + w * 0.6, topo - 12, 13, 9);
      c.fillRect(x + w * 0.6 + 1, topo - 3, 1.5, 3);
      c.fillRect(x + w * 0.6 + 10.5, topo - 3, 1.5, 3);
    } else if (extra < 0.65) {
      // antena
      c.strokeStyle = '#191510';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(x + 12, topo);
      c.lineTo(x + 12, topo - 17);
      c.moveTo(x + 7, topo - 12);
      c.lineTo(x + 17, topo - 12);
      c.moveTo(x + 9, topo - 7);
      c.lineTo(x + 15, topo - 7);
      c.stroke();
    } else {
      c.fillStyle = '#211C15';
      c.fillRect(x - 2, topo - 3, w + 4, 3);
    }
    const cols = Math.floor((w - 12) / 12);
    const linhas = Math.floor((h - 22) / 16);
    for (let i = 0; i < cols; i++) {
      for (let k = 0; k < linhas; k++) {
        const wx = x + 8 + i * 12;
        const wy = topo + 10 + k * 16;
        if (r() < 0.32) {
          c.save();
          c.shadowColor = 'rgba(240,190,90,0.7)';
          c.shadowBlur = 8;
          c.fillStyle = r() < 0.6 ? '#F4D07A' : '#E9AE52';
          c.fillRect(wx, wy, 6, 8);
          c.restore();
          if (r() < 0.3) {
            c.fillStyle = 'rgba(60,40,20,0.45)';
            c.fillRect(wx, wy, 3, 8);
          }
        } else {
          c.fillStyle = '#26201A';
          c.fillRect(wx, wy, 6, 8);
        }
      }
    }
    x += w + 4 + r() * 14;
  }
}

function paoMini(c: CanvasRenderingContext2D, x: number, y: number, s: number) {
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  const g = c.createLinearGradient(0, -6, 0, 2);
  g.addColorStop(0, '#E9B460');
  g.addColorStop(1, '#A8641F');
  c.fillStyle = g;
  elipse(c, 0, -2.5, 8, 3.6);
  c.strokeStyle = 'rgba(255,236,190,0.85)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(-5, -3.6);
  c.quadraticCurveTo(0, -6.4, 5, -4.4);
  c.stroke();
  c.restore();
}

function espiga(c: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number) {
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(s, s);
  c.lineCap = 'round';
  c.strokeStyle = '#A07C22';
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(0, 16);
  c.quadraticCurveTo(1.6, 4, 0, -12);
  c.stroke();
  const g = c.createLinearGradient(0, -4, 0, 4);
  g.addColorStop(0, '#FCEAB0');
  g.addColorStop(0.55, '#E2B847');
  g.addColorStop(1, '#B38A1E');
  const grao = (gx: number, gy: number, a: number) => {
    c.save();
    c.translate(gx, gy);
    c.rotate(a);
    c.fillStyle = g;
    elipse(c, 0, 0, 2.3, 4);
    c.strokeStyle = 'rgba(138,109,15,0.75)';
    c.lineWidth = 0.5;
    c.stroke();
    c.restore();
  };
  c.strokeStyle = 'rgba(240,210,122,0.6)';
  c.lineWidth = 0.6;
  c.beginPath();
  for (let i = 0; i < 5; i++) {
    const gy = 6 - i * 4.4;
    c.moveTo(-3.6, gy - 3);
    c.lineTo(-7.5, gy - 10);
    c.moveTo(3.6, gy - 4.6);
    c.lineTo(7.5, gy - 11.6);
  }
  c.moveTo(0, -17);
  c.lineTo(0, -24);
  c.stroke();
  for (let i = 0; i < 5; i++) {
    const gy = 6 - i * 4.4;
    grao(-2.6, gy, -0.45);
    grao(2.6, gy - 1.6, 0.45);
  }
  grao(0, -14.5, 0);
  c.restore();
}

function pintarMeio(c: CanvasRenderingContext2D) {
  const bx = 30;
  const bw = 340;
  const topo = 100;
  // chaminé
  c.fillStyle = '#2E281F';
  c.fillRect(300, 80, 18, topo - 80);
  c.fillStyle = '#463D2F';
  c.fillRect(296, 77, 26, 5);
  // parede com tijolos sutis
  let g = c.createLinearGradient(0, topo, 0, CHAO);
  g.addColorStop(0, '#3F372A');
  g.addColorStop(1, '#2A241B');
  c.fillStyle = g;
  c.fillRect(bx, topo, bw, CHAO - topo);
  c.strokeStyle = 'rgba(0,0,0,0.17)';
  c.lineWidth = 1;
  for (let y = topo + 40, linha = 0; y < CHAO; y += 8, linha++) {
    c.beginPath();
    c.moveTo(bx, y + 0.5);
    c.lineTo(bx + bw, y + 0.5);
    for (let x = bx + (linha % 2 ? 0 : 9); x < bx + bw; x += 18) {
      c.moveTo(x + 0.5, y);
      c.lineTo(x + 0.5, y + 8);
    }
    c.stroke();
  }
  // cornija
  c.fillStyle = '#4C4335';
  c.fillRect(bx - 6, topo - 4, bw + 12, 6);
  c.fillStyle = 'rgba(255,230,170,0.08)';
  c.fillRect(bx - 6, topo - 4, bw + 12, 1.5);
  // letreiro
  rr(c, bx + 60, topo + 8, 220, 27, 4);
  c.fillStyle = '#17130D';
  c.fill();
  c.strokeStyle = 'rgba(201,162,39,0.85)';
  c.lineWidth = 1.2;
  c.stroke();
  c.save();
  c.shadowColor = 'rgba(240,210,122,0.75)';
  c.shadowBlur = 10;
  const gl = c.createLinearGradient(0, topo + 10, 0, topo + 32);
  gl.addColorStop(0, '#FBE7A6');
  gl.addColorStop(1, '#D9AE3A');
  c.fillStyle = gl;
  c.font = `600 18px ${FONTE_SERIFA}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('P A D A R I A', bx + 170, topo + 22.5);
  c.restore();
  espiga(c, bx + 78, topo + 22, 0.55, -0.3);
  espiga(c, bx + 262, topo + 22, 0.55, 0.3);
  // brilho da vitrine e da porta na parede
  const glow = c.createRadialGradient(160, 196, 10, 160, 196, 170);
  glow.addColorStop(0, 'rgba(255,200,110,0.30)');
  glow.addColorStop(1, 'rgba(255,200,110,0)');
  c.fillStyle = glow;
  c.fillRect(bx, topo + 40, bw, CHAO - topo - 40);
  // vitrine
  rr(c, 46, 165, 208, 50, 3);
  c.fillStyle = '#211B13';
  c.fill();
  g = c.createLinearGradient(0, 168, 0, 212);
  g.addColorStop(0, '#FFEDBA');
  g.addColorStop(0.55, '#F3C46A');
  g.addColorStop(1, '#D8963C');
  c.fillStyle = g;
  c.fillRect(50, 169, 200, 42);
  c.font = `italic 600 9px ${FONTE_SERIFA}`;
  c.fillStyle = 'rgba(122,74,20,0.85)';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('pão quentinho', 150, 177);
  // prateleiras e pães
  c.fillStyle = '#8F5F27';
  c.fillRect(50, 192, 200, 2);
  c.fillRect(50, 207, 200, 2);
  for (let i = 0; i < 8; i++) paoMini(c, 62 + i * 23, 192, 1);
  for (let i = 0; i < 6; i++) {
    const cx = 60 + i * 20;
    const rg = c.createRadialGradient(cx - 2, 201, 1, cx, 203, 6);
    rg.addColorStop(0, '#EFC171');
    rg.addColorStop(1, '#A0601E');
    c.fillStyle = rg;
    elipse(c, cx, 203, 6.5, 4.6);
  }
  // bolo no suporte
  c.fillStyle = '#B9A483';
  c.fillRect(214, 205, 22, 2);
  c.fillRect(224, 200, 2, 6);
  rr(c, 211, 189, 28, 12, 3);
  c.fillStyle = '#F6E7CB';
  c.fill();
  c.fillStyle = '#C9A227';
  rr(c, 211, 189, 28, 4, 2);
  c.fill();
  c.fillStyle = '#E11D48';
  elipse(c, 225, 187.5, 2, 2);
  // baguetes em pé no canto
  c.save();
  c.translate(66, 186);
  c.rotate(-0.35);
  c.fillStyle = '#C98A3A';
  rr(c, -3, -16, 6, 18, 3);
  c.fill();
  c.restore();
  // reflexo no vidro
  c.save();
  c.beginPath();
  c.rect(50, 169, 200, 42);
  c.clip();
  c.fillStyle = 'rgba(255,255,255,0.16)';
  c.beginPath();
  c.moveTo(120, 169);
  c.lineTo(146, 169);
  c.lineTo(116, 211);
  c.lineTo(90, 211);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.09)';
  c.beginPath();
  c.moveTo(154, 169);
  c.lineTo(162, 169);
  c.lineTo(132, 211);
  c.lineTo(124, 211);
  c.closePath();
  c.fill();
  c.restore();
  // peitoril e base
  c.fillStyle = '#5E5240';
  c.fillRect(42, 214, 216, 4);
  c.fillStyle = '#211C15';
  c.fillRect(bx, 218, bw, CHAO - 218);
  // toldo listrado tinta/dourado
  c.save();
  c.beginPath();
  c.moveTo(bx + 8, 140);
  c.lineTo(bx + bw - 8, 140);
  c.lineTo(bx + bw + 4, 158);
  c.lineTo(bx - 4, 158);
  c.closePath();
  c.clip();
  for (let x = bx - 4, i = 0; x < bx + bw + 4; x += 20, i++) {
    c.fillStyle = i % 2 ? '#C9A227' : '#1D1913';
    c.fillRect(x, 140, 20, 18);
  }
  const sombraToldo = c.createLinearGradient(0, 140, 0, 158);
  sombraToldo.addColorStop(0, 'rgba(0,0,0,0.35)');
  sombraToldo.addColorStop(0.4, 'rgba(0,0,0,0)');
  sombraToldo.addColorStop(1, 'rgba(0,0,0,0.18)');
  c.fillStyle = sombraToldo;
  c.fillRect(bx - 4, 140, bw + 8, 18);
  c.restore();
  // babado (recortes em arco)
  for (let x = bx - 4, i = 0; x < bx + bw + 4; x += 20, i++) {
    c.fillStyle = i % 2 ? '#B8931F' : '#16130E';
    c.beginPath();
    c.moveTo(x, 158);
    c.lineTo(x + 20, 158);
    c.arc(x + 10, 158, 10, 0, Math.PI);
    c.closePath();
    c.fill();
  }
  // sombra do toldo na parede
  const st = c.createLinearGradient(0, 166, 0, 178);
  st.addColorStop(0, 'rgba(0,0,0,0.3)');
  st.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = st;
  c.fillRect(bx, 166, 12, 12);
  c.fillRect(258, 166, bw - 228, 12);
  // porta
  c.fillStyle = '#17120C';
  c.fillRect(270, 168, 62, CHAO - 168);
  g = c.createLinearGradient(274, 0, 328, 0);
  g.addColorStop(0, '#5B3B1E');
  g.addColorStop(1, '#3B2612');
  c.fillStyle = g;
  c.fillRect(274, 172, 54, CHAO - 172);
  g = c.createLinearGradient(0, 178, 0, 206);
  g.addColorStop(0, '#FFE7A8');
  g.addColorStop(1, '#E8A848');
  c.fillStyle = g;
  rr(c, 281, 178, 40, 28, 3);
  c.fill();
  rr(c, 287, 186, 28, 10, 2);
  c.fillStyle = '#059669';
  c.fill();
  c.fillStyle = '#FFFFFF';
  c.font = `700 6.5px ${FONTE}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('ABERTO', 301, 191.3);
  c.fillStyle = '#E2B847';
  elipse(c, 320, 216, 2, 2);
  // segunda loja (fechada)
  c.fillStyle = '#2E281F';
  c.fillRect(492, 124, 236, CHAO - 124);
  c.fillStyle = '#3B3328';
  c.fillRect(488, 120, 244, 5);
  for (const wx of [512, 580, 648]) {
    c.fillStyle = '#1D1913';
    c.fillRect(wx - 2, 132, 36, 26);
    g = c.createLinearGradient(0, 134, 0, 156);
    g.addColorStop(0, wx === 580 ? '#5A4426' : '#E9B866');
    g.addColorStop(1, wx === 580 ? '#3A2C1A' : '#B47A34');
    c.fillStyle = g;
    c.fillRect(wx, 134, 32, 22);
    c.fillStyle = '#1D1913';
    c.fillRect(wx + 15, 134, 2, 22);
  }
  rr(c, 528, 164, 64, 16, 3);
  c.fillStyle = '#17130D';
  c.fill();
  c.fillStyle = 'rgba(240,210,122,0.75)';
  c.font = `600 11px ${FONTE_SERIFA}`;
  c.fillText('C A F É', 560, 172.5);
  c.fillStyle = '#3E382D';
  c.fillRect(510, 184, 100, CHAO - 184);
  for (let y = 186; y < CHAO; y += 3) {
    c.fillStyle = (y / 3) % 2 < 1 ? '#4A4334' : '#302B22';
    c.fillRect(510, y, 100, 1.4);
  }
  g = c.createLinearGradient(0, 186, 0, 214);
  g.addColorStop(0, '#D7A75A');
  g.addColorStop(1, '#9C6A2C');
  c.fillStyle = '#1D1913';
  c.fillRect(636, 184, 66, 32);
  c.fillStyle = g;
  c.fillRect(639, 187, 60, 26);
  for (let i = 0; i < 3; i++) {
    c.fillStyle = '#5B3B1E';
    elipse(c, 650 + i * 18, 206, 5, 2.4);
    c.fillStyle = '#F3E9D6';
    c.fillRect(646 + i * 18, 198, 8, 7);
  }
  // vaso com planta
  c.fillStyle = '#6B4A2A';
  c.beginPath();
  c.moveTo(712, CHAO);
  c.lineTo(708, CHAO - 14);
  c.lineTo(726, CHAO - 14);
  c.lineTo(722, CHAO);
  c.closePath();
  c.fill();
  c.fillStyle = '#2D3F25';
  elipse(c, 717, CHAO - 20, 9, 8);
  elipse(c, 711, CHAO - 26, 5, 6);
  elipse(c, 723, CHAO - 27, 5, 6);
  // poste com luz quente
  const lx = 440;
  g = c.createLinearGradient(lx - 2, 0, lx + 2, 0);
  g.addColorStop(0, '#2E281D');
  g.addColorStop(1, '#14110C');
  c.fillStyle = g;
  c.fillRect(lx - 2, 108, 4, CHAO - 108);
  c.fillStyle = '#14110C';
  rr(c, lx - 6, CHAO - 9, 12, 9, 2);
  c.fill();
  c.strokeStyle = '#14110C';
  c.lineWidth = 2.4;
  c.beginPath();
  c.moveTo(lx, 110);
  c.quadraticCurveTo(lx, 98, lx + 12, 98);
  c.stroke();
  c.fillStyle = '#14110C';
  c.fillRect(lx + 7, 97, 11, 4);
  const lampada = c.createLinearGradient(0, 101, 0, 114);
  lampada.addColorStop(0, '#FFF2C8');
  lampada.addColorStop(1, '#F2BE5C');
  c.fillStyle = lampada;
  c.beginPath();
  c.moveTo(lx + 8, 101);
  c.lineTo(lx + 17, 101);
  c.lineTo(lx + 19, 113);
  c.lineTo(lx + 6, 113);
  c.closePath();
  c.fill();
  const halo = c.createRadialGradient(lx + 12.5, 108, 4, lx + 12.5, 108, 86);
  halo.addColorStop(0, 'rgba(255,214,140,0.42)');
  halo.addColorStop(0.35, 'rgba(255,200,120,0.14)');
  halo.addColorStop(1, 'rgba(255,200,120,0)');
  c.fillStyle = halo;
  c.fillRect(lx - 80, 20, 186, 180);
}

// ---------------------------------------------------------------------------
// Desenho dos elementos do jogo
// ---------------------------------------------------------------------------

function desenharCarimbo(c: CanvasRenderingContext2D, o: Obst) {
  const x = o.x;
  const w = o.w;
  const cx = x + w / 2;
  const topoBloco = CHAO - 27;
  c.fillStyle = 'rgba(0,0,0,0.38)';
  elipse(c, cx, CHAO + 2, w / 2 + 3, 3.4);
  // pescoço e pegador de madeira
  let g = c.createLinearGradient(cx - 4, 0, cx + 4, 0);
  g.addColorStop(0, '#7A4E25');
  g.addColorStop(1, '#4A2F14');
  c.fillStyle = g;
  c.fillRect(cx - 4, CHAO - o.h + 9, 8, topoBloco - (CHAO - o.h + 9));
  g = c.createRadialGradient(cx - 3, CHAO - o.h + 4, 1, cx, CHAO - o.h + 7, 11);
  g.addColorStop(0, '#B57D42');
  g.addColorStop(1, '#5A3818');
  c.fillStyle = g;
  elipse(c, cx, CHAO - o.h + 7, 10, 7);
  c.fillStyle = 'rgba(255,230,190,0.28)';
  elipse(c, cx - 3, CHAO - o.h + 4.5, 4, 2);
  // anel dourado
  g = c.createLinearGradient(0, topoBloco - 4, 0, topoBloco + 1);
  g.addColorStop(0, '#F0D27A');
  g.addColorStop(1, '#8A6D0F');
  c.fillStyle = g;
  rr(c, cx - 9, topoBloco - 4, 18, 5, 2);
  c.fill();
  // bloco vermelho
  g = c.createLinearGradient(0, topoBloco, 0, CHAO);
  g.addColorStop(0, '#EE4A64');
  g.addColorStop(1, '#A3123A');
  rr(c, x, topoBloco, w, 23, 4);
  c.fillStyle = g;
  c.fill();
  c.fillStyle = '#7A0E28';
  rr(c, x + 1, CHAO - 5, w - 2, 5, 1.5);
  c.fill();
  // texto inclinado "INUTILIZADA"
  c.save();
  rr(c, x, topoBloco, w, 23, 4);
  c.clip();
  c.translate(cx, topoBloco + 11.5);
  c.rotate(-0.16);
  c.strokeStyle = 'rgba(253,232,236,0.92)';
  c.lineWidth = 1.1;
  rr(c, -w / 2 + 5, -7, w - 10, 14, 2);
  c.stroke();
  c.strokeStyle = 'rgba(253,232,236,0.45)';
  c.lineWidth = 0.6;
  rr(c, -w / 2 + 7, -5.2, w - 14, 10.4, 1.5);
  c.stroke();
  c.font = `700 7px ${FONTE}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const tw = c.measureText('INUTILIZADA').width;
  const esc = Math.min(1, (w - 18) / Math.max(1, tw));
  c.scale(esc, 1);
  c.fillStyle = '#FDE8EC';
  c.fillText('INUTILIZADA', 0, 0.5);
  c.restore();
  c.fillStyle = 'rgba(255,255,255,0.25)';
  c.fillRect(x + 4, topoBloco + 1, w - 8, 1);
}

function desenharNotas(c: CanvasRenderingContext2D, o: Obst) {
  const n = Math.max(3, Math.round(o.h / 7));
  const lh = o.h / n;
  const rnd = mulberry32(Math.floor(o.semente * 1000));
  c.fillStyle = 'rgba(0,0,0,0.38)';
  elipse(c, o.x + o.w / 2, CHAO + 2, o.w / 2 + 4, 3.4);
  let dxTopo = 0;
  for (let i = 0; i < n; i++) {
    const y0 = CHAO - (i + 1) * lh;
    const dx = (rnd() - 0.5) * 5;
    dxTopo = dx;
    const g = c.createLinearGradient(0, y0, 0, y0 + lh);
    g.addColorStop(0, i % 2 ? '#FBF8F0' : '#F3EDE0');
    g.addColorStop(1, '#D9D0BE');
    c.fillStyle = g;
    rr(c, o.x + dx, y0, o.w, lh, 1.5);
    c.fill();
    c.strokeStyle = 'rgba(120,110,90,0.35)';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let k = 1; k < 3; k++) {
      const ly = y0 + (lh * k) / 3;
      c.moveTo(o.x + dx + 1.5, ly);
      c.lineTo(o.x + dx + o.w - 1.5, ly);
    }
    c.stroke();
  }
  // elástico
  c.fillStyle = 'rgba(217,119,6,0.85)';
  c.fillRect(o.x + o.w * 0.62, CHAO - o.h + 1, 2.2, o.h - 1);
  // folha de cima vista de leve (com linhas e cabeçalho)
  const y0 = CHAO - o.h;
  const x0 = o.x + dxTopo;
  c.fillStyle = '#FFFDF7';
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x0 + o.w, y0);
  c.lineTo(x0 + o.w + 2, y0 - 6);
  c.lineTo(x0 + 3, y0 - 6);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(120,110,90,0.4)';
  c.lineWidth = 0.6;
  c.stroke();
  c.fillStyle = '#C9A227';
  c.fillRect(x0 + 5, y0 - 4.6, 7, 1.6);
  c.strokeStyle = 'rgba(94,89,79,0.45)';
  c.beginPath();
  c.moveTo(x0 + 15, y0 - 3.9);
  c.lineTo(x0 + o.w - 4, y0 - 3.9);
  c.moveTo(x0 + 4, y0 - 1.8);
  c.lineTo(x0 + o.w - 6, y0 - 1.8);
  c.stroke();
}

function desenharBobina(c: CanvasRenderingContext2D, o: Obst) {
  const r = 15;
  const cx = o.x + r;
  const cy = CHAO - r;
  // fita de cupom desenrolada atrás
  c.fillStyle = 'rgba(0,0,0,0.3)';
  elipse(c, cx + 26, CHAO + 1.5, 30, 2);
  c.fillStyle = '#F6F1E4';
  c.beginPath();
  c.moveTo(cx, CHAO - 2.6);
  c.lineTo(cx + 48, CHAO - 2.6);
  c.quadraticCurveTo(cx + 55, CHAO - 6, cx + 52, CHAO - 0.5);
  c.lineTo(cx, CHAO);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(94,89,79,0.5)';
  for (let k = 0; k < 6; k++) c.fillRect(cx + 8 + k * 7, CHAO - 1.8, 4, 0.8);
  // sombra do rolo
  c.fillStyle = 'rgba(0,0,0,0.38)';
  elipse(c, cx, CHAO + 2, r + 2, 3.2);
  const g = c.createRadialGradient(cx - 5, cy - 6, 2, cx, cy, r);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.6, '#EFE8D8');
  g.addColorStop(1, '#CFC5AF');
  c.fillStyle = g;
  elipse(c, cx, cy, r, r);
  c.save();
  c.translate(cx, cy);
  c.rotate(o.ang);
  c.strokeStyle = 'rgba(140,125,100,0.32)';
  c.lineWidth = 0.7;
  for (let k = 1; k <= 3; k++) {
    c.beginPath();
    c.arc(0, 0, r - k * 2.4, k * 0.9, k * 0.9 + Math.PI * 1.7);
    c.stroke();
  }
  // faixa rosa de "fim de bobina"
  c.strokeStyle = 'rgba(225,29,72,0.55)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.arc(0, 0, 7, 0, Math.PI * 1.3);
  c.stroke();
  // ponta do papel
  c.strokeStyle = 'rgba(94,89,79,0.7)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(r - 0.5, 0);
  c.lineTo(r - 4, 0);
  c.stroke();
  // miolo
  c.fillStyle = '#9A8B6E';
  elipse(c, 0, 0, 5.2, 5.2);
  c.fillStyle = '#2C2820';
  elipse(c, 0, 0, 2.8, 2.8);
  c.fillStyle = '#C2B391';
  c.fillRect(-0.6, -5, 1.2, 2.2);
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,0.7)';
  c.lineWidth = 1;
  c.beginPath();
  c.arc(cx, cy, r - 1.5, Math.PI * 1.1, Math.PI * 1.45);
  c.stroke();
}

function desenharPao(c: CanvasRenderingContext2D, j: Jogo) {
  const alt = CHAO - j.py;
  const ks = clamp(1 - alt / 170, 0.25, 1);
  c.fillStyle = `rgba(0,0,0,${0.4 * ks})`;
  elipse(c, PX, CHAO + 2.5, 20 * ks + 2, 3.6 * ks);

  let sx = 1;
  let sy = 1;
  let rot = 0;
  let bob = 0;
  if (j.morto) {
    const k = easeOutCubic(clamp(j.tFim / 0.14, 0, 1));
    sx = 1 + 0.38 * k;
    sy = 1 - 0.42 * k;
  } else {
    const s = clamp(j.sq - j.est, -0.28, 0.34);
    sx = 1 + s * 0.8;
    sy = 1 - s;
    if (!j.noChao) rot = clamp(j.vy / 3600, -0.17, 0.15);
    else bob = -Math.abs(Math.sin(j.fase)) * 1.6;
  }
  c.save();
  c.translate(PX, j.py + bob);
  c.rotate(rot);
  c.scale(sx, sy);

  // perninhas
  c.lineCap = 'round';
  const pernas: [number, number, string][] = [
    [-6, Math.PI, '#2A1C0E'],
    [6, 0, '#3A2714'],
  ];
  for (const [hx, off, cor] of pernas) {
    let fx: number;
    let fy: number;
    if (j.morto) {
      fx = hx * 2;
      fy = 0;
    } else if (!j.noChao) {
      fx = hx < 0 ? hx - 4 : hx + 5;
      fy = hx < 0 ? -1.8 : -3.6;
    } else {
      const a = j.fase + off;
      fx = hx + Math.cos(a) * 5;
      fy = -Math.max(0, Math.sin(a)) * 3.5;
    }
    c.strokeStyle = cor;
    c.lineWidth = 2.4;
    c.beginPath();
    c.moveTo(hx, -6);
    c.lineTo(fx, fy - 0.8);
    c.stroke();
    c.fillStyle = cor;
    elipse(c, fx + 1.4, fy - 0.6, 3, 1.6);
  }

  // corpo
  c.translate(0, -5);
  const caminho = () => {
    c.beginPath();
    c.moveTo(-23, -8);
    c.bezierCurveTo(-22, -25, 19, -27, 23.5, -10);
    c.bezierCurveTo(25, -3, 18, 0, 9, 0);
    c.lineTo(-11, 0);
    c.bezierCurveTo(-20, 0, -24.5, -3, -23, -8);
    c.closePath();
  };
  caminho();
  let g = c.createLinearGradient(0, -23, 0, 0);
  g.addColorStop(0, '#F6CF78');
  g.addColorStop(0.45, '#DE9E3E');
  g.addColorStop(1, '#A8641F');
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.4)';
  c.shadowBlur = 6;
  c.shadowOffsetY = 2;
  c.fillStyle = g;
  c.fill();
  c.restore();
  c.lineWidth = 1.2;
  c.strokeStyle = '#6E3D10';
  c.stroke();
  c.save();
  caminho();
  c.clip();
  g = c.createRadialGradient(-8, -17, 1, -8, -17, 16);
  g.addColorStop(0, 'rgba(255,240,200,0.55)');
  g.addColorStop(1, 'rgba(255,240,200,0)');
  c.fillStyle = g;
  c.fillRect(-26, -28, 52, 30);
  c.fillStyle = 'rgba(90,45,10,0.22)';
  c.fillRect(-26, -4, 52, 5);
  c.restore();

  // pestana (o corte do pão francês)
  c.beginPath();
  c.moveTo(-15, -14.5);
  c.quadraticCurveTo(0, -24.5, 16.5, -18.5);
  c.quadraticCurveTo(1, -17.5, -15, -14.5);
  g = c.createLinearGradient(0, -22, 0, -15);
  g.addColorStop(0, '#FCE9BA');
  g.addColorStop(1, '#E8BF72');
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = '#94551A';
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(-15.5, -14.8);
  c.quadraticCurveTo(0, -25.8, 17, -18.8);
  c.stroke();
  c.strokeStyle = 'rgba(255,245,215,0.65)';
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(-10, -18.4);
  c.quadraticCurveTo(0, -24.2, 10, -21.6);
  c.stroke();

  // pontinhos de farinha
  c.fillStyle = 'rgba(255,248,230,0.6)';
  for (const [fx, fy] of [
    [-14, -8],
    [-6, -5],
    [3, -9],
    [-18, -12],
    [7, -4],
    [-1, -13],
  ]) {
    elipse(c, fx, fy, 0.65, 0.65);
  }

  // rostinho (olhando para a direita)
  c.fillStyle = COR.tinta;
  c.strokeStyle = COR.tinta;
  c.lineCap = 'round';
  if (j.morto) {
    c.lineWidth = 1.2;
    c.beginPath();
    for (const ex of [11, 17]) {
      c.moveTo(ex - 1.6, -11.6);
      c.lineTo(ex + 1.6, -8.4);
      c.moveTo(ex + 1.6, -11.6);
      c.lineTo(ex - 1.6, -8.4);
    }
    c.stroke();
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(12, -5);
    c.lineTo(13.5, -6);
    c.lineTo(15, -5);
    c.lineTo(16.5, -6);
    c.lineTo(18, -5);
    c.stroke();
  } else {
    if (j.piscar < 0) {
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(9.4, -10);
      c.quadraticCurveTo(11, -8.8, 12.6, -10);
      c.moveTo(15.5, -10.3);
      c.quadraticCurveTo(17, -9.1, 18.5, -10.3);
      c.stroke();
    } else {
      elipse(c, 11, -10, 1.7, 2.4);
      elipse(c, 17, -10.3, 1.6, 2.3);
      c.fillStyle = '#FFFFFF';
      elipse(c, 11.6, -11, 0.7, 0.7);
      elipse(c, 17.5, -11.3, 0.65, 0.65);
    }
    c.fillStyle = 'rgba(226,96,70,0.38)';
    elipse(c, 20, -5.6, 2.6, 1.5);
    elipse(c, 8, -5.4, 2, 1.3);
    c.strokeStyle = COR.tinta;
    c.fillStyle = COR.tinta;
    if (!j.noChao) {
      elipse(c, 14.4, -5.4, 1.2, 1.4);
    } else {
      c.lineWidth = 1;
      c.beginPath();
      c.arc(14.2, -7, 2.2, Math.PI * 0.18, Math.PI * 0.82);
      c.stroke();
    }
  }
  c.restore();
}

function estrela(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.beginPath();
  c.moveTo(0, -r);
  c.quadraticCurveTo(0, 0, r, 0);
  c.quadraticCurveTo(0, 0, 0, r);
  c.quadraticCurveTo(0, 0, -r, 0);
  c.quadraticCurveTo(0, 0, 0, -r);
  c.fill();
  c.restore();
}

interface Camadas {
  ceu: HTMLCanvasElement;
  longe: HTMLCanvasElement;
  meio: HTMLCanvasElement;
}

function desenhar(c: CanvasRenderingContext2D, j: Jogo, cam: Camadas, reduzir: boolean, recorde: number) {
  c.clearRect(0, 0, LARGURA, ALTURA);
  c.save();
  if (j.tremor > 0 && !reduzir) {
    const a = 7 * j.tremor * j.tremor;
    c.translate((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a);
  }

  // céu
  c.drawImage(cam.ceu, 0, 0, LARGURA, CHAO);
  for (const s of ESTRELAS_DIN) {
    const a = reduzir ? 0.6 : 0.35 + 0.35 * Math.sin(j.tg * 1.7 + s.f);
    c.fillStyle = `rgba(252,240,205,${a})`;
    estrela(c, s.x, s.y, s.s * 1.8, 0);
  }

  // fundo (prédios) — paralaxe lenta
  const offL = (j.scroll * 0.12) % PF;
  for (let x = -offL; x < LARGURA; x += PF) c.drawImage(cam.longe, x, 0, PF, CHAO);

  // meio (rua da padaria)
  const offM = (j.scroll * 0.45) % PM;
  for (let x = -offM; x < LARGURA; x += PM) c.drawImage(cam.meio, x, 0, PM, CHAO);
  // vapor saindo da chaminé
  for (let x = -offM; x < LARGURA + 40; x += PM) {
    const cx = x + 309;
    if (cx < -40 || cx > LARGURA + 40) continue;
    for (let i = 0; i < 4; i++) {
      const k = (j.tg * 0.32 + i / 4) % 1;
      const vx = cx + Math.sin(k * 6 + i) * 5 - k * 14;
      const vy = 76 - k * 56;
      const r = 4 + k * 11;
      const a = 0.2 * (1 - k) * Math.min(1, k * 5);
      c.fillStyle = `rgba(245,236,215,${a})`;
      elipse(c, vx, vy, r, r * 0.85);
    }
  }

  // calçada
  let g = c.createLinearGradient(0, CHAO, 0, ALTURA);
  g.addColorStop(0, '#433B2E');
  g.addColorStop(1, '#231F18');
  c.fillStyle = g;
  c.fillRect(0, CHAO, LARGURA, ALTURA - CHAO);
  c.fillStyle = '#6E6350';
  c.fillRect(0, CHAO, LARGURA, 2);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.fillRect(0, CHAO + 2, LARGURA, 1.5);
  // poças de luz da vitrine e do poste
  for (let x = -offM; x < LARGURA + 120; x += PM) {
    for (const [lx, a] of [
      [150, 0.2],
      [301, 0.12],
      [452, 0.24],
    ] as const) {
      const px = x + lx;
      if (px < -120 || px > LARGURA + 120) continue;
      c.save();
      c.translate(px, CHAO + 9);
      c.scale(1, 0.22);
      const rg = c.createRadialGradient(0, 0, 4, 0, 0, 100);
      rg.addColorStop(0, `rgba(255,205,120,${a})`);
      rg.addColorStop(1, 'rgba(255,205,120,0)');
      c.fillStyle = rg;
      c.fillRect(-100, -100, 200, 200);
      c.restore();
    }
  }
  // juntas da calçada e migalhas
  const offC = j.scroll % 64;
  c.lineWidth = 1.4;
  for (let x = -offC; x < LARGURA + 64; x += 64) {
    c.strokeStyle = 'rgba(15,12,8,0.55)';
    c.beginPath();
    c.moveTo(x, CHAO + 3);
    c.lineTo(x - 16, ALTURA);
    c.stroke();
    c.strokeStyle = 'rgba(255,230,180,0.06)';
    c.beginPath();
    c.moveTo(x + 1.4, CHAO + 3);
    c.lineTo(x - 14.6, ALTURA);
    c.stroke();
    const idx = Math.floor((j.scroll + x + offC) / 64);
    const rnd = mulberry32(idx * 7919 + 13);
    for (let k = 0; k < 3; k++) {
      c.fillStyle = rnd() < 0.5 ? 'rgba(201,150,80,0.45)' : 'rgba(240,225,190,0.25)';
      elipse(c, x + 8 + rnd() * 48, CHAO + 6 + rnd() * 34, 0.9 + rnd() * 0.8, 0.7 + rnd() * 0.5);
    }
  }
  c.strokeStyle = 'rgba(15,12,8,0.35)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, CHAO + 20.5);
  c.lineTo(LARGURA, CHAO + 20.5);
  c.stroke();

  // trigos
  for (const t of j.trigos) {
    const y = t.y + Math.sin(j.tg * 3 + t.fase) * 3;
    const pulso = 0.8 + 0.2 * Math.sin(j.tg * 5 + t.fase);
    const rg = c.createRadialGradient(t.x, y, 2, t.x, y, 26);
    rg.addColorStop(0, `rgba(240,210,122,${0.42 * pulso})`);
    rg.addColorStop(1, 'rgba(240,210,122,0)');
    c.fillStyle = rg;
    c.fillRect(t.x - 26, y - 26, 52, 52);
    espiga(c, t.x, y, 0.85, Math.sin(j.tg * 2.2 + t.fase) * 0.12);
    if (!reduzir) {
      const k = (j.tg * 0.8 + t.fase) % 2;
      if (k < 0.5) {
        c.fillStyle = `rgba(255,248,220,${Math.sin((k / 0.5) * Math.PI)})`;
        estrela(c, t.x + 6, y - 10, 3.5, 0);
      }
    }
  }

  // obstáculos
  for (const o of j.obst) {
    if (o.tipo === 'carimbo') desenharCarimbo(c, o);
    else if (o.tipo === 'notas') desenharNotas(c, o);
    else desenharBobina(c, o);
  }

  // partículas atrás (farinha) e o pão
  for (const p of j.parts) {
    if (p.tipo !== 'farinha') continue;
    const k = p.vida / p.max;
    c.fillStyle = `rgba(250,244,228,${0.55 * (1 - k)})`;
    const r = p.r * (1 + k * 1.3);
    elipse(c, p.x, p.y, r, r * 0.85);
  }
  desenharPao(c, j);
  for (const p of j.parts) {
    const k = p.vida / p.max;
    if (p.tipo === 'brilho') {
      c.fillStyle = p.cor;
      c.globalAlpha = 1 - k;
      estrela(c, p.x, p.y, p.r * (1 - k * 0.6), p.rot);
      c.globalAlpha = 1;
    } else if (p.tipo === 'migalha') {
      c.fillStyle = p.cor;
      c.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      elipse(c, p.x, p.y, p.r, p.r * 0.8);
      c.globalAlpha = 1;
    }
  }

  // textos flutuantes
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const t of j.textos) {
    const k = t.t / t.dur;
    const ent = easeOutBack(Math.min(1, t.t / 0.25));
    const y = t.y - 26 * easeOutCubic(k);
    const a = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    c.save();
    c.globalAlpha = clamp(a, 0, 1);
    c.translate(t.x, y);
    c.scale(0.6 + 0.4 * ent, 0.6 + 0.4 * ent);
    c.font = `600 ${t.tam}px ${t.tam >= 15 ? FONTE_SERIFA : FONTE}`;
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(23,21,15,0.7)';
    c.strokeText(t.txt, 0, 0);
    c.fillStyle = t.cor;
    c.fillText(t.txt, 0, 0);
    c.restore();
  }
  c.restore();

  // placar no canto
  if (j.estado === 'jogando' || (j.estado === 'fim' && j.tFim < 0.35)) {
    c.save();
    c.textAlign = 'right';
    c.textBaseline = 'alphabetic';
    c.font = `600 22px ${FONTE_SERIFA}`;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 8;
    c.fillStyle = COR.douradoClaro;
    c.fillText(fmt(pontosDe(j)), LARGURA - 16, 32);
    c.font = `500 10px ${FONTE}`;
    c.fillStyle = 'rgba(252,251,248,0.6)';
    c.fillText('pontos', LARGURA - 16, 45);
    c.restore();
  }

  if (j.estado === 'pronto') desenharInicio(c, j, recorde);
  if (j.estado === 'fim') desenharFim(c, j, recorde);
}

function desenharInicio(c: CanvasRenderingContext2D, j: Jogo, recorde: number) {
  const k = easeOutCubic(clamp(j.tg / 0.7, 0, 1));
  const g = c.createRadialGradient(LARGURA / 2, 96, 10, LARGURA / 2, 96, 250);
  g.addColorStop(0, `rgba(14,12,8,${0.72 * k})`);
  g.addColorStop(1, 'rgba(14,12,8,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, LARGURA, ALTURA);
  c.save();
  c.globalAlpha = k;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `600 10.5px ${FONTE}`;
  c.fillStyle = 'rgba(201,162,39,0.95)';
  c.fillText('P A S S A T E M P O', LARGURA / 2, 58 + (1 - k) * 8);
  c.save();
  c.translate(LARGURA / 2, 90 + (1 - k) * 12 + Math.sin(j.tg * 1.6) * 1.5);
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 14;
  const tg = c.createLinearGradient(0, -18, 0, 16);
  tg.addColorStop(0, '#FBE7A6');
  tg.addColorStop(1, '#D9AE3A');
  c.fillStyle = tg;
  c.font = `italic 600 38px ${FONTE_SERIFA}`;
  c.fillText('Pãozinho Corredor', 0, 0);
  c.restore();
  const pulso = 0.65 + 0.35 * Math.sin(j.tg * 3.2);
  c.font = `500 13.5px ${FONTE}`;
  c.fillStyle = `rgba(252,251,248,${0.55 + 0.45 * pulso})`;
  c.fillText('Toque ou aperte Espaço para começar', LARGURA / 2, 124);
  if (recorde > 0) {
    c.font = `500 12px ${FONTE}`;
    c.fillStyle = 'rgba(240,210,122,0.85)';
    c.fillText(`Recorde: ${fmt(recorde)}`, LARGURA / 2, 146);
  }
  c.restore();
}

function desenharFim(c: CanvasRenderingContext2D, j: Jogo, recorde: number) {
  const a = easeOutCubic(clamp((j.tFim - 0.25) / 0.4, 0, 1));
  if (a <= 0 || !j.fim) return;
  c.save();
  c.fillStyle = `rgba(14,12,8,${0.5 * a})`;
  c.fillRect(0, 0, LARGURA, ALTURA);
  const w = 256;
  const h = 172;
  const x = (LARGURA - w) / 2;
  const y = 54 + (1 - a) * 16;
  c.globalAlpha = a;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.45)';
  c.shadowBlur = 30;
  c.shadowOffsetY = 10;
  rr(c, x, y, w, h, 16);
  c.fillStyle = COR.papel;
  c.fill();
  c.restore();
  rr(c, x + 0.5, y + 0.5, w - 1, h - 1, 16);
  c.strokeStyle = 'rgba(201,162,39,0.55)';
  c.lineWidth = 1;
  c.stroke();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const cx = LARGURA / 2;
  c.font = `600 10.5px ${FONTE}`;
  c.fillStyle = COR.texto3;
  c.fillText('F I M   D A   C O R R I D A', cx, y + 28);
  const contagem = easeOutCubic(clamp((j.tFim - 0.3) / 0.6, 0, 1));
  c.font = `600 46px ${FONTE_SERIFA}`;
  c.fillStyle = COR.tinta;
  c.fillText(fmt(j.fim.pontos * contagem), cx, y + 72);
  if (j.fim.novo) {
    const kb = easeOutBack(clamp((j.tFim - 0.8) / 0.35, 0, 1));
    if (kb > 0) {
      c.save();
      c.translate(cx, y + 104);
      c.scale(kb, kb);
      rr(c, -56, -11, 112, 22, 11);
      c.fillStyle = COR.verde;
      c.fill();
      c.fillStyle = '#FFFFFF';
      c.font = `600 12px ${FONTE}`;
      c.fillText('Novo recorde!', 0, 0.5);
      c.restore();
    }
  } else {
    c.font = `500 12px ${FONTE}`;
    c.fillStyle = COR.texto2;
    c.fillText(`Recorde: ${fmt(Math.max(recorde, j.fim.pontos))}`, cx, y + 104);
  }
  c.font = `500 11.5px ${FONTE}`;
  c.fillStyle = COR.texto3;
  const tr = j.trigosPegos;
  c.fillText(`${tr} ${tr === 1 ? 'trigo colhido' : 'trigos colhidos'} · ${fmt(j.dist / 10)} de distância`, cx, y + 127);
  const pronto = j.tFim > 0.6;
  const pulso = pronto ? 0.7 + 0.3 * Math.sin(j.tg * 3.2) : 0.35;
  c.globalAlpha = a * pulso;
  c.font = `600 12.5px ${FONTE}`;
  c.fillStyle = COR.douradoTexto;
  c.fillText('Toque para jogar de novo', cx, y + 152);
  c.restore();
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export default function Corredor(props: JogoProps) {
  const { recorde, aoTerminar } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordeRef = useRef(recorde);
  const aoTerminarRef = useRef(aoTerminar);
  const jogoRef = useRef<Jogo>(novoJogo());
  const acoesRef = useRef<{ pressionar: () => void; soltar: () => void } | null>(null);
  const [pontosHud, setPontosHud] = useState(0);
  const [melhorLocal, setMelhorLocal] = useState(0);

  useEffect(() => {
    recordeRef.current = recorde;
  }, [recorde]);
  useEffect(() => {
    aoTerminarRef.current = aoTerminar;
  }, [aoTerminar]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = prepararCanvas(canvas);
    if (!ctx) return;
    const reduzir = prefereMenosMovimento();
    const fator = reduzir ? 0.35 : 1;
    jogoRef.current = novoJogo();
    const cam: Camadas = {
      ceu: criarCamada(LARGURA, CHAO, pintarCeu),
      longe: criarCamada(PF, CHAO, pintarLonge),
      meio: criarCamada(PM, CHAO, pintarMeio),
    };
    let vivo = true;
    // refaz a fachada quando a fonte serifada terminar de carregar (letreiro "PADARIA")
    try {
      document.fonts?.ready.then(() => {
        if (vivo) cam.meio = criarCamada(PM, CHAO, pintarMeio);
      });
    } catch {
      /* sem API de fontes: segue com a fonte de reserva */
    }

    let raf = 0;
    let ultimo = performance.now();
    let acc = 0;
    let hudT = 0;
    let hudUlt = -1;

    const particulas = (
      j: Jogo,
      tipo: TipoParticula,
      x: number,
      y: number,
      n: number,
      opt: { vx?: [number, number]; vy?: [number, number]; r?: [number, number]; vida?: [number, number]; cor?: string[] },
    ) => {
      const qtd = Math.max(1, Math.round(n * fator));
      for (let i = 0; i < qtd; i++) {
        const rg = (p: [number, number] | undefined, d: number) => (p ? lerp(p[0], p[1], Math.random()) : d);
        const cores = opt.cor ?? ['#FFFFFF'];
        j.parts.push({
          tipo,
          x,
          y,
          vx: rg(opt.vx, 0),
          vy: rg(opt.vy, 0),
          r: rg(opt.r, 3),
          vida: 0,
          max: rg(opt.vida, 0.5),
          rot: Math.random() * Math.PI,
          cor: cores[Math.floor(Math.random() * cores.length)],
        });
      }
    };

    const texto = (j: Jogo, x: number, y: number, txt: string, cor: string, tam = 15, dur = 0.9) => {
      j.textos.push({ x, y, txt, t: 0, dur, cor, tam });
    };

    const iniciar = (j: Jogo) => {
      j.estado = 'jogando';
      j.t = 0;
      j.dist = 0;
      j.vel = VEL0;
      j.py = CHAO;
      j.vy = 0;
      j.noChao = true;
      j.tSeg = 0;
      j.buffer = 0;
      j.sq = 0;
      j.sqV = 0;
      j.est = 0;
      j.obst = [];
      j.trigos = [];
      j.textos = [];
      j.ultimaSaida = 2.1;
      j.gap = 0.4;
      j.plano = planejar(0);
      j.proxTrigo = 1.8;
      j.trigosPegos = 0;
      j.tremor = 0;
      j.tFim = 0;
      j.morto = false;
      j.fim = null;
      j.marcos = 0;
      hudUlt = 0;
      setPontosHud(0);
    };

    const terminar = (j: Jogo) => {
      if (j.estado !== 'jogando') return;
      const pontos = pontosDe(j);
      const novo = pontos > 0 && pontos > recordeRef.current;
      j.estado = 'fim';
      j.morto = true;
      j.tFim = 0;
      j.vel = 0;
      j.segurando = false;
      j.fim = { pontos, novo };
      j.tremor = reduzir ? 0 : 1;
      particulas(j, 'migalha', PX + 6, j.py - 14, 12, {
        vx: [-160, 200],
        vy: [-320, -120],
        r: [1.2, 2.4],
        vida: [0.7, 1.2],
        cor: ['#B8732A', '#D9A050', '#8A5418', '#F0D27A'],
      });
      particulas(j, 'farinha', PX, j.py - 10, 8, { vx: [-70, 70], vy: [-60, -10], r: [3, 6], vida: [0.5, 0.9] });
      setPontosHud(pontos);
      setMelhorLocal((m) => Math.max(m, pontos));
      aoTerminarRef.current(pontos);
    };

    const pular = (j: Jogo) => {
      j.vy = -V_PULO;
      j.noChao = false;
      j.buffer = 0;
      j.tSeg = 0;
      j.sqV -= 3;
      particulas(j, 'farinha', PX - 4, CHAO - 2, 5, { vx: [-90, 30], vy: [-40, -5], r: [2.5, 4.5], vida: [0.35, 0.6] });
    };

    const passo = (j: Jogo, h: number) => {
      j.tg += h;
      if (j.estado === 'jogando') {
        j.t += h;
        j.vel = velocidade(j.t);
        j.dist += j.vel * h;
        if (j.marcos < 1 && j.t >= 30) {
          j.marcos = 1;
          texto(j, LARGURA / 2, 78, 'Mais rápido!', COR.douradoClaro, 18, 1.3);
        } else if (j.marcos < 2 && j.t >= 60) {
          j.marcos = 2;
          texto(j, LARGURA / 2, 78, 'Mais rápido ainda!', COR.douradoClaro, 18, 1.3);
        }
      } else if (j.estado === 'pronto') {
        j.vel = 70;
      } else {
        j.tFim += h;
      }
      j.scroll += j.vel * h;

      // novos obstáculos: só nascem quando a chegada respeita o intervalo mínimo
      if (j.estado === 'jogando') {
        const p = j.plano;
        const v = j.vel * p.mult;
        const xs = LARGURA + 14;
        // A velocidade cresce enquanto o obstáculo atravessa a tela: estimamos a chegada
        // com a velocidade de daqui a ~1,2 s (chegada mais cedo = intervalo real maior)
        // e a saída com a velocidade atual (saída mais tarde) — as duas a favor do jogador.
        const vFut = velocidade(j.t + 1.2) * p.mult;
        const chegadaCedo = j.t + (xs - (PX + HB_MEIA)) / vFut;
        const chegada = j.t + (xs - (PX + HB_MEIA)) / v;
        if (chegadaCedo >= j.ultimaSaida + j.gap) {
          for (const it of p.itens) {
            j.obst.push({
              tipo: it.tipo,
              x: xs + it.dx,
              w: it.w,
              h: it.h,
              mult: p.mult,
              ang: 0,
              folga: Infinity,
              passou: false,
              semente: Math.random(),
            });
          }
          j.ultimaSaida = chegada + (p.largura + 2 * HB_MEIA) / v;
          j.gap = GAP_MIN + Math.random() * lerp(1.15, 0.4, Math.min(1, j.t / 90));
          j.plano = planejar(j.t);
        }
        j.proxTrigo -= h;
        if (j.proxTrigo <= 0) {
          const xt = LARGURA + 24;
          if (j.t > 8 && Math.random() < 0.3) {
            const base = 128 + Math.random() * 40;
            for (let i = 0; i < 3; i++) j.trigos.push({ x: xt + i * 30, y: base - Math.sin((i / 2) * Math.PI) * 22, fase: Math.random() * 6 });
          } else {
            j.trigos.push({ x: xt, y: 100 + Math.random() * 75, fase: Math.random() * 6 });
          }
          j.proxTrigo = 1.2 + Math.random() * 1.6;
        }
      }

      // mover obstáculos e trigos
      for (const o of j.obst) {
        const v = j.vel * o.mult;
        o.x -= v * h;
        if (o.tipo === 'bobina') o.ang -= (v / 15) * h;
      }
      compactar(j.obst, (o) => o.x + o.w + 70 > 0);
      for (const t of j.trigos) t.x -= j.vel * h;
      compactar(j.trigos, (t) => t.x > -30);

      // pão: pulo com altura variável
      j.buffer = Math.max(0, j.buffer - h);
      if (j.estado === 'jogando' && j.buffer > 0 && j.noChao) pular(j);
      if (!j.noChao) {
        const aliviar = j.segurando && j.vy < 0 && j.tSeg < SEGURAR_MAX && !j.morto;
        j.tSeg += h;
        j.vy += (aliviar ? GRAV * GRAV_SEGURANDO : GRAV) * h;
        j.py += j.vy * h;
        if (j.py >= CHAO) {
          const impacto = j.vy;
          j.py = CHAO;
          j.vy = 0;
          j.noChao = true;
          if (!j.morto) j.sqV += clamp(impacto / 110, 2, 8);
          particulas(j, 'farinha', PX, CHAO - 2, 6, { vx: [-80, 80], vy: [-30, -5], r: [2.5, 4.5], vida: [0.35, 0.6] });
        }
      }
      // mola do squash & stretch
      j.sqV += (-520 * j.sq - 15 * j.sqV) * h;
      j.sq += j.sqV * h;
      const alvoEst = j.noChao ? 0 : clamp(-j.vy / 2800, -0.1, 0.2);
      j.est += (alvoEst - j.est) * Math.min(1, h * 18);
      if (j.noChao && !j.morto) j.fase += h * (8 + j.vel / 28);
      j.piscar -= h;
      if (j.piscar < -0.12) j.piscar = 2.4 + Math.random() * 2.2;
      if (j.estado === 'jogando' && j.noChao && !reduzir) {
        j.tPassos += h;
        if (j.tPassos > 0.24) {
          j.tPassos = 0;
          particulas(j, 'farinha', PX - 10, CHAO - 1, 1, { vx: [-40, -10], vy: [-20, -5], r: [1.5, 2.5], vida: [0.25, 0.4] });
        }
      }

      // colisões e coletas
      if (j.estado === 'jogando') {
        const L = PX - HB_MEIA;
        const R = PX + HB_MEIA;
        const T = j.py - 22;
        const B = j.py - 2;
        const bate = (rx: number, ry: number, rw: number, rh: number) => L < rx + rw && R > rx && T < ry + rh && B > ry;
        for (const o of j.obst) {
          let hit = false;
          if (o.tipo === 'carimbo') {
            hit = bate(o.x + 3, CHAO - 27, o.w - 6, 27) || bate(o.x + o.w / 2 - 7, CHAO - o.h + 2, 14, o.h - 27);
          } else if (o.tipo === 'notas') {
            hit = bate(o.x + 3, CHAO - o.h + 3, o.w - 6, o.h - 3);
          } else {
            const cx = o.x + 15;
            const cy = CHAO - 15;
            const qx = clamp(cx, L, R);
            const qy = clamp(cy, T, B);
            hit = (cx - qx) ** 2 + (cy - qy) ** 2 < 13 * 13;
          }
          if (hit) {
            terminar(j);
            break;
          }
          if (R > o.x && L < o.x + o.w) o.folga = Math.min(o.folga, CHAO - o.h - j.py);
          if (!o.passou && o.x + o.w < L) {
            o.passou = true;
            if (o.folga < 7) texto(j, PX + 10, j.py - 44, 'Por um triz!', COR.papel, 13, 0.8);
          }
        }
      }
      if (j.estado === 'jogando') {
        const cy = j.py - 13;
        compactar(j.trigos, (t) => {
          const ty = t.y + Math.sin(j.tg * 3 + t.fase) * 3;
          if ((t.x - PX) ** 2 + (ty - cy) ** 2 < 22 * 22) {
            j.trigosPegos++;
            texto(j, t.x, ty - 12, '+5', COR.douradoClaro, 16, 0.8);
            particulas(j, 'brilho', t.x, ty, 9, {
              vx: [-120, 120],
              vy: [-140, 60],
              r: [2.5, 5],
              vida: [0.4, 0.7],
              cor: ['#F0D27A', '#FFF4CF', '#C9A227'],
            });
            return false;
          }
          return true;
        });
      }

      // partículas e textos
      for (const p of j.parts) {
        p.vida += h;
        if (p.tipo === 'farinha') {
          p.vx *= 1 - 3 * h;
          p.vy *= 1 - 3 * h;
          p.vy -= 12 * h;
        } else if (p.tipo === 'brilho') {
          p.vx *= 1 - 4 * h;
          p.vy *= 1 - 4 * h;
          p.vy += 60 * h;
          p.rot += 4 * h;
        } else {
          p.vy += 900 * h;
          if (p.y > CHAO - p.r && p.vy > 0) {
            p.y = CHAO - p.r;
            p.vy *= -0.35;
            p.vx *= 0.6;
          }
        }
        p.x += p.vx * h - j.vel * h * (p.tipo === 'brilho' ? 0.5 : 1);
        p.y += p.vy * h;
      }
      compactar(j.parts, (p) => p.vida < p.max);
      for (const t of j.textos) t.t += h;
      compactar(j.textos, (t) => t.t < t.dur);
      j.tremor = Math.max(0, j.tremor - h * 3.2);
    };

    const quadro = (agora: number) => {
      const j = jogoRef.current;
      let dt = (agora - ultimo) / 1000;
      ultimo = agora;
      dt = clamp(dt, 0, 1 / 30);
      acc += dt;
      while (acc >= PASSO) {
        passo(j, PASSO);
        acc -= PASSO;
      }
      desenhar(ctx, j, cam, reduzir, recordeRef.current);
      if (j.estado === 'jogando') {
        hudT += dt;
        if (hudT >= 0.1) {
          hudT = 0;
          const p = pontosDe(j);
          if (p !== hudUlt) {
            hudUlt = p;
            setPontosHud(p);
          }
        }
      }
      raf = requestAnimationFrame(quadro);
    };

    const pressionar = () => {
      const j = jogoRef.current;
      j.segurando = true;
      if (j.estado === 'pronto') iniciar(j);
      else if (j.estado === 'jogando') j.buffer = BUFFER_PULO;
      else if (j.tFim > 0.6) iniciar(j);
    };
    const soltar = () => {
      jogoRef.current.segurando = false;
    };
    acoesRef.current = { pressionar, soltar };

    const ehCampo = (alvo: EventTarget | null) => {
      const el = alvo as HTMLElement | null;
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!TECLAS.has(e.code) || ehCampo(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      pressionar();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!TECLAS.has(e.code) || ehCampo(e.target)) return;
      e.preventDefault();
      soltar();
    };
    const onBlur = () => soltar();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    raf = requestAnimationFrame(quadro);

    return () => {
      vivo = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      acoesRef.current = null;
    };
  }, []);

  return (
    <div className="w-full select-none">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Pãozinho Corredor: pule os obstáculos e colha trigo"
        className="block aspect-[2/1] w-full touch-none select-none rounded-xl border border-[#E5E0D6] bg-[#17150F]"
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* captura opcional */
          }
          acoesRef.current?.pressionar();
        }}
        onPointerUp={() => acoesRef.current?.soltar()}
        onPointerCancel={() => acoesRef.current?.soltar()}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[13px] text-[#5E594F]">
        <span>Espaço, ↑ ou toque para pular · segure para ir mais alto</span>
        <span>
          Pontos <span className="font-semibold tabular-nums text-[#8A6D0F]">{fmt(pontosHud)}</span> · Recorde{' '}
          <span className="font-semibold tabular-nums text-[#8A6D0F]">{fmt(Math.max(recorde, melhorLocal))}</span>
        </span>
      </div>
    </div>
  );
}
