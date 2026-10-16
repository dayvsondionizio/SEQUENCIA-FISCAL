// "Caça à Sequência" — notas fiscais caem do alto e o jogador precisa pegar, com a
// cesta de padaria, somente a PRÓXIMA nota da numeração. Iscas: números fora de ordem
// (vizinhos do esperado) e notas carimbadas "INUTILIZADA". Tudo desenhado em canvas 2D.

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as PointerEventReact } from 'react';
import { ALTURA, COR, FONTE, FONTE_SERIFA, LARGURA, prepararCanvas, prefereMenosMovimento, pontoNoQuadro } from './tipos';
import type { JogoProps } from './tipos';

// ───────────────────────── constantes do quadro ─────────────────────────

const HUD_A = 32;
const BALCAO_Y = 262;
const RIM_Y = 236; // borda de cima da cesta
const CESTA_ALT = 30;
const CESTA_MEIA = 46; // meia largura da boca da cesta
const PEGA_MEIA = 44; // tolerância horizontal para pegar
const NOTA_L = 50;
const NOTA_A = 60;
const VIDAS = 3;
const MAX_COMBO = 5;
const VEL_TECLADO = 520;

// ───────────────────────── tipos internos ─────────────────────────

type Fase = 'pronto' | 'jogando' | 'fim';

interface Nota {
  id: number;
  num: number;
  inutil: boolean;
  /** A nota "oficial" da sequência — se cair no chão, conta como faltante. */
  obrigatoria: boolean;
  x: number;
  y: number;
  dx: number;
  rot: number;
  fator: number;
  fase: number;
  freq: number;
  tv: number;
  estado: 'caindo' | 'pega' | 'erro';
  t: number;
  px: number;
  py: number;
  offX: number;
  remover: boolean;
}

interface Particula {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  vida: number;
  max: number;
  tam: number;
  cor: string;
  tipo: 'brilho' | 'migalha';
  rot: number;
  vr: number;
}

interface Texto {
  txt: string;
  x: number;
  y: number;
  cor: string;
  tam: number;
  serifa: boolean;
  t: number;
  dur: number;
  sobe: number;
}

interface Poeira {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  fase: number;
  a: number;
}

interface Estado {
  fase: Fase;
  t: number;
  relogio: number;
  tempoJogo: number;
  esperado: number;
  vidas: number;
  combo: number;
  pontos: number;
  acertos: number;
  notas: Nota[];
  particulas: Particula[];
  textos: Texto[];
  poeira: Poeira[];
  cesta: { x: number; alvo: number; vx: number; mola: number; molaV: number; inclina: number };
  teclas: { esq: boolean; dir: boolean };
  usandoTeclado: boolean;
  certaTimer: number | null;
  iscaTimer: number;
  tremor: number;
  brilho: number;
  brilhoErro: number;
  encerrando: number | null;
  recordeInicio: number;
  terminou: boolean;
  novoRecorde: boolean;
  vidaPerdidaT: number[];
  proximaT: number;
  idSeq: number;
  papeis: number;
}

// ───────────────────────── utilidades ─────────────────────────

const ale = (a: number, b: number) => a + Math.random() * (b - a);
const limitar = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

