// Contrato comum dos joguinhos da tela de carregamento. Os jogos são só passatempo:
// não leem nem alteram nada da auditoria — recebem o recorde e avisam a pontuação final.

export interface JogoProps {
  /** Melhor pontuação já feita neste jogo (o seletor guarda e repassa). */
  recorde: number;
  /** Chamado UMA vez ao fim de cada partida, com a pontuação final. */
  aoTerminar: (pontos: number) => void;
}

// Paleta da marca Contador de Padarias (mesmos tons do app).
export const COR = {
  tinta: '#17150F',
  tinta2: '#2C2820',
  tinta3: '#423C2C',
  dourado: '#C9A227',
  douradoClaro: '#F0D27A',
  douradoTexto: '#8A6D0F',
  papel: '#FCFBF8',
  papel2: '#F3EFE6',
  borda: '#E5E0D6',
  texto2: '#5E594F',
  texto3: '#78736A',
  rosa: '#E11D48',
  verde: '#059669',
  ambar: '#D97706',
} as const;

export const FONTE_SERIFA = '"Newsreader", Georgia, serif';
export const FONTE = '"IBM Plex Sans", system-ui, sans-serif';

// Tamanho lógico do quadro de cada jogo (proporção 2:1). O canvas é desenhado
// nessa escala e ampliado pelo devicePixelRatio para ficar nítido em qualquer tela.
export const LARGURA = 560;
export const ALTURA = 280;

/** Ajusta o canvas ao devicePixelRatio e devolve o contexto já escalado para LARGURA×ALTURA lógicos. */
export function prepararCanvas(canvas: HTMLCanvasElement, largura = LARGURA, altura = ALTURA): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(largura * dpr);
  canvas.height = Math.round(altura * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** true quando o sistema pede menos animação — os jogos reduzem partículas e tremidas. */
export function prefereMenosMovimento(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Converte a posição do ponteiro (clientX/Y) para coordenadas lógicas do quadro. */
export function pontoNoQuadro(canvas: HTMLCanvasElement, clientX: number, clientY: number, largura = LARGURA, altura = ALTURA) {
  const r = canvas.getBoundingClientRect();
  return { x: ((clientX - r.left) / r.width) * largura, y: ((clientY - r.top) / r.height) * altura };
}
