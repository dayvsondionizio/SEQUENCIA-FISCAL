// Seletor dos joguinhos de passatempo exibidos enquanto a auditoria processa os arquivos.
// Não lê nem altera nada da auditoria: só guarda os recordes de cada jogo (localStorage,
// sempre protegido por try/catch) e avisa quando os resultados ficam prontos.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { X, ArrowLeft, CheckCircle2 } from 'lucide-react';
import type { JogoProps } from './tipos';
import Corredor from './Corredor';
import Sequencia from './Sequencia';
import Forno from './Forno';

type IdJogo = 'corredor' | 'sequencia' | 'forno';
type Recordes = Record<IdJogo, number>;

const CHAVE_RECORDES = 'sf-joguinhos-recordes';
const RECORDES_VAZIOS: Recordes = { corredor: 0, sequencia: 0, forno: 0 };

interface InfoJogo {
  id: IdJogo;
  nome: string;
  descricao: string;
  controles: string;
  Componente: ComponentType<JogoProps>;
  Ilustracao: ComponentType;
}

// Último jogo escolhido: lembrado só enquanto a página estiver aberta (memória do módulo),
// para destacar o cartão na próxima vez — o modal sempre abre na tela de escolha.
let ultimoJogoDaSessao: IdJogo | null = null;

function lerRecordes(): Recordes {
  try {
    const bruto = window.localStorage.getItem(CHAVE_RECORDES);
    if (!bruto) return { ...RECORDES_VAZIOS };
    const dados = JSON.parse(bruto) as Partial<Record<IdJogo, unknown>>;
    const limpo = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    return { corredor: limpo(dados?.corredor), sequencia: limpo(dados?.sequencia), forno: limpo(dados?.forno) };
  } catch {
    return { ...RECORDES_VAZIOS };
  }
}

function gravarRecordes(r: Recordes) {
  try {
    window.localStorage.setItem(CHAVE_RECORDES, JSON.stringify(r));
  } catch {
    /* sem localStorage (modo privado, bloqueado): o recorde vale só nesta sessão */
  }
}

/* ------------------------------------------------------------------ */
/* Ilustrações (SVG inline, sem arquivos externos)                      */
/* ------------------------------------------------------------------ */