function caminhoArred(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function dificuldade(t: number) {
  const k = 1 - Math.exp(-t / 70);
  return {
    // px/s — depois de 1min30 ainda sobe um pouco (teto +40) para a partida não ser eterna;
    // no máximo (~222 px/s) a queda leva ~1,1 s, tempo suficiente para cruzar o quadro.
    vel: 58 + 120 * k + Math.min(40, Math.max(0, t - 90) * 0.5),
    intervalo: 2.1 - 1.25 * (1 - Math.exp(-t / 55)), // s entre iscas
    maxNotas: Math.min(7, 3 + Math.floor(t / 22)),
    pInutil: 0.22 + 0.16 * Math.min(1, t / 100),
  };
}

function criarPoeira(qtd: number): Poeira[] {
  const lista: Poeira[] = [];
  for (let i = 0; i < qtd; i++) {
    lista.push({
      x: ale(0, LARGURA),
      y: ale(HUD_A, BALCAO_Y),
      r: ale(0.7, 1.8),
      vx: ale(-4, 4),
      vy: ale(3, 9),
      fase: ale(0, Math.PI * 2),
      a: ale(0.12, 0.35),
    });
  }
  return lista;
}

function novoEstado(fase: Fase, cestaX: number, recorde: number): Estado {
  return {
    fase,
    t: 0,
    relogio: 0,
    tempoJogo: 0,
    esperado: 1001 + Math.floor(Math.random() * 999),
    vidas: VIDAS,
    combo: 1,
    pontos: 0,
    acertos: 0,
    notas: [],
    particulas: [],
    textos: [],
    poeira: [],
    cesta: { x: cestaX, alvo: cestaX, vx: 0, mola: 0, molaV: 0, inclina: 0 },
    teclas: { esq: false, dir: false },
    usandoTeclado: false,
    certaTimer: 0.7,
    iscaTimer: 2.6,
    tremor: 0,
    brilho: 0,
    brilhoErro: 0,
    encerrando: null,
    recordeInicio: recorde,
    terminou: false,
    novoRecorde: false,
    vidaPerdidaT: [9, 9, 9],
    proximaT: 0,
    idSeq: 1,
    papeis: 0,
  };
}

function novaPartida(ant: Estado, recorde: number): Estado {
  const s = novoEstado('jogando', ant.cesta.x, recorde);
  s.cesta.alvo = ant.cesta.alvo;
  s.teclas = ant.teclas;
  s.usandoTeclado = ant.usandoTeclado;
  s.poeira = ant.poeira;
  s.relogio = ant.relogio;
  return s;
}

// ───────────────────────── regras ─────────────────────────

function numeroIsca(esp: number): number {
  const txt = String(esp);
  const n = txt.length;
  if (Math.random() < 0.2 && txt[n - 1] !== txt[n - 2]) {
    // dígitos finais trocados (1045 ↔ 1054): a confusão clássica de digitação
    return Number(txt.slice(0, n - 2) + txt[n - 1] + txt[n - 2]);
  }
  const deslocamentos = [-1, -2, -3, 1, 1, 2, 2, 3];
  return esp + deslocamentos[Math.floor(Math.random() * deslocamentos.length)];
}

/** Escolhe um x longe das notas que ainda estão no alto, para nunca empilhar iscas sobre a certa. */
function escolherX(s: Estado): number {
  let melhor = LARGURA / 2;
  let melhorD = -1;
  for (let i = 0; i < 24; i++) {
    const x = ale(36, LARGURA - 36);
    let d = 999;
    for (const n of s.notas) if (n.estado === 'caindo' && n.y < 140) d = Math.min(d, Math.abs(n.x - x));
    if (d >= 84) return x;
    if (d > melhorD) {
      melhorD = d;
      melhor = x;
    }
  }
  return melhor;
}

function criarNota(s: Estado, num: number, inutil: boolean, obrigatoria: boolean) {
  s.notas.push({
    id: s.idSeq++,
    num,
    inutil,
    obrigatoria,
    x: escolherX(s),
    y: -NOTA_A / 2 - 6,
    dx: 0,
    rot: 0,
    fator: obrigatoria ? ale(0.96, 1.02) : ale(0.92, 1.08),
    fase: ale(0, Math.PI * 2),
    freq: ale(1.4, 2.2),
    tv: 0,
    estado: 'caindo',
    t: 0,
    px: 0,
    py: 0,
    offX: 0,
    remover: false,
  });
}

function texto(txt: string, x: number, y: number, cor: string, tam: number, serifa: boolean, dur: number, sobe: number): Texto {
  return { txt, x: limitar(x, 70, LARGURA - 70), y, cor, tam, serifa, t: 0, dur, sobe };
}

function brilhos(s: Estado, x: number, y: number, qtd: number, cores: string[], reduz: boolean) {
  const n = reduz ? Math.ceil(qtd / 4) : qtd;
  for (let i = 0; i < n && s.particulas.length < 180; i++) {
    const ang = ale(0, Math.PI * 2);
    const v = ale(40, 150);
    s.particulas.push({
      x,
      y,
      vx: Math.cos(ang) * v,
      vy: Math.sin(ang) * v - 70,
      g: 170,
      vida: 0,
      max: ale(0.45, 0.85),
      tam: ale(1.6, 3.4),
      cor: cores[i % cores.length],
      tipo: 'brilho',
      rot: ale(0, Math.PI),
      vr: ale(-6, 6),
    });
  }
}

function migalhas(s: Estado, x: number, y: number, qtd: number, reduz: boolean) {
  const n = reduz ? Math.ceil(qtd / 4) : qtd;
  const cores = ['#C08A47', '#E2B36A', '#8E5C2C', '#F0D27A'];
  for (let i = 0; i < n && s.particulas.length < 180; i++) {
    s.particulas.push({
      x: x + ale(-10, 10),
      y,
      vx: ale(-95, 95),
      vy: -ale(60, 170),
      g: 560,
      vida: 0,
      max: ale(0.5, 0.9),
      tam: ale(1.4, 2.8),
      cor: cores[i % cores.length],
      tipo: 'migalha',
      rot: ale(0, Math.PI),
      vr: ale(-10, 10),
    });
  }
}

function perderVida(s: Estado, msg: string, x: number, y: number, reduz: boolean) {
  if (s.vidas <= 0) return;
  s.vidas--;
  s.vidaPerdidaT[s.vidas] = 0;
  s.combo = 1;
  s.tremor = reduz ? 0 : 1;
  s.brilhoErro = 1;
  s.textos.push(texto(msg, x, y, COR.rosa, 16, true, 1.25, 24));
  if (s.vidas === 0) s.encerrando = 1.0;
}

function pegar(s: Estado, n: Nota, nx: number, reduz: boolean) {
  const c = s.cesta;
  if (!n.inutil && n.num === s.esperado) {
    const ganho = 10 * s.combo;
    s.pontos += ganho;
    s.acertos++;
    s.textos.push(texto(`+${ganho}`, nx, RIM_Y - 40, COR.verde, 22, true, 0.9, 34));
    if (s.combo < MAX_COMBO) {
      s.combo++;
      if (s.combo === MAX_COMBO) s.textos.push(texto('Perfeito!', c.x, RIM_Y - 78, COR.douradoTexto, 18, true, 1.2, 26));
      else s.textos.push(texto(`Combo ×${s.combo}`, c.x, RIM_Y - 74, COR.douradoTexto, 12, false, 0.95, 22));
    }
    s.esperado++;
    s.proximaT = 0;
    s.certaTimer = 0.35; // a próxima certa já vem logo
    n.estado = 'pega';
    n.t = 0;
    n.px = nx;
    n.py = n.y;
    s.brilho = 1;
    c.molaV += 6.5;
    s.papeis = Math.min(6, s.papeis + 1);
    brilhos(s, nx, RIM_Y - 8, 16, [COR.douradoClaro, COR.dourado, COR.verde, '#FFFFFF'], reduz);
  } else {
    n.estado = 'erro';
    n.t = 0;
    n.offX = limitar(nx - c.x, -26, 26);
    c.molaV += 9;
    const msg = n.inutil ? 'Inutilizada!' : n.num < s.esperado ? 'Repetida!' : 'Fora de ordem!';
    perderVida(s, msg, nx, RIM_Y - 54, reduz);
    migalhas(s, nx, RIM_Y - 4, 10, reduz);
  }
}

function caiuNoChao(s: Estado, n: Nota, nx: number, reduz: boolean) {
  if (n.inutil || !n.obrigatoria || n.num !== s.esperado) return;
  // Se ainda há outra nota válida com o mesmo número caindo (uma isca que virou a
  // certa depois de um acerto), ela passa a ser a oficial — sem punir o jogador.
  const outra = s.notas.find((m) => m !== n && !m.remover && m.estado === 'caindo' && !m.inutil && m.num === s.esperado);
  if (outra) {
    outra.obrigatoria = true;
    return;
  }
  perderVida(s, 'Nota faltante!', nx, BALCAO_Y - 34, reduz);
  s.certaTimer = 1.0; // a mesma nota volta a cair daqui a pouco
  migalhas(s, nx, BALCAO_Y, 6, reduz);
}

function moverCesta(s: Estado, dt: number) {
  const c = s.cesta;
  const xAntes = c.x;
  const dir = (s.teclas.dir ? 1 : 0) - (s.teclas.esq ? 1 : 0);
  if (dir !== 0) {
    // Inverter o sentido corta o embalo na hora (independe da taxa de quadros).
    if (c.vx * dir < 0) c.vx = 0;
    c.vx = limitar(c.vx + dir * 2800 * dt, -VEL_TECLADO, VEL_TECLADO);
    c.x += c.vx * dt;
    c.alvo = c.x;
  } else if (s.usandoTeclado) {
    c.vx *= Math.exp(-14 * dt);
    c.x += c.vx * dt;
    c.alvo = c.x;
  } else {
    c.x += (c.alvo - c.x) * (1 - Math.exp(-16 * dt));
  }
  const min = CESTA_MEIA + 4;
  const max = LARGURA - CESTA_MEIA - 4;
  if (c.x < min || c.x > max) {
    c.x = limitar(c.x, min, max);
    c.vx = 0;
  }
  c.alvo = limitar(c.alvo, min, max);
  const vel = dt > 0 ? (c.x - xAntes) / dt : 0;
  if (!s.usandoTeclado) c.vx = vel;
  c.inclina += (limitar(vel / 2200, -0.1, 0.1) - c.inclina) * (1 - Math.exp(-10 * dt));
  // mola do squash & stretch (integração semi-implícita, estável com dt ≤ 1/30)
  c.molaV += (-300 * c.mola - 15 * c.molaV) * dt;
  c.mola = limitar(c.mola + c.molaV * dt, -0.5, 0.6);
}

/** Avança a simulação. Devolve true no exato quadro em que a partida termina. */
function atualizar(s: Estado, dt: number, reduz: boolean): boolean {
  s.relogio += dt;
  s.t += dt;

  for (const p of s.poeira) {
    p.y -= p.vy * dt * (reduz ? 0.3 : 1);
    p.x += (p.vx + Math.sin(s.relogio * 0.6 + p.fase) * 5) * dt * (reduz ? 0.3 : 1);
    if (p.y < HUD_A - 4) p.y = BALCAO_Y;
    if (p.x < -4) p.x = LARGURA + 4;
    if (p.x > LARGURA + 4) p.x = -4;
  }

  moverCesta(s, dt);

  for (const p of s.particulas) {
    p.vida += dt;
    p.vy += p.g * dt;
    p.vx *= Math.exp(-1.6 * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
  }
  s.particulas = s.particulas.filter((p) => p.vida < p.max && p.y < ALTURA + 10);
  for (const tx of s.textos) tx.t += dt;
  s.textos = s.textos.filter((tx) => tx.t < tx.dur);
  s.tremor = Math.max(0, s.tremor - dt * 2.8);
  s.brilho = Math.max(0, s.brilho - dt * 2.2);
  s.brilhoErro = Math.max(0, s.brilhoErro - dt * 2);
  for (let i = 0; i < s.vidaPerdidaT.length; i++) s.vidaPerdidaT[i] += dt;
  s.proximaT += dt;

  if (s.fase !== 'jogando') return false;

  const ativo = s.encerrando === null;
  if (ativo) s.tempoJogo += dt;
  const d = dificuldade(s.tempoJogo);
  const c = s.cesta;

  for (const n of s.notas) {
    n.tv += dt;
    if (n.estado === 'caindo') {
      const fundoAntes = n.y + NOTA_A / 2;
      n.y += d.vel * n.fator * dt * (ativo ? 1 : 0.35);
      n.dx = Math.sin(n.fase + n.tv * n.freq) * 7;
      n.rot = Math.sin(n.fase * 1.7 + n.tv * n.freq * 1.15) * 0.15;
      const nx = n.x + n.dx;
      const fundo = n.y + NOTA_A / 2;
      if (ativo && fundo >= RIM_Y + 2 && fundoAntes <= RIM_Y + 20 && Math.abs(nx - c.x) < PEGA_MEIA) {
        pegar(s, n, nx, reduz);
      } else if (n.y - NOTA_A / 2 > BALCAO_Y) {
        n.remover = true;
        if (ativo) caiuNoChao(s, n, nx, reduz);
      }
    } else {
      n.t += dt;
      if ((n.estado === 'pega' && n.t > 0.3) || (n.estado === 'erro' && n.t > 0.62)) n.remover = true;
    }
  }
  s.notas = s.notas.filter((n) => !n.remover);

  if (s.encerrando === null) {
    // Garante que a próxima nota certa esteja sempre caindo (ou prestes a cair).
    const temValida = s.notas.some((n) => n.estado === 'caindo' && !n.inutil && n.num === s.esperado);
    if (!temValida && s.certaTimer === null) s.certaTimer = 0.45;
    if (s.certaTimer !== null) {
      s.certaTimer -= dt;
      if (s.certaTimer <= 0) {
        s.certaTimer = null;
        if (!temValida) criarNota(s, s.esperado, false, true);
      }
    }
    // Iscas: fora de ordem e inutilizadas, cada vez mais frequentes.
    s.iscaTimer -= dt;
    if (s.iscaTimer <= 0) {
      const caindo = s.notas.filter((n) => n.estado === 'caindo').length;
      if (caindo < d.maxNotas) {
        const inutil = Math.random() < d.pInutil;
        const num = inutil ? (Math.random() < 0.6 ? s.esperado : numeroIsca(s.esperado)) : numeroIsca(s.esperado);
        criarNota(s, num, inutil, false);
      }
      s.iscaTimer = d.intervalo * ale(0.75, 1.25);
    }
  } else {
    s.encerrando -= dt;
    if (s.encerrando <= 0) {
      s.fase = 'fim';
      s.t = 0;
      s.novoRecorde = s.pontos > 0 && s.pontos > s.recordeInicio;
      if (s.novoRecorde) brilhos(s, LARGURA / 2, 130, 30, [COR.douradoClaro, COR.dourado, '#FFFFFF'], reduz);
      if (!s.terminou) {
        s.terminou = true;
        return true;
      }
    }
  }
  return false;
}

// ───────────────────────── desenho ─────────────────────────

function desenharFundo(ctx: CanvasRenderingContext2D, s: Estado) {
  const g = ctx.createLinearGradient(0, 0, 0, BALCAO_Y);
  g.addColorStop(0, '#FCF9F2');
  g.addColorStop(1, '#F0E7D6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LARGURA, ALTURA);

  // azulejos de padaria, bem discretos
  ctx.strokeStyle = 'rgba(138,109,15,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let linha = 0;
  for (let y = 40; y < BALCAO_Y; y += 16, linha++) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(LARGURA, y + 0.5);
    const off = linha % 2 ? 16 : 0;
    for (let x = off; x < LARGURA; x += 32) {
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, Math.min(y + 16, BALCAO_Y));
    }
  }
  ctx.stroke();

  // luz quente de janela
  const luz = ctx.createRadialGradient(130, -30, 10, 130, -30, 340);
  luz.addColorStop(0, 'rgba(240,210,122,0.38)');
  luz.addColorStop(0.5, 'rgba(240,210,122,0.12)');
  luz.addColorStop(1, 'rgba(240,210,122,0)');
  ctx.fillStyle = luz;
  ctx.fillRect(0, 0, LARGURA, BALCAO_Y);

  ctx.save();
  ctx.globalAlpha = 0.5;
  const facho = ctx.createLinearGradient(80, 0, 260, BALCAO_Y);
  facho.addColorStop(0, 'rgba(255,248,225,0.55)');
  facho.addColorStop(1, 'rgba(255,248,225,0)');
  ctx.fillStyle = facho;
  ctx.beginPath();
  ctx.moveTo(70, 0);
  ctx.lineTo(160, 0);
  ctx.lineTo(330, BALCAO_Y);
  ctx.lineTo(215, BALCAO_Y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // farinha flutuando
  for (const p of s.poeira) {
    const a = p.a * (0.6 + 0.4 * Math.sin(s.relogio * 1.3 + p.fase));
    ctx.fillStyle = `rgba(201,162,39,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function desenharBalcao(ctx: CanvasRenderingContext2D, s: Estado) {
  const topo = ctx.createLinearGradient(0, BALCAO_Y, 0, BALCAO_Y + 7);
  topo.addColorStop(0, '#E8D3AD');
  topo.addColorStop(1, '#D4B383');
  ctx.fillStyle = topo;
  ctx.fillRect(0, BALCAO_Y, LARGURA, 7);
  const frente = ctx.createLinearGradient(0, BALCAO_Y + 7, 0, ALTURA);
  frente.addColorStop(0, '#BF9461');
  frente.addColorStop(1, '#9B7143');
  ctx.fillStyle = frente;
  ctx.fillRect(0, BALCAO_Y + 7, LARGURA, ALTURA - BALCAO_Y - 7);
  ctx.fillStyle = 'rgba(255,245,220,0.6)';
  ctx.fillRect(0, BALCAO_Y, LARGURA, 1);
  ctx.fillStyle = 'rgba(80,50,20,0.25)';
  ctx.fillRect(0, BALCAO_Y + 7, LARGURA, 1);
  // veios da madeira
  ctx.strokeStyle = 'rgba(90,60,25,0.16)';
  ctx.lineWidth = 0.8;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    const base = BALCAO_Y + 11 + k * 3.5;
    for (let x = 0; x <= LARGURA; x += 14) {
      const y = base + Math.sin(x * 0.021 + k * 2.1) * 1.2 + Math.sin(x * 0.07 + k) * 0.5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // pão (bisnaga) no cantinho, com vapor
  const px = 40;
  const py = BALCAO_Y + 1;
  ctx.fillStyle = 'rgba(60,40,15,0.22)';
  ctx.beginPath();
  ctx.ellipse(px, py + 2, 25, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  const pao = ctx.createRadialGradient(px - 6, py - 12, 2, px, py - 6, 28);
  pao.addColorStop(0, '#F2C47A');
  pao.addColorStop(0.55, '#D2914A');
  pao.addColorStop(1, '#9C5F27');
  ctx.fillStyle = pao;
  ctx.beginPath();
  ctx.ellipse(px, py - 6, 24, 8.5, -0.04, Math.PI, Math.PI * 2);
  ctx.ellipse(px, py - 6, 24, 3.5, -0.04, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,230,180,0.75)';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(px + i * 11 - 4, py - 9);
    ctx.quadraticCurveTo(px + i * 11, py - 14, px + i * 11 + 5, py - 11);
    ctx.stroke();
  }
  const vapor = ctx.createLinearGradient(0, py - 12, 0, py - 48);
  vapor.addColorStop(0, 'rgba(150,130,100,0.22)');
  vapor.addColorStop(1, 'rgba(150,130,100,0)');
  ctx.strokeStyle = vapor;
  ctx.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const p = i / 12;
      const yy = py - 13 - p * 34;
      const xx = px - 8 + k * 8 + Math.sin(p * 5 + s.relogio * 1.8 + k * 2) * 3 * (p + 0.3);
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function xadrez(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.fillStyle = '#FFFDF7';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = 'rgba(201,162,39,0.4)';
  for (let x = x0; x < x1; x += 8) ctx.fillRect(x, y0, 4, y1 - y0);
  for (let y = y0; y < y1; y += 8) ctx.fillRect(x0, y, x1 - x0, 4);
}

function comCesta(ctx: CanvasRenderingContext2D, s: Estado, f: () => void) {
  const c = s.cesta;
  ctx.save();
  ctx.translate(c.x, RIM_Y + CESTA_ALT);
  ctx.rotate(c.inclina);
  ctx.scale(1 + 0.22 * c.mola, 1 - 0.28 * c.mola);
  f();
  ctx.restore();
}

/** Parte de trás da cesta: interior, pano e as notas já guardadas. */
function desenharCestaFundo(ctx: CanvasRenderingContext2D, s: Estado) {
  const c = s.cesta;
  // sombra no balcão
  ctx.fillStyle = 'rgba(40,25,10,0.22)';
  ctx.beginPath();
  ctx.ellipse(c.x, BALCAO_Y + 5, 42 + 6 * Math.abs(c.mola), 4.5, 0, 0, Math.PI * 2);
  ctx.fill();

  if (s.brilho > 0 || s.brilhoErro > 0) {
    const verde = s.brilho >= s.brilhoErro;
    const a = (verde ? s.brilho : s.brilhoErro) * 0.32;
    const g = ctx.createRadialGradient(c.x, RIM_Y, 4, c.x, RIM_Y, 90);
    g.addColorStop(0, verde ? `rgba(5,150,105,${a})` : `rgba(225,29,72,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(c.x - 90, RIM_Y - 90, 180, 150);
  }

  comCesta(ctx, s, () => {
    const y = -CESTA_ALT;
    // interior escuro
    const fundo = ctx.createLinearGradient(0, y - 7, 0, y + 7);
    fundo.addColorStop(0, '#4A2E14');
    fundo.addColorStop(1, '#6E4620');
    ctx.fillStyle = fundo;
    ctx.beginPath();
    ctx.ellipse(0, y, 44, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // borda de trás
    ctx.strokeStyle = '#A9733A';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(0, y, 46, 6.5, 0, Math.PI, Math.PI * 2);
    ctx.stroke();
    // pano xadrez forrando
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, y - 1, 40, 9, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    xadrez(ctx, -42, y - 12, 42, y + 2);
    ctx.fillStyle = 'rgba(120,90,30,0.12)';
    ctx.fillRect(-42, y - 3, 84, 4);
    ctx.restore();
    // notas já guardadas aparecendo
    for (let i = 0; i < s.papeis; i++) {
      ctx.save();
      ctx.translate(-27 + i * 11, y - 3);
      ctx.rotate(((i % 3) - 1) * 0.22);
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = 'rgba(140,120,80,0.45)';
      ctx.lineWidth = 0.7;
      ctx.fillRect(-6.5, -10, 13, 16);
      ctx.strokeRect(-6.5, -10, 13, 16);
      ctx.fillStyle = 'rgba(201,162,39,0.55)';
      ctx.fillRect(-4, -7, 8, 1.4);
      ctx.restore();
    }
  });
}

/** Frente da cesta: vime trançado, borda torcida e as pontas do paninho. */
function desenharCestaFrente(ctx: CanvasRenderingContext2D, s: Estado) {
  comCesta(ctx, s, () => {
    const y = -CESTA_ALT;
    ctx.beginPath();
    ctx.moveTo(-CESTA_MEIA, y);
    ctx.lineTo(CESTA_MEIA, y);
    ctx.lineTo(37, -4);
    ctx.quadraticCurveTo(35, 0, 30, 0);
    ctx.lineTo(-30, 0);
    ctx.quadraticCurveTo(-35, 0, -37, -4);
    ctx.closePath();
    const corpo = ctx.createLinearGradient(0, y, 0, 0);
    corpo.addColorStop(0, '#CB9552');
    corpo.addColorStop(1, '#8C5A2A');
    ctx.fillStyle = corpo;
    ctx.fill();

    ctx.save();
    ctx.clip();
    // trama do vime
    let fileira = 0;
    for (let yy = y + 3; yy < 2; yy += 5.5, fileira++) {
      const off = fileira % 2 ? 5 : 0;
      for (let xx = -52 + off; xx < 52; xx += 10) {
        ctx.beginPath();
        ctx.ellipse(xx, yy, 4.6, 2.3, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(245,205,145,0.42)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(80,48,18,0.45)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,240,210,0.35)';
        ctx.fillRect(xx - 2.5, yy - 1.6, 5, 0.9);
      }
    }
    // volume: bordas laterais mais escuras
    const vol = ctx.createLinearGradient(-CESTA_MEIA, 0, CESTA_MEIA, 0);
    vol.addColorStop(0, 'rgba(55,30,8,0.42)');
    vol.addColorStop(0.3, 'rgba(55,30,8,0)');
    vol.addColorStop(0.7, 'rgba(55,30,8,0)');
    vol.addColorStop(1, 'rgba(55,30,8,0.42)');
    ctx.fillStyle = vol;
    ctx.fillRect(-CESTA_MEIA, y, CESTA_MEIA * 2, CESTA_ALT);
    ctx.restore();

    // borda torcida (frente)
    const aro = ctx.createLinearGradient(0, y - 4, 0, y + 7);
    aro.addColorStop(0, '#E4B36E');
    aro.addColorStop(1, '#9A6430');
    ctx.strokeStyle = aro;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(0, y, 46, 6.5, 0, 0, Math.PI);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,55,20,0.5)';
    ctx.lineWidth = 0.9;
    for (let a = 0.12; a < Math.PI; a += 0.2) {
      const ex = Math.cos(a) * 46;
      const ey = y + Math.sin(a) * 6.5;
      ctx.beginPath();
      ctx.moveTo(ex - 2, ey - 2.6);
      ctx.lineTo(ex + 2, ey + 2.6);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // pontas do paninho caindo por cima da borda
    const ponta = (pts: [number, number][]) => {
      ctx.save();
      ctx.shadowColor = 'rgba(60,35,10,0.3)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1.5;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = '#FFFDF7';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.clip();
      xadrez(ctx, -50, y - 6, 50, 0);
      const sombra = ctx.createLinearGradient(0, y, 0, y + 20);
      sombra.addColorStop(0, 'rgba(120,90,30,0)');
      sombra.addColorStop(1, 'rgba(120,90,30,0.18)');
      ctx.fillStyle = sombra;
      ctx.fillRect(-50, y - 6, 100, 30);
      ctx.restore();
      ctx.strokeStyle = 'rgba(138,109,15,0.45)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    };
    ponta([
      [-40, y + 1],
      [-15, y + 5],
      [-31, y + 19],
    ]);
    ponta([
      [12, y + 5],
      [41, y + 1],
      [29, y + 16],
    ]);
  });
}

function tracarNota(ctx: CanvasRenderingContext2D) {
  const hw = NOTA_L / 2;
  const hh = NOTA_A / 2;
  const f = 9;
  ctx.beginPath();
  ctx.moveTo(-hw + 3, -hh);
  ctx.lineTo(hw - f, -hh);
  ctx.lineTo(hw, -hh + f);
  ctx.lineTo(hw, hh - 3);
  ctx.quadraticCurveTo(hw, hh, hw - 3, hh);
  ctx.lineTo(-hw + 3, hh);
  ctx.quadraticCurveTo(-hw, hh, -hw, hh - 3);
  ctx.lineTo(-hw, -hh + 3);
  ctx.quadraticCurveTo(-hw, -hh, -hw + 3, -hh);
  ctx.closePath();
}

function pintarNota(
  ctx: CanvasRenderingContext2D,
  num: number,
  inutil: boolean,
  x: number,
  y: number,
  rot: number,
  esc: number,
  alfa: number,
  modo: 'normal' | 'certa' | 'erro',
) {
  const hw = NOTA_L / 2;
  const hh = NOTA_A / 2;
  const f = 9;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(esc, esc);
  ctx.globalAlpha *= alfa;

  tracarNota(ctx);
  ctx.save();
  if (modo === 'certa') {
    ctx.shadowColor = 'rgba(5,150,105,0.6)';
    ctx.shadowBlur = 16;
  } else {
    ctx.shadowColor = 'rgba(60,45,20,0.24)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 3;
  }
  const papel = ctx.createLinearGradient(0, -hh, 0, hh);
  papel.addColorStop(0, '#FFFFFF');
  papel.addColorStop(1, '#F6F1E6');
  ctx.fillStyle = papel;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(140,120,80,0.38)';
  ctx.stroke();

  // cantinho dobrado
  ctx.beginPath();
  ctx.moveTo(hw - f, -hh);
  ctx.lineTo(hw - f + 0.5, -hh + f - 0.5);
  ctx.lineTo(hw, -hh + f);
  ctx.closePath();
  const dobra = ctx.createLinearGradient(hw - f, -hh, hw, -hh + f);
  dobra.addColorStop(0, '#F1EBDD');
  dobra.addColorStop(1, '#D8CDB5');
  ctx.fillStyle = dobra;
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,120,80,0.4)';
  ctx.lineWidth = 0.6;
  ctx.stroke();

  // cabeçalho
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `700 6.5px ${FONTE}`;
  ctx.fillText('NF-e', -hw + 6, -hh + 8);
  ctx.fillStyle = 'rgba(201,162,39,0.6)';
  ctx.fillRect(-hw + 6, -hh + 14, NOTA_L - 18, 0.8);

  // número grande
  ctx.fillStyle = COR.texto3;
  ctx.font = `600 7px ${FONTE}`;
  ctx.fillText('Nº', -hw + 5, -2);
  ctx.fillStyle = COR.tinta;
  ctx.font = `700 16px ${FONTE_SERIFA}`;
  ctx.textAlign = 'center';
  ctx.fillText(String(num), 4, -2, 35);

  // linhas de texto de mentirinha
  ctx.fillStyle = 'rgba(120,110,90,0.2)';
  const larguras = [36, 29, 23];
  for (let i = 0; i < larguras.length; i++) {
    caminhoArred(ctx, -hw + 6, 9 + i * 5, larguras[i], 2, 1);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(120,110,90,0.18)';
  ctx.fillRect(-hw + 6, hh - 7, 11, 2);
  ctx.fillStyle = 'rgba(201,162,39,0.55)';
  ctx.fillRect(hw - 19, hh - 7.5, 13, 3);

  if (inutil) {
    ctx.save();
    ctx.translate(0, 7);
    ctx.rotate(-0.42);
    ctx.globalAlpha *= 0.9;
    ctx.strokeStyle = COR.rosa;
    ctx.lineWidth = 1.4;
    caminhoArred(ctx, -25, -7.5, 50, 15, 2.5);
    ctx.stroke();
    ctx.lineWidth = 0.6;
    caminhoArred(ctx, -23, -5.5, 46, 11, 1.5);
    ctx.stroke();
    ctx.fillStyle = COR.rosa;
    ctx.font = `800 6.6px ${FONTE}`;
    ctx.textAlign = 'center';
    ctx.fillText('INUTILIZADA', 0, 0.5, 42);
    ctx.restore();
  }

  if (modo === 'erro') {
    tracarNota(ctx);
    ctx.fillStyle = 'rgba(225,29,72,0.15)';
    ctx.fill();
    ctx.strokeStyle = COR.rosa;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

function desenharNotas(ctx: CanvasRenderingContext2D, s: Estado, reduz: boolean) {
  const c = s.cesta;
  for (const n of s.notas) {
    if (n.estado === 'caindo') {
      pintarNota(ctx, n.num, n.inutil, n.x + n.dx, n.y, n.rot, 1, 1, 'normal');
    } else if (n.estado === 'pega') {
      const p = Math.min(1, n.t / 0.3);
      const e = easeOutCubic(p);
      const x = n.px + (c.x - n.px) * e;
      const y = n.py + (RIM_Y + 4 - n.py) * p * p;
      pintarNota(ctx, n.num, n.inutil, x, y, n.rot * (1 - p), 1 - 0.6 * p, 1 - p * p, 'certa');
    } else {
      const p = Math.min(1, n.t / 0.62);
      const treme = reduz ? 0 : Math.sin(n.t * 55) * 4 * (1 - p);
      const alfa = n.t > 0.4 ? Math.max(0, 1 - (n.t - 0.4) / 0.22) : 1;
      pintarNota(ctx, n.num, n.inutil, c.x + n.offX + treme, RIM_Y - NOTA_A / 2 + 6 + p * 6, n.rot * 0.5, 1, alfa, 'erro');
    }
  }
}

function desenharParticulas(ctx: CanvasRenderingContext2D, s: Estado) {
  for (const p of s.particulas) {
    const a = 1 - p.vida / p.max;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.cor;
    if (p.tipo === 'brilho') {
      const r = p.tam * (0.6 + 0.4 * a);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.8);
      ctx.quadraticCurveTo(0, 0, r * 1.8, 0);
      ctx.quadraticCurveTo(0, 0, 0, r * 1.8);
      ctx.quadraticCurveTo(0, 0, -r * 1.8, 0);
      ctx.quadraticCurveTo(0, 0, 0, -r * 1.8);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.ellipse(0, 0, p.tam, p.tam * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function desenharTextos(ctx: CanvasRenderingContext2D, s: Estado) {
  for (const tx of s.textos) {
    const p = tx.t / tx.dur;
    const pop = easeOutBack(Math.min(1, tx.t / 0.22));
    const y = tx.y - tx.sobe * easeOutCubic(p);
    const a = p < 0.65 ? 1 : Math.max(0, 1 - (p - 0.65) / 0.35);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(tx.x, y);
    ctx.scale(pop, pop);
    ctx.font = `700 ${tx.tam}px ${tx.serifa ? FONTE_SERIFA : FONTE}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(252,251,248,0.92)';
    ctx.strokeText(tx.txt, 0, 0);
    ctx.fillStyle = tx.cor;
    ctx.fillText(tx.txt, 0, 0);
    ctx.restore();
  }
}

function desenharTrigo(ctx: CanvasRenderingContext2D, x: number, y: number, cheio: boolean, esc: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.14 + rot);
  ctx.scale(esc, esc);
  ctx.strokeStyle = cheio ? '#A88418' : '#D6CFC0';
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 12);
  ctx.quadraticCurveTo(1.2, 3, 0, -9);
  ctx.stroke();
  let grao: CanvasGradient | string = '#E5E0D6';
  if (cheio) {
    const g = ctx.createLinearGradient(0, -14, 0, 8);
    g.addColorStop(0, '#F0D27A');
    g.addColorStop(1, '#C9A227');
    grao = g;
  }
  ctx.fillStyle = grao;
  for (let i = 0; i < 4; i++) {
    const yy = 4 - i * 3.6;
    ctx.beginPath();
    ctx.ellipse(-2.5, yy, 1.9, 3.3, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(2.5, yy, 1.9, 3.3, 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(0, -11, 1.8, 3.1, 0, 0, Math.PI * 2);
  ctx.fill();
  // barbas
  ctx.strokeStyle = cheio ? 'rgba(168,132,24,0.75)' : 'rgba(200,192,175,0.8)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(0, -19);
  ctx.moveTo(-2.8, -6);
  ctx.lineTo(-6, -14);
  ctx.moveTo(2.8, -6);
  ctx.lineTo(6, -14);
  ctx.stroke();
  ctx.restore();
}

function desenharHud(ctx: CanvasRenderingContext2D, s: Estado) {
  const faixa = ctx.createLinearGradient(0, 0, 0, HUD_A + 6);
  faixa.addColorStop(0, 'rgba(252,251,248,0.96)');
  faixa.addColorStop(0.8, 'rgba(252,251,248,0.85)');
  faixa.addColorStop(1, 'rgba(252,251,248,0)');
  ctx.fillStyle = faixa;
  ctx.fillRect(0, 0, LARGURA, HUD_A + 6);

  // "Próxima: Nº 1004"
  const pp = Math.min(1, s.proximaT / 0.4);
  const pulso = 1 + 0.14 * Math.sin(Math.PI * pp) * (1 - pp * 0.3);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `600 11px ${FONTE}`;
  const rotulo = 'Próxima:';
  const wRot = ctx.measureText(rotulo).width;
  ctx.font = `700 18px ${FONTE_SERIFA}`;
  const numero = `Nº ${s.esperado}`;
  const wNum = ctx.measureText(numero).width;
  const largura = 12 + wRot + 6 + wNum + 12;
  ctx.save();
  ctx.translate(10 + largura / 2, 17);
  ctx.scale(pulso, pulso);
  ctx.translate(-largura / 2, 0);
  caminhoArred(ctx, 0, -12, largura, 24, 12);
  const fundo = ctx.createLinearGradient(0, -12, 0, 12);
  fundo.addColorStop(0, 'rgba(240,210,122,0.5)');
  fundo.addColorStop(1, 'rgba(240,210,122,0.28)');
  ctx.fillStyle = fundo;
  ctx.fill();
  ctx.strokeStyle = 'rgba(201,162,39,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (s.proximaT < 0.5) {
    ctx.save();
    ctx.globalAlpha = 1 - s.proximaT / 0.5;
    ctx.shadowColor = COR.douradoClaro;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = COR.texto2;
  ctx.font = `600 11px ${FONTE}`;
  ctx.fillText(rotulo, 12, 0.5);
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `700 18px ${FONTE_SERIFA}`;
  ctx.fillText(numero, 12 + wRot + 6, 1);
  ctx.restore();

  // combo no centro
  const cx = LARGURA / 2;
  ctx.textAlign = 'center';
  ctx.font = `700 11px ${FONTE}`;
  ctx.fillStyle = s.combo > 1 ? COR.douradoTexto : COR.texto3;
  ctx.fillText(`Combo ×${s.combo}`, cx, 11);
  for (let i = 0; i < MAX_COMBO; i++) {
    const x = cx - (MAX_COMBO * 13 - 3) / 2 + i * 13;
    caminhoArred(ctx, x, 20, 10, 4, 2);
    ctx.fillStyle = i < s.combo ? (s.combo === MAX_COMBO ? COR.dourado : COR.douradoClaro) : 'rgba(229,224,214,0.9)';
    ctx.fill();
  }

  // vidas: espigas de trigo
  for (let i = 0; i < VIDAS; i++) {
    const x = LARGURA - 20 - (VIDAS - 1 - i) * 19;
    const tp = s.vidaPerdidaT[i];
    let esc = 1;
    let rot = 0;
    if (tp < 0.5) {
      const p = tp / 0.5;
      esc = 1 + 0.35 * Math.sin(Math.PI * p);
      rot = Math.sin(tp * 40) * 0.3 * (1 - p);
    }
    desenharTrigo(ctx, x, 17, i < s.vidas, esc, rot);
  }
}

function desenharCheck(ctx: CanvasRenderingContext2D, x: number, y: number, ok: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ok ? COR.verde : COR.rosa;
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (ok) {
    ctx.moveTo(-2.6, 0.2);
    ctx.lineTo(-0.6, 2.2);
    ctx.lineTo(2.8, -2);
  } else {
    ctx.moveTo(-2.2, -2.2);
    ctx.lineTo(2.2, 2.2);
    ctx.moveTo(2.2, -2.2);
    ctx.lineTo(-2.2, 2.2);
  }
  ctx.stroke();
  ctx.restore();
}

function botaoTexto(ctx: CanvasRenderingContext2D, txt: string, cx: number, cy: number, alfa: number) {
  ctx.save();
  ctx.globalAlpha *= alfa;
  ctx.font = `600 12px ${FONTE}`;
  const w = ctx.measureText(txt).width + 28;
  caminhoArred(ctx, cx - w / 2, cy - 12, w, 24, 12);
  ctx.fillStyle = COR.tinta;
  ctx.fill();
  ctx.fillStyle = COR.douradoClaro;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, cx, cy + 0.5);
  ctx.restore();
}

function desenharInicio(ctx: CanvasRenderingContext2D, s: Estado) {
  ctx.fillStyle = 'rgba(252,251,248,0.55)';
  ctx.fillRect(0, 0, LARGURA, ALTURA);
  const ent = easeOutCubic(Math.min(1, s.t / 0.5));
  ctx.save();
  ctx.globalAlpha = ent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COR.tinta;
  ctx.font = `700 28px ${FONTE_SERIFA}`;
  ctx.fillText('Caça à Sequência', LARGURA / 2, 44 + (1 - ent) * 8);
  ctx.fillStyle = COR.texto2;
  ctx.font = `400 12.5px ${FONTE}`;
  ctx.fillText('Pegue só a próxima nota da numeração. Fuja das fora de ordem e das inutilizadas.', LARGURA / 2, 72, LARGURA - 40);

  const exemplos: { num: number; inutil: boolean; ok: boolean; rotulo: string; x: number }[] = [
    { num: 1004, inutil: false, ok: true, rotulo: 'Próxima: pegue', x: 170 },
    { num: 1006, inutil: false, ok: false, rotulo: 'Fora de ordem', x: 280 },
    { num: 1004, inutil: true, ok: false, rotulo: 'Inutilizada', x: 390 },
  ];
  exemplos.forEach((e, i) => {
    const rot = Math.sin(s.relogio * 1.6 + i * 1.7) * 0.08;
    const yy = 124 + Math.sin(s.relogio * 1.9 + i) * 2.5;
    pintarNota(ctx, e.num, e.inutil, e.x, yy, rot, 0.95, 1, 'normal');
    desenharCheck(ctx, e.x + 22, yy - 26, e.ok);
    ctx.fillStyle = e.ok ? COR.verde : COR.rosa;
    ctx.font = `600 11px ${FONTE}`;
    ctx.textAlign = 'center';
    ctx.fillText(e.rotulo, e.x, 170);
  });
  ctx.restore();
  const pulso = 0.75 + 0.25 * Math.sin(s.relogio * 3.2);
  botaoTexto(ctx, 'Toque ou aperte Espaço para começar', LARGURA / 2, 202, ent * pulso);
}

function desenharFim(ctx: CanvasRenderingContext2D, s: Estado) {
  const ent = easeOutCubic(Math.min(1, s.t / 0.45));
  ctx.fillStyle = `rgba(252,251,248,${(0.72 * ent).toFixed(3)})`;
  ctx.fillRect(0, 0, LARGURA, ALTURA);

  const w = 300;
  const h = 184;
  const x = (LARGURA - w) / 2;
  const y = 50 + (1 - ent) * 14;
  ctx.save();
  ctx.globalAlpha = ent;
  ctx.save();
  ctx.shadowColor = 'rgba(23,21,15,0.16)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  caminhoArred(ctx, x, y, w, h, 14);
  ctx.fillStyle = COR.papel;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = COR.borda;
  ctx.lineWidth = 1;
  caminhoArred(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
  ctx.stroke();
  ctx.fillStyle = COR.dourado;
  ctx.fillRect(x + w / 2 - 18, y + 12, 36, 2);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COR.tinta;
  ctx.font = `700 21px ${FONTE_SERIFA}`;
  ctx.fillText('Fim de expediente', LARGURA / 2, y + 32);

  const pop = easeOutBack(Math.min(1, Math.max(0, (s.t - 0.15) / 0.4)));
  ctx.save();
  ctx.translate(LARGURA / 2, y + 72);
  ctx.scale(pop, pop);
  ctx.fillStyle = COR.douradoTexto;
  ctx.font = `700 40px ${FONTE_SERIFA}`;
  ctx.fillText(String(s.pontos), 0, 0);
  ctx.restore();
  ctx.fillStyle = COR.texto3;
  ctx.font = `500 11px ${FONTE}`;
  ctx.fillText('pontos', LARGURA / 2, y + 98);

  if (s.novoRecorde) {
    const b = 1 + 0.06 * Math.sin(s.relogio * 5);
    ctx.save();
    ctx.translate(LARGURA / 2, y + 120);
    ctx.scale(b, b);
    ctx.font = `700 15px ${FONTE_SERIFA}`;
    ctx.fillStyle = COR.douradoTexto;
    ctx.shadowColor = 'rgba(240,210,122,0.9)';
    ctx.shadowBlur = 10;
    ctx.fillText('Novo recorde!', 0, 0);
    ctx.restore();
  } else {
    ctx.fillStyle = COR.texto2;
    ctx.font = `500 12px ${FONTE}`;
    ctx.fillText(`Recorde: ${s.recordeInicio}`, LARGURA / 2, y + 120);
  }
  ctx.fillStyle = COR.texto3;
  ctx.font = `400 11px ${FONTE}`;
  ctx.fillText(`${s.acertos} ${s.acertos === 1 ? 'nota pega' : 'notas pegas'} na sequência`, LARGURA / 2, y + 139);
  ctx.restore();

  const cta = Math.min(1, Math.max(0, (s.t - 0.6) / 0.3));
  if (cta > 0) botaoTexto(ctx, 'Toque para jogar de novo', LARGURA / 2, y + 164, cta * (0.8 + 0.2 * Math.sin(s.relogio * 3.2)));
}

function desenhar(ctx: CanvasRenderingContext2D, s: Estado, reduz: boolean) {
  ctx.save();
  ctx.clearRect(0, 0, LARGURA, ALTURA);
  desenharFundo(ctx, s);

  ctx.save();
  if (!reduz && s.tremor > 0) {
    const k = s.tremor * s.tremor * 5;
    ctx.translate((Math.random() - 0.5) * 2 * k, (Math.random() - 0.5) * 2 * k);
  }
  desenharCestaFundo(ctx, s);
  desenharNotas(ctx, s, reduz);
  desenharBalcao(ctx, s);
  desenharCestaFrente(ctx, s);
  if (s.fase !== 'fim') desenharParticulas(ctx, s);
  desenharTextos(ctx, s);
  ctx.restore();

  if (s.fase === 'jogando') desenharHud(ctx, s);
  else if (s.fase === 'pronto') desenharInicio(ctx, s);
  else {
    desenharHud(ctx, s);
    desenharFim(ctx, s);
    desenharParticulas(ctx, s);
  }
  ctx.restore();
}

// ───────────────────────── componente ─────────────────────────

export default function Sequencia(props: JogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const estadoRef = useRef<Estado | null>(null);
  if (estadoRef.current === null) estadoRef.current = novoEstado('pronto', LARGURA / 2, props.recorde);
  const propsRef = useRef(props);
  const pontosMostradosRef = useRef(0);
  const [pontos, setPontos] = useState(0);

  useEffect(() => {
    propsRef.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx = prepararCanvas(canvas);
    let dpr = window.devicePixelRatio || 1;
    const reduz = prefereMenosMovimento();
    const inicial = estadoRef.current;
    if (inicial && inicial.poeira.length === 0) inicial.poeira = criarPoeira(reduz ? 5 : 16);

    let raf = 0;
    let ultimo = performance.now();
    const passo = (agora: number) => {
      const dt = Math.min(Math.max((agora - ultimo) / 1000, 0), 1 / 30);
      ultimo = agora;
      const s = estadoRef.current;
      if (s) {
        if (atualizar(s, dt, reduz)) propsRef.current.aoTerminar(s.pontos);
        if (s.pontos !== pontosMostradosRef.current) {
          pontosMostradosRef.current = s.pontos;
          setPontos(s.pontos);
        }
        if (ctx) desenhar(ctx, s, reduz);
      }
      raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);

    const ehCampo = (alvo: EventTarget | null) =>
      alvo instanceof HTMLElement && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName));

    const aoTeclar = (e: KeyboardEvent) => {
      if (ehCampo(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = estadoRef.current;
      if (!s) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (e.repeat) return;
          if (s.fase === 'pronto' || (s.fase === 'fim' && s.t > 0.6)) estadoRef.current = novaPartida(s, propsRef.current.recorde);
          break;
        case 'ArrowLeft':
        case 'KeyA':
          e.preventDefault();
          s.teclas.esq = true;
          s.usandoTeclado = true;
          break;
        case 'ArrowRight':
        case 'KeyD':
          e.preventDefault();
          s.teclas.dir = true;
          s.usandoTeclado = true;
          break;
      }
    };
    const aoSoltar = (e: KeyboardEvent) => {
      const s = estadoRef.current;
      if (!s) return;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') s.teclas.esq = false;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') s.teclas.dir = false;
    };
    const aoPerderFoco = () => {
      const s = estadoRef.current;
      if (s) {
        s.teclas.esq = false;
        s.teclas.dir = false;
      }
    };
    const aoRedimensionar = () => {
      const novo = window.devicePixelRatio || 1;
      if (novo !== dpr) {
        dpr = novo;
        ctx = prepararCanvas(canvas);
      }
    };

    window.addEventListener('keydown', aoTeclar);
    window.addEventListener('keyup', aoSoltar);
    window.addEventListener('blur', aoPerderFoco);
    window.addEventListener('resize', aoRedimensionar);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', aoTeclar);
      window.removeEventListener('keyup', aoSoltar);
      window.removeEventListener('blur', aoPerderFoco);
      window.removeEventListener('resize', aoRedimensionar);
    };
  }, []);

  const mirar = (e: PointerEventReact<HTMLCanvasElement>) => {
    const s = estadoRef.current;
    if (!s) return;
    const p = pontoNoQuadro(e.currentTarget, e.clientX, e.clientY);
    s.cesta.alvo = p.x;
    s.usandoTeclado = false;
  };

  const aoApontar = (e: PointerEventReact<HTMLCanvasElement>) => {
    const s = estadoRef.current;
    if (!s) return;
    if (e.pointerType !== 'mouse') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* sem captura, segue normal */
      }
    }
    if (s.fase === 'pronto' || (s.fase === 'fim' && s.t > 0.6)) {
      estadoRef.current = novaPartida(s, propsRef.current.recorde);
    }
    mirar(e);
  };

  const aoMover = (e: PointerEventReact<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' || e.buttons !== 0) mirar(e);
  };

  return (
    <div className="w-full select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={aoApontar}
        onPointerMove={aoMover}
        role="img"
        aria-label="Caça à Sequência: pegue as notas fiscais na ordem certa com a cesta"
        className="block aspect-[2/1] w-full cursor-pointer touch-none select-none rounded-xl border border-[#E5E0D6] bg-[#FCFBF8]"
      />
      <div className="mt-2 flex items-center justify-between gap-3 text-[13px] text-[#5E594F]">
        <span>Mouse, toque ou ← → movem a cesta</span>
        <span className="whitespace-nowrap">
          Pontos <span className="font-semibold tabular-nums text-[#8A6D0F]">{pontos}</span> · Recorde{' '}
          <span className="font-semibold tabular-nums text-[#8A6D0F]">{Math.max(props.recorde, pontos)}</span>
        </span>
      </div>
    </div>
  );
}