function IlustracaoCorredor() {
  return (
    <svg viewBox="0 0 160 84" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="sfj-c-ceu" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBF3DC" />
          <stop offset="1" stopColor="#F3EFE6" />
        </linearGradient>
        <radialGradient id="sfj-c-sol" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#F0D27A" stopOpacity="0.9" />
          <stop offset="1" stopColor="#F0D27A" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sfj-c-pao" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E9B65A" />
          <stop offset="0.55" stopColor="#C98A2E" />
          <stop offset="1" stopColor="#9A621C" />
        </linearGradient>
      </defs>
      <rect width="160" height="84" fill="url(#sfj-c-ceu)" />
      <circle cx="128" cy="22" r="22" fill="url(#sfj-c-sol)" />
      {/* chão */}
      <rect y="66" width="160" height="18" fill="#EDE5D3" />
      <path d="M0 66 H160" stroke="#D9CDB2" strokeWidth="1.5" />
      <path d="M14 74 h10 M48 77 h6 M92 73 h12 M132 76 h8" stroke="#D9CDB2" strokeWidth="1.5" strokeLinecap="round" />
      {/* obstáculo: xícara */}
      <g transform="translate(120 50)">
        <ellipse cx="9" cy="16.5" rx="11" ry="2" fill="#17150F" opacity="0.12" />
        <path d="M0 2 h18 v8 a6 6 0 0 1 -6 6 h-6 a6 6 0 0 1 -6 -6 z" fill="#FCFBF8" stroke="#C9A227" strokeWidth="1.4" />
        <path d="M18 5 a3.5 3.5 0 0 1 0 7" fill="none" stroke="#C9A227" strokeWidth="1.4" />
        <path d="M5 -3 q-2 -3 0 -6 M10 -3 q-2 -3 0 -6" fill="none" stroke="#C9A227" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
      </g>
      {/* linhas de velocidade */}
      <path d="M14 38 h18 M8 46 h22 M18 54 h12" stroke="#C9A227" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      {/* migalhas */}
      <circle cx="36" cy="62" r="1.3" fill="#C98A2E" />
      <circle cx="30" cy="58" r="1" fill="#E9B65A" />
      <circle cx="26" cy="63" r="0.9" fill="#C98A2E" />
      {/* sombra */}
      <ellipse cx="62" cy="67" rx="17" ry="2.4" fill="#17150F" opacity="0.14" />
      {/* pernas */}
      <path d="M56 56 l-7 9 h-4" fill="none" stroke="#17150F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M67 56 l6 7 l5 -2" fill="none" stroke="#17150F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* pãozinho */}
      <g transform="rotate(-8 62 46)">
        <ellipse cx="62" cy="46" rx="20" ry="12" fill="url(#sfj-c-pao)" />
        <ellipse cx="58" cy="40" rx="11" ry="4" fill="#F6D58E" opacity="0.55" />
        <path d="M51 42 q4 -4 7 0 M60 40 q4 -4 7 0 M69 42 q3 -3 6 0" fill="none" stroke="#8A5516" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="74" cy="47" r="1.6" fill="#17150F" />
        <circle cx="74.5" cy="46.4" r="0.5" fill="#FCFBF8" />
        <path d="M76 51 q2 1.5 4 0" fill="none" stroke="#17150F" strokeWidth="1" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function IlustracaoSequencia() {
  const nota = (x: number, y: number, rot: number, num: string, destaque = false) => (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x="-13" y="-9" width="26" height="18" rx="2.5" fill="#17150F" opacity="0.1" transform="translate(1.2 1.6)" />
      <rect x="-13" y="-9" width="26" height="18" rx="2.5" fill="#FCFBF8" stroke={destaque ? '#C9A227' : '#D9CDB2'} strokeWidth="1.2" />
      <rect x="-13" y="-9" width="26" height="4" rx="2" fill={destaque ? '#F0D27A' : '#F3EFE6'} />
      <text x="0" y="5.5" textAnchor="middle" fontFamily="Georgia, serif" fontSize="8.5" fontWeight="700" fill={destaque ? '#8A6D0F' : '#17150F'}>
        {num}
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 160 84" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="sfj-s-fundo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F7F1E2" />
          <stop offset="1" stopColor="#F3EFE6" />
        </linearGradient>
        <linearGradient id="sfj-s-cesta" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#D9A653" />
          <stop offset="1" stopColor="#9A6A26" />
        </linearGradient>
      </defs>
      <rect width="160" height="84" fill="url(#sfj-s-fundo)" />
      {/* rastros de queda */}
      <path d="M50 4 v10 M84 0 v8 M114 10 v10" stroke="#C9A227" strokeWidth="1.2" strokeLinecap="round" opacity="0.35" strokeDasharray="2 3" />
      {nota(50, 22, -10, '041')}
      {nota(112, 30, 12, '043')}
      {nota(82, 44, -4, '042', true)}
      {/* brilho de acerto */}
      <path d="M100 46 l1.5 3.5 l3.5 1.5 l-3.5 1.5 l-1.5 3.5 l-1.5 -3.5 l-3.5 -1.5 l3.5 -1.5 z" fill="#F0D27A" />
      {/* cesta */}
      <ellipse cx="82" cy="80" rx="34" ry="2.6" fill="#17150F" opacity="0.14" />
      <path d="M50 58 h64 l-7 21 h-50 z" fill="url(#sfj-s-cesta)" />
      <path d="M53 65 h58 M55 72 h54" stroke="#7A5019" strokeWidth="1" opacity="0.55" />
      <path d="M62 58 l-2 21 M72 58 l-1 21 M82 58 v21 M92 58 l1 21 M102 58 l2 21" stroke="#7A5019" strokeWidth="0.9" opacity="0.45" />
      <rect x="47" y="55" width="70" height="5" rx="2.5" fill="#E2B566" stroke="#9A6A26" strokeWidth="0.8" />
    </svg>
  );
}

function IlustracaoForno() {
  return (
    <svg viewBox="0 0 160 84" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="sfj-f-fundo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F7F1E2" />
          <stop offset="1" stopColor="#EFE7D6" />
        </linearGradient>
        <linearGradient id="sfj-f-cupula" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5A4A32" />
          <stop offset="1" stopColor="#2C2820" />
        </linearGradient>
        <radialGradient id="sfj-f-brasa" cx="0.5" cy="0.85" r="0.75">
          <stop offset="0" stopColor="#FFD27A" />
          <stop offset="0.45" stopColor="#F08A24" />
          <stop offset="1" stopColor="#7A2E0A" />
        </radialGradient>
        <linearGradient id="sfj-f-pao" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F2C46C" />
          <stop offset="1" stopColor="#B87628" />
        </linearGradient>
        <radialGradient id="sfj-f-calor" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#F0D27A" stopOpacity="0.55" />
          <stop offset="1" stopColor="#F0D27A" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="160" height="84" fill="url(#sfj-f-fundo)" />
      <ellipse cx="80" cy="60" rx="62" ry="30" fill="url(#sfj-f-calor)" />
      {/* vapor */}
      <path d="M70 16 q-4 -5 0 -10 q4 -5 0 -10" fill="none" stroke="#C9A227" strokeWidth="1.4" strokeLinecap="round" opacity="0.45" transform="translate(0 6)" />
      <path d="M88 18 q-4 -5 0 -10 q4 -5 0 -10" fill="none" stroke="#C9A227" strokeWidth="1.4" strokeLinecap="round" opacity="0.3" transform="translate(0 4)" />
      {/* base */}
      <rect x="26" y="70" width="108" height="10" rx="2" fill="#B9A887" />
      <path d="M26 75 h108" stroke="#9E8D6D" strokeWidth="0.8" />
      {/* cúpula */}
      <path d="M34 70 v-22 a46 30 0 0 1 92 0 v22 z" fill="url(#sfj-f-cupula)" />
      <path d="M44 34 a40 24 0 0 1 30 -11" fill="none" stroke="#FCFBF8" strokeWidth="1.6" strokeLinecap="round" opacity="0.18" />
      {/* tijolos do arco */}
      <path d="M52 70 v-14 a28 20 0 0 1 56 0 v14" fill="none" stroke="#C9A227" strokeWidth="4" strokeDasharray="5 2" opacity="0.8" />
      {/* boca do forno */}
      <path d="M54 70 v-13 a26 18 0 0 1 52 0 v13 z" fill="url(#sfj-f-brasa)" />
      {/* pães */}
      <g>
        <ellipse cx="68" cy="66" rx="9" ry="5" fill="url(#sfj-f-pao)" />
        <path d="M63 64 q2.5 -2 5 0 M68 63.5 q2.5 -2 5 0" fill="none" stroke="#8A5516" strokeWidth="1" strokeLinecap="round" />
        <ellipse cx="88" cy="66" rx="10" ry="5.4" fill="url(#sfj-f-pao)" />
        <path d="M82 64 q2.5 -2 5 0 M88 63.5 q2.5 -2 5 0" fill="none" stroke="#8A5516" strokeWidth="1" strokeLinecap="round" />
        <ellipse cx="80" cy="58" rx="7" ry="4" fill="#F6D58E" opacity="0.35" />
      </g>
      {/* faíscas */}
      <circle cx="98" cy="52" r="1" fill="#FFE2A0" />
      <circle cx="62" cy="54" r="0.8" fill="#FFE2A0" />
      {/* termômetro */}
      <g transform="translate(118 44)">
        <circle r="7" fill="#FCFBF8" stroke="#C9A227" strokeWidth="1.4" />
        <path d="M0 0 L3.6 -4" stroke="#E11D48" strokeWidth="1.4" strokeLinecap="round" />
        <circle r="1.2" fill="#17150F" />
      </g>
    </svg>
  );
}

const JOGOS: InfoJogo[] = [
  {
    id: 'corredor',
    nome: 'Pãozinho Corredor',
    descricao: 'Pule carimbos de “inutilizada” e pilhas de notas, e colha trigo.',
    controles: 'Espaço, ↑ ou toque para pular',
    Componente: Corredor,
    Ilustracao: IlustracaoCorredor,
  },
  {
    id: 'sequencia',
    nome: 'Caça à Sequência',
    descricao: 'Pegue as notas na ordem numérica e fuja das inutilizadas.',
    controles: 'Setas ou arraste a cesta',
    Componente: Sequencia,
    Ilustracao: IlustracaoSequencia,
  },
  {
    id: 'forno',
    nome: 'Tira do Forno',
    descricao: 'Tire cada pão no ponto certo: nem cru, nem queimado.',
    controles: 'Toque no pão ou teclas 1 a 4',
    Componente: Forno,
    Ilustracao: IlustracaoForno,
  },
];

/* ------------------------------------------------------------------ */
/* Seletor                                                              */
/* ------------------------------------------------------------------ */

export default function Joguinhos({ onClose, processando }: { onClose: () => void; processando?: boolean }) {
  const [tela, setTela] = useState<'escolha' | IdJogo>('escolha');
  const [recordes, setRecordes] = useState<Recordes>(lerRecordes);
  const [resultadosProntos, setResultadosProntos] = useState(false);
  const [ultimo, setUltimo] = useState<IdJogo | null>(ultimoJogoDaSessao);

  const cartaoRef = useRef<HTMLDivElement>(null);
  const areaJogoRef = useRef<HTMLDivElement>(null);
  const botoesRef = useRef<Partial<Record<IdJogo, HTMLButtonElement | null>>>({});
  const processandoAnterior = useRef<boolean | undefined>(processando);
  const pressionouFora = useRef(false);
  const primeiraGravacao = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Esc fecha o modal e Tab circula só dentro do cartão (aria-modal); o listener é removido ao desmontar.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const cartao = cartaoRef.current;
        if (!cartao) return;
        const focaveis = Array.from(
          cartao.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focaveis.length === 0) return;
        const primeiro = focaveis[0];
        const ultimoFocavel = focaveis[focaveis.length - 1];
        const ativo = document.activeElement as HTMLElement | null;
        if (!ativo || !cartao.contains(ativo)) {
          e.preventDefault();
          (e.shiftKey ? ultimoFocavel : primeiro).focus();
          return;
        }
        // Há algum focável antes/depois do elemento ativo? Se não houver, dá a volta.
        const temProximo = e.shiftKey
          ? focaveis.some((el) => el !== ativo && el.compareDocumentPosition(ativo) & Node.DOCUMENT_POSITION_FOLLOWING)
          : focaveis.some((el) => el !== ativo && ativo.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!temProximo) {
          e.preventDefault();
          (e.shiftKey ? ultimoFocavel : primeiro).focus();
        }
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, []);

  // Trava a rolagem da página e devolve o foco a quem abriu o modal ao fechar.
  useEffect(() => {
    const focoAnterior = document.activeElement as HTMLElement | null;
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflowAnterior;
      try {
        focoAnterior?.focus?.();
      } catch {
        /* elemento pode ter saído da página */
      }
    };
  }, []);

  // Foco: na escolha, vai para o cartão do último jogo (ou o primeiro); no jogo, para o
  // contêiner do jogo — assim Espaço não "clica" de novo num botão do seletor.
  useEffect(() => {
    if (tela === 'escolha') {
      const alvo = (ultimo && botoesRef.current[ultimo]) || botoesRef.current.corredor;
      alvo?.focus({ preventScroll: true });
    } else {
      areaJogoRef.current?.focus({ preventScroll: true });
    }
    // `ultimo` muda junto com `tela`; só a troca de tela deve mover o foco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tela]);

  // Aviso "resultados prontos": só quando processando passa de true para false com o modal aberto.
  useEffect(() => {
    const antes = processandoAnterior.current;
    processandoAnterior.current = processando;
    if (processando === undefined) {
      setResultadosProntos(false);
    } else if (antes === true && processando === false) {
      setResultadosProntos(true);
    } else if (processando === true) {
      setResultadosProntos(false);
    }
  }, [processando]);

  // Persiste os recordes quando mudam (a leitura inicial não precisa ser regravada).
  useEffect(() => {
    if (primeiraGravacao.current) {
      primeiraGravacao.current = false;
      return;
    }
    gravarRecordes(recordes);
  }, [recordes]);

  // Callbacks estáveis por jogo, para não reiniciar efeitos dos jogos a cada render.
  const aoTerminarPorJogo = useMemo(() => {
    const fazer = (id: IdJogo) => (pontos: number) => {
      const p = Number.isFinite(pontos) ? Math.max(0, Math.floor(pontos)) : 0;
      setRecordes((r) => (p > r[id] ? { ...r, [id]: p } : r));
    };
    return { corredor: fazer('corredor'), sequencia: fazer('sequencia'), forno: fazer('forno') } as Record<IdJogo, (pontos: number) => void>;
  }, []);

  const escolher = useCallback((id: IdJogo) => {
    ultimoJogoDaSessao = id;
    setUltimo(id);
    setTela(id);
  }, []);

  const voltarEscolha = useCallback(() => setTela('escolha'), []);

  const jogoAtual = tela === 'escolha' ? null : JOGOS.find((j) => j.id === tela) ?? null;
  const tituloId = 'sf-joguinhos-titulo';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-[rgba(23,21,15,0.85)] p-3 backdrop-blur-sm sm:p-6"
      onPointerDown={(e) => {
        pressionouFora.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Fecha só se o clique começou e terminou fora do cartão (arrastar de dentro para fora não fecha).
        if (pressionouFora.current && e.target === e.currentTarget) onClose();
        pressionouFora.current = false;
      }}
    >
      <div
        ref={cartaoRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        className="relative my-auto w-[min(94vw,680px)] rounded-2xl bg-[#FCFBF8] p-5 shadow-2xl sm:p-6"
      >
        {resultadosProntos && (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[#059669]/25 bg-gradient-to-r from-[#ECFDF5] to-[#FBF5E1] px-3.5 py-2.5"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#059669]" aria-hidden="true" />
            <p className="flex-1 text-[13px] font-medium text-[#17150F]">Seus resultados estão prontos.</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-[#17150F] px-3 py-1.5 text-[12.5px] font-semibold text-[#F0D27A] transition-colors hover:bg-[#2C2820] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A227] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FCFBF8]"
            >
              Ver resultados
            </button>
          </div>
        )}

        {jogoAtual === null ? (
          <>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id={tituloId} className="font-serif text-2xl leading-tight text-[#17150F]">
                  Enquanto a auditoria roda…
                </h2>
                <p className="mt-1 text-[13.5px] text-[#5E594F]">
                  Escolha um passatempo rápido. Avisamos aqui quando os resultados ficarem prontos.
                </p>
              </div>
              <BotaoFechar onClose={onClose} />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {JOGOS.map((j) => {
                const rec = recordes[j.id];
                const foiUltimo = ultimo === j.id;
                return (
                  <button
                    key={j.id}
                    ref={(el) => {
                      botoesRef.current[j.id] = el;
                    }}
                    type="button"
                    onClick={() => escolher(j.id)}
                    className="group flex flex-col overflow-hidden rounded-xl border border-[#E5E0D6] bg-white text-left shadow-[0_1px_2px_rgba(23,21,15,0.04)] transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-[#D9C68A] hover:shadow-[0_10px_24px_-12px_rgba(23,21,15,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A227] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FCFBF8] active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                  >
                    <div className="relative aspect-[160/84] w-full border-b border-[#EFE9DC] bg-[#F3EFE6]">
                      <j.Ilustracao />
                      {foiUltimo && (
                        <span className="absolute left-2 top-2 rounded-full bg-[#17150F]/85 px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-[#F0D27A]">
                          Último jogado
                        </span>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <span className="font-serif text-[17px] leading-snug text-[#17150F] group-hover:text-[#8A6D0F]">{j.nome}</span>
                      <span className="text-[12.5px] leading-snug text-[#5E594F]">{j.descricao}</span>
                      <span className="mt-1 text-[11.5px] text-[#78736A]">{j.controles}</span>
                      <span className="mt-auto pt-2 text-[12px] text-[#5E594F]">
                        {rec > 0 ? (
                          <>
                            Recorde: <span className="font-semibold tabular-nums text-[#8A6D0F]">{rec}</span>
                          </>
                        ) : (
                          <span className="text-[#78736A]">Ainda sem recorde</span>
                        )}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-3">
              <button
                type="button"
                onClick={voltarEscolha}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[#5E594F] transition-colors hover:bg-[#F3EFE6] hover:text-[#17150F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A227]"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Trocar jogo
              </button>
              <h2 id={tituloId} className="min-w-0 flex-1 truncate text-center font-serif text-lg text-[#17150F]">
                {jogoAtual.nome}
              </h2>
              <BotaoFechar onClose={onClose} />
            </div>
            <div ref={areaJogoRef} tabIndex={-1} className="outline-none">
              <jogoAtual.Componente
                key={jogoAtual.id}
                recorde={recordes[jogoAtual.id]}
                aoTerminar={aoTerminarPorJogo[jogoAtual.id]}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BotaoFechar({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Fechar"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#78736A] transition-colors hover:bg-[#F3EFE6] hover:text-[#17150F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A227]"
    >
      <X className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}
