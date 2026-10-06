/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useMemo, useEffect } from 'react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { CCLASSTRIB_TABELA, CCLASSTRIB_VERSAO } from './cclasstribTabela';
import { LOGO_CONTADOR_PADARIAS_B64 } from './logoContadorPadarias';
import { createExtractorFromData } from 'node-unrar-js';
// @ts-ignore
// Usando CDN para garantir que o motor WASM seja carregado corretamente em qualquer ambiente
const unrarWasmUrl = 'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/dist/js/unrar.wasm';
import { 
  FileText, 
  FolderOpen, 
  Upload, 
  CheckCircle2, 
  AlertCircle, 
  ChevronRight, 
  Copy, 
  Trash2, 
  Search,
  Filter,
  BarChart3,
  FileSearch,
  Check,
  User,
  Printer,
  Download,
  X,
  GitCompare,
  Loader2,
  XCircle,
  Sun,
  Moon,
  FileSpreadsheet,
  Receipt,
  CreditCard,
  Ban,
  Clock,
  AlertTriangle,
  Briefcase,
  Users,
  Package,
  TrendingUp,
  Landmark
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Extensões que nunca são fiscais (XML/TXT) — clientes às vezes juntam PDF,
// planilhas e fotos no mesmo ZIP enviado pro contador. Sem esse filtro, o
// app lia esses arquivos inteiros como texto (decode de binário grande vira
// string gigante) só pra descobrir que não é nota — em lotes com PDF de
// dezenas de MB isso trava a aba.
const EXTENSOES_NAO_FISCAIS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff',
  '.mp4', '.mp3', '.avi', '.mov', '.wmv', '.exe', '.msi', '.dll',
]);
// Só pula pela extensão quando o arquivo também é grande — um XML pequeno
// que por acidente veio com extensão errada (renomeado, antivírus, etc.)
// nunca é descartado por esse filtro, porque um arquivo pequeno não é o que
// causa lentidão de qualquer forma. 512KB já é generoso: XML de NF-e/NFC-e
// real, mesmo com bloco de assinatura completo, fica bem abaixo disso.
const TAMANHO_MINIMO_PARA_PULAR_POR_EXTENSAO = 512 * 1024;
function isProvavelmenteNaoFiscal(nomeArquivo: string, tamanhoBytes?: number): boolean {
  if (tamanhoBytes !== undefined && tamanhoBytes < TAMANHO_MINIMO_PARA_PULAR_POR_EXTENSAO) return false;
  const lower = nomeArquivo.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return EXTENSOES_NAO_FISCAIS.has(lower.slice(dot));
}

// --- Types ---

interface XmlData {
  tipo: 'nfe' | 'inutilizacao' | 'evento' | 'consulta' | 'outro' | 'nfse' | 'nfse_evento';
  subTipo?: string;
  isContingencia?: boolean;
  isCancelamento?: boolean;
  cnpj?: string;
  ie?: string;
  razaoSocial?: string;
  modelo?: string;
  serie?: string;
  numero?: string;
  chave?: string;
  data?: string;
  valor?: string;
  natureza?: string;
  protocolo?: string;
  dhRecbto?: string;
  nNFIni?: number;
  nNFFin?: number;
  fileName: string;
  sourceName?: string;
  // Relationship data
  emitCnpj?: string;
  emitNome?: string;
  destCnpj?: string;
  destNome?: string;
  tpNF?: string; // 0=Entrada, 1=Saida
  rawXml?: string;
  // Net value of the note's items (vProd - vDesc + vOutro/vFrete/vSeg), grouped by CFOP —
  // used to break down the total faturamento by natureza da operação (venda, devolução, etc.)
  cfopValores?: Record<string, number>;
  // True only for inutilizações typed in by the analyst after checking the SEFAZ
  // portal — distinguishes them from inutilizações that came from an XML the
  // client actually sent.
  origemManual?: boolean;
  // Nota emitida pela própria empresa sob CFOP de entrada (devolução de venda,
  // baixa de estoque, etc.) — ocupa numeração real da série, mas não é venda.
  isEntradaPropria?: boolean;
  // NFS-e (Nota Fiscal de Serviços Eletrônica, padrão Sistema Nacional/ADN) —
  // reaproveita cnpj/razaoSocial pro prestador e emitCnpj/emitNome, destCnpj/
  // destNome pro tomador, só descServico é campo próprio.
  descServico?: string;
  // nDPS (número da DPS) é DIFERENTE de nNFSe (guardado em `numero`): nNFSe é
  // atribuído pelo Ambiente Nacional (ADN) e tem buracos normais/esperados
  // (números reservados que não viram nota); nDPS é o número que o sistema do
  // PRESTADOR controla antes de mandar pro ambiente nacional — é esse que deve
  // ser sequencial sem buraco, igual o nNF do NF-e. Guardado à parte pra não
  // confundir com o número exibido pro usuário.
  nfseNumeroDPS?: string;
  // nDFSe — identificador numérico atribuído pelo Ambiente Nacional à NFS-e
  // (distinto de nNFSe, que fica em `numero`). É por esse número (ou pela
  // chave em `chave`) que o evento de cancelamento de NFS-e referencia qual
  // nota está sendo cancelada.
  nfseNumeroDFSe?: string;
  // Campos de auditoria extraídos UMA vez no momento do parse (mesmo padrão do
  // cfopValores). Antes, os memos de auditoria re-parseavam cada XML na thread
  // principal e guardavam todos os DOMs num cache — com 30k+ notas isso
  // estourava a RAM (DOM ocupa 5-10× o tamanho do XML) e congelava o
  // computador inteiro (reproduzido em 2026-08-25 com lote real de 33k).
  extract?: NotaExtract;
}

// ——— Extração pra auditoria (ver comentário do campo `extract` acima) ———
interface ParcelaIbsExtract {
  aliq: number | null;     // alíquota cheia (pIBSUF/pIBSMun/pCBS)
  temRed: boolean;         // grupo gRed presente
  red: number | null;      // pRedAliq (só com gRed)
  aliqEfet: number | null; // pAliqEfet (só com gRed)
  v: number | null;        // valor destacado (vIBSUF/vIBSMun/vCBS)
}
interface ExtractionErrorEntry {
  msg: string;
  // Presentes só quando a falha foi uma extração de RAR que esgotou as
  // retentativas — dá pro analista baixar o arquivo original exatamente como
  // foi enviado, extrair ele mesmo com WinRAR/7-Zip (sem o limite de memória
  // do WASM no navegador) e reanexar o conteúdo já descompactado.
  downloadUrl?: string;
  downloadName?: string;
}
// Laço do Outubro Rosa (prevenção ao câncer de mama). Aparece só em outubro: ver uso no cabeçalho.
function LacoRosa({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Outubro Rosa" className={className} style={{ filter: 'drop-shadow(0 0 5px rgba(236,72,153,0.5))' }} fill="none" stroke="url(#lacoRosaGrad)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <defs><linearGradient id="lacoRosaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F9A8D4" /><stop offset="1" stopColor="#DB2777" /></linearGradient></defs>
      <title>Outubro Rosa — prevenção ao câncer de mama</title>
      <path d="M8 21.5 L12 13 L16.2 5.5 C17 1 7 1 7.8 5.5 L12 13 L16 21.5" />
    </svg>
  );
}
interface DetExtract {
  cProd: string; xProd: string; ncm: string; cest: string; cfop: string; vProd: number; qCom: number; uCom: string;
  cEan: string; cBenef: string;
  icmsTemCst: boolean; icmsTemCsosn: boolean;
  icmsGrupo: string;       // tagName do grupo ICMS do item (ex: "ICMS00", "ICMSSN102")
  icmsCodigo: string;      // valor do CST ou CSOSN (o que existir)
  vBCIcms: number | null;  // vBC filho direto do grupo ICMS (não confundir com o vBC de IBSCBS)
  pICMS: number | null;
  vICMS: number | null;
  temIbsCbs: boolean;      // grupo <IBSCBS> presente no item
  ibsCst: string;          // CST filho direto de <IBSCBS>
  cClassTrib: string;      // idem
  temGIbsCbs: boolean;     // grupo padrão <gIBSCBS> presente (monofásico não tem)
  vBC: number | null;
  vIBS: number | null;     // filho direto de gIBSCBS
  uf?: ParcelaIbsExtract; mun?: ParcelaIbsExtract; cbs?: ParcelaIbsExtract;
}
interface DetPagExtract {
  tPag: string; indPag: string; vPag: number; xPag: string;
  temCard: boolean; tpIntegra: string; cardCnpj: string; cardTBand: string; cardCAut: string;
}
interface NotaExtract {
  crt: string;
  tpAmb: string;           // o de <ide> — o protNFe tem um tpAmb próprio que não é este
  indPres: string; finNFe: string; vTroco: number;
  ufEmit: string; ufDest: string;
  respTecCnpj: string; respTecContato: string; respTecEmail: string; respTecFone: string;
  detPags: DetPagExtract[];
  dets: DetExtract[];
  tot?: { vBC: number | null; vIBS: number | null; vCBS: number | null }; // IBSCBSTot
}

// Extrai do DOM (já aberto pelo parseXML) tudo que os memos de auditoria leem.
// IMPORTANTE: usa childNodes+nodeType (não .children) porque o fileWorker roda
// esta mesma função com @xmldom/xmldom, que não implementa .children — e os
// nomes de tag repetem entre contextos (CST, vBC, vIBS...), então navegação
// por filho direto é obrigatória pra não pegar campo de outro grupo.
// Espelhada em fileWorker.ts — não mude uma sem mudar a outra.
function extrairAuditoria(doc: Document): NotaExtract {
  const filhos = (el: any): any[] => el ? Array.from(el.childNodes).filter((n: any) => n.nodeType === 1) : [];
  const filho = (el: any, tag: string): any => filhos(el).find((e: any) => e.tagName === tag);
  const txt = (el: any): string => el?.textContent?.trim() ?? '';
  const num = (el: any): number | null => {
    const t = txt(el);
    if (!t) return null;
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  };
  const primeiro = (tag: string) => (doc as any).getElementsByTagName(tag)[0];

  const emit = primeiro('emit');
  const ide = primeiro('ide');
  const infRespTec = primeiro('infRespTec');

  const parcela = (grupo: any, pTag: string, vTag: string): ParcelaIbsExtract | undefined => {
    if (!grupo) return undefined;
    const gRed = filho(grupo, 'gRed');
    return {
      aliq: num(filho(grupo, pTag)),
      temRed: !!gRed,
      red: gRed ? num(filho(gRed, 'pRedAliq')) : null,
      aliqEfet: gRed ? num(filho(gRed, 'pAliqEfet')) : null,
      v: num(filho(grupo, vTag)),
    };
  };

  const dets: DetExtract[] = Array.from((doc as any).getElementsByTagName('det')).map((det: any) => {
    const prod = det.getElementsByTagName('prod')[0];
    const imposto = det.getElementsByTagName('imposto')[0];
    // ICMS: o primeiro elemento-filho do grupo <ICMS> (ICMS00/ICMS60/ICMSSN102...)
    // é quem carrega CST ou CSOSN — mesma navegação da auditoriaRegime original.
    const icmsGroup = imposto?.getElementsByTagName('ICMS')[0];
    const icmsNode = icmsGroup ? filhos(icmsGroup)[0] : undefined;
    const ibscbs = imposto?.getElementsByTagName('IBSCBS')[0];
    const g = ibscbs ? filho(ibscbs, 'gIBSCBS') : undefined;
    return {
      cProd: txt(filho(prod, 'cProd')),
      xProd: txt(filho(prod, 'xProd')),
      ncm: txt(filho(prod, 'NCM')),
      cest: txt(filho(prod, 'CEST')),
      cfop: txt(filho(prod, 'CFOP')),
      vProd: num(filho(prod, 'vProd')) ?? 0,
      qCom: num(filho(prod, 'qCom')) ?? 0,
      uCom: txt(filho(prod, 'uCom')),
      cEan: txt(filho(prod, 'cEAN')),
      cBenef: txt(filho(prod, 'cBenef')),
      icmsTemCst: !!icmsNode?.getElementsByTagName('CST')[0],
      icmsTemCsosn: !!icmsNode?.getElementsByTagName('CSOSN')[0],
      icmsGrupo: icmsNode?.tagName || '',
      icmsCodigo: txt(filho(icmsNode, 'CST')) || txt(filho(icmsNode, 'CSOSN')),
      vBCIcms: icmsNode ? num(filho(icmsNode, 'vBC')) : null,
      pICMS: icmsNode ? num(filho(icmsNode, 'pICMS')) : null,
      vICMS: icmsNode ? num(filho(icmsNode, 'vICMS')) : null,
      temIbsCbs: !!ibscbs,
      ibsCst: txt(filho(ibscbs, 'CST')),
      cClassTrib: txt(filho(ibscbs, 'cClassTrib')),
      temGIbsCbs: !!g,
      vBC: g ? num(filho(g, 'vBC')) : null,
      vIBS: g ? num(filho(g, 'vIBS')) : null,
      uf: g ? parcela(filho(g, 'gIBSUF'), 'pIBSUF', 'vIBSUF') : undefined,
      mun: g ? parcela(filho(g, 'gIBSMun'), 'pIBSMun', 'vIBSMun') : undefined,
      cbs: g ? parcela(filho(g, 'gCBS'), 'pCBS', 'vCBS') : undefined,
    };
  });

  const detPags: DetPagExtract[] = Array.from((doc as any).getElementsByTagName('detPag')).map((detPag: any) => {
    const card = detPag.getElementsByTagName('card')[0];
    return {
      tPag: txt(detPag.getElementsByTagName('tPag')[0]),
      indPag: txt(detPag.getElementsByTagName('indPag')[0]),
      vPag: num(detPag.getElementsByTagName('vPag')[0]) ?? 0,
      xPag: txt(detPag.getElementsByTagName('xPag')[0]),
      temCard: !!card,
      tpIntegra: txt(card?.getElementsByTagName('tpIntegra')[0]),
      cardCnpj: txt(card?.getElementsByTagName('CNPJ')[0]),
      cardTBand: txt(card?.getElementsByTagName('tBand')[0]),
      cardCAut: txt(card?.getElementsByTagName('cAut')[0]),
    };
  });

  const tot = primeiro('IBSCBSTot');

  return {
    crt: txt(emit?.getElementsByTagName('CRT')[0]),
    tpAmb: txt(filho(ide, 'tpAmb')),
    indPres: txt(primeiro('indPres')),
    finNFe: txt(primeiro('finNFe')),
    vTroco: num(primeiro('vTroco')) ?? 0,
    ufEmit: txt(primeiro('enderEmit')?.getElementsByTagName('UF')[0]),
    ufDest: txt(primeiro('enderDest')?.getElementsByTagName('UF')[0]),
    respTecCnpj: txt(infRespTec?.getElementsByTagName('CNPJ')[0]),
    respTecContato: txt(infRespTec?.getElementsByTagName('xContato')[0]),
    respTecEmail: txt(infRespTec?.getElementsByTagName('email')[0]),
    respTecFone: txt(infRespTec?.getElementsByTagName('fone')[0]),
    detPags,
    dets,
    tot: tot ? {
      vBC: num(filho(tot, 'vBCIBSCBS')),
      vIBS: num(filho(filho(tot, 'gIBS'), 'vIBS')),
      vCBS: num(filho(filho(tot, 'gCBS'), 'vCBS')),
    } : undefined,
  };
}

interface SourceMetadata {
  name: string;
  isZip: boolean;
  totalXmls: number;
  saidaCount: number;
  entradaCount: number;
}

interface SerieAnalysis {
  cnpj: string;
  ie: string;
  razaoSocial: string;
  partnerNome?: string;
  direcao?: 'entrada' | 'saida';
  modelo: string;
  serie: string;
  xmls: XmlData[];
  min: number;
  max: number;
  esperados: number;
  recebidos: number;
  faltantes: number[];
  faltantesInutilizados: number[];
  // Subset of faltantesInutilizados that came from a manually-typed confirmation
  // rather than an actual XML — these won't be resolved yet in the SEFAZ system
  // (e.g. Questor), so they need to stay visibly flagged.
  faltantesInutilizadosManual: number[];
  // Subset of faltantesInutilizados whose inutilização was recebida em mês diferente
  // do mês atualmente filtrado — sinalizado porque o cruzamento agora ignora o filtro
  // de mês de propósito (a data de recebimento da inutilização não tem relação com o
  // mês do número que ela cobre), então vale destacar pro contador conferir.
  faltantesInutilizadosOutroMes: number[];
  // Todos os números inutilizados dessa série/modelo, tenham ou não relação com um
  // número faltante — útil pra mostrar mesmo quando a série já está íntegra.
  todasInutilizacoes: number[];
  cancelados?: number[];
  duplicados?: number;
  situacao: string;
  mesReferencia: string;
}

interface Stats {
  totalFiles: number;
  totalXmls: number;
  validNf: number;
  inutilizations: number;
  cancellations: number;
  nonXmlCount: number;
}

type TipoDiferencaAuditoria = 'NCM' | 'Nome' | 'Nome e NCM' | 'Sequência' | 'Planilha';

interface DiferencaAuditoria {
  tipo: TipoDiferencaAuditoria;
  itemSequencia: string;
  itemPlanilha: string;
  ncmSequencia: string;
  ncmPlanilha: string;
  // Chaves cruas "serie::numero" (não formatadas ainda) — formatação e o
  // cruzamento entre categorias acontecem depois de montar todas as diferenças.
  notasSequencia: string[];
  notasPlanilha: string[];
  ocorrencias: number;
  valor: number;
  outrosTipos?: string;
}

interface SpedC100 {
  indOper: string;  // '0'=entrada '1'=saída
  codMod: string;   // '55'=NF-e '65'=NFC-e '01'=NF papel
  codSit: string;   // '00'=regular '02'=cancelada
  ser: string;
  numDoc: string;
  chave: string;    // CHV_NFE (44 dígitos) — vazio para modelo 01
  dtDoc: string;    // DDMMAAAA
  vlDoc: string;
}

// Agregado por produto dentro de um código de classificação IBS/CBS — vai pro
// laudo pra o analista ver qual produto o cliente cadastrou em qual código.
interface ProdutoDoCodigo {
  xProd: string;
  ncm: string;
  itens: number;
  valor: number;
  vIbsCbs: number;
}

interface SpedData {
  cnpj: string;
  razaoSocial: string;
  dtIni: string;   // DDMMAAAA
  dtFin: string;
  c100: SpedC100[];
  fileName: string;
  rawText: string;
}

// --- Helpers ---

const parser = new DOMParser();

function parseXML(xmlText: string, fileName: string): XmlData {
  const lowerText = xmlText.toLowerCase();

  // NFS-e (Nota Fiscal de Serviços Eletrônica, padrão Sistema Nacional/ADN) —
  // schema totalmente diferente da família NF-e, não tem nada em comum com os
  // marcadores de isFiscal abaixo, então precisa ser detectada antes, senão
  // cai no "outro" e some sem aviso nenhum. Extração é best-effort: o padrão
  // nacional é recente e alguns emissores ainda variam detalhes de nomeação.
  const isNfse = lowerText.includes('<infnfse') || lowerText.includes('<infdps') ||
                 lowerText.includes('<nfse ') || lowerText.includes('<nfse>');
  if (isNfse) {
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const getTxt = (parent: Document | Element | undefined, tag: string) =>
      parent?.getElementsByTagName(tag)[0]?.textContent?.trim() || '';

    const infNFSe = doc.getElementsByTagName('infNFSe')[0];
    const prestEl = doc.getElementsByTagName('emit')[0] || doc.getElementsByTagName('prest')[0];
    const tomaEl = doc.getElementsByTagName('toma')[0];

    return {
      tipo: 'nfse',
      fileName,
      numero: getTxt(doc, 'nNFSe') || getTxt(doc, 'nDFSe') || getTxt(doc, 'nDPS'),
      serie: getTxt(doc, 'serie'),
      data: getTxt(doc, 'dhProc') || getTxt(doc, 'dhEmi'),
      cnpj: getTxt(prestEl, 'CNPJ'),
      razaoSocial: getTxt(prestEl, 'xNome'),
      emitCnpj: getTxt(prestEl, 'CNPJ'),
      emitNome: getTxt(prestEl, 'xNome'),
      destCnpj: getTxt(tomaEl, 'CNPJ') || getTxt(tomaEl, 'CPF'),
      destNome: getTxt(tomaEl, 'xNome'),
      valor: getTxt(doc, 'vServ') || getTxt(doc, 'vLiq'),
      descServico: getTxt(doc, 'xDescServ'),
      // nDPS — número controlado pelo prestador, usado pra auditoria de
      // sequência (ver comentário no campo, na interface XmlData).
      nfseNumeroDPS: getTxt(doc, 'nDPS'),
      nfseNumeroDFSe: getTxt(doc, 'nDFSe'),
      chave: infNFSe?.getAttribute('Id') || '',
      modelo: 'NFS-e',
      rawXml: xmlText,
    };
  }

  // Evento de cancelamento de NFS-e (Ambiente Nacional) — é um XML SEPARADO
  // da NFS-e original (raiz <evento><infEvento>, mesmo xmlns da NFS-e), não
  // uma atualização de status dentro da própria nota. Referencia a nota
  // cancelada por chNFSe (chave) e/ou nDFSe (número); guardamos os dois pra
  // cruzar depois. Best-effort: nomes de tag ainda variam entre emissores.
  const isNfseEvento = lowerText.includes('<infevento') && lowerText.includes('sped.fazenda.gov.br/nfse');
  if (isNfseEvento) {
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const getTxt = (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    return {
      tipo: 'nfse_evento',
      fileName,
      chave: getTxt('chNFSe') || getTxt('chDFSe'),
      numero: getTxt('nDFSe'),
      data: getTxt('dhEvento') || getTxt('dhProc'),
      modelo: 'NFS-e',
      rawXml: xmlText,
    };
  }

  // More robust fiscal check
  const isFiscal = lowerText.includes('<infnfe') ||
                   lowerText.includes('<inutnfe') ||
                   lowerText.includes('<retinutnfe') ||
                   lowerText.includes('<proceventonfe') ||
                   lowerText.includes('<eventonfe') ||
                   lowerText.includes('<retconssitnfe') ||
                   lowerText.includes('<proccancnfe');

  if (!isFiscal) {
    return { tipo: 'outro', fileName };
  }

  const doc = parser.parseFromString(xmlText, 'text/xml');
  
  const getTextContent = (tagName: string) => {
    const element = doc.getElementsByTagName(tagName)[0];
    return element ? (element.textContent || '').trim() : '';
  };

  const getAllTextContent = (tagName: string) => {
    return Array.from(doc.getElementsByTagName(tagName)).map(el => el.textContent || '');
  };

  // Check for cancellation indicators anywhere in the document
  const cStats = getAllTextContent('cStat');
  const xMotivos = getAllTextContent('xMotivo');
  const descEventos = getAllTextContent('descEvento');
  
  const hasCancelStat = cStats.some(stat => stat === '101' || stat === '135' || stat === '155');
  const hasCancelMotivo = xMotivos.some(motivo => motivo.toLowerCase().includes('cancel'));
  const hasCancelEvento = descEventos.some(desc => desc.toLowerCase().includes('cancel'));
  const hasCancelTag = doc.getElementsByTagName('retCancNFe').length > 0 || doc.getElementsByTagName('procCancNFe').length > 0;
  
  const isCancel = hasCancelStat || hasCancelMotivo || hasCancelEvento || hasCancelTag;
  
  // Check for Events (like Cancellation)
  const isEvento = doc.getElementsByTagName('procEventoNFe').length > 0 || doc.getElementsByTagName('eventoNFe').length > 0;
  if (isEvento) {
    // tpEvento: 110111 = Cancelamento; 110112 = Cancelamento por Substituição; outros = carta de correção, etc.
    const tpEvento = getTextContent('tpEvento');
    const isCancelamentoEvento = tpEvento === '110111' || tpEvento === '110112';
    return {
      tipo: 'evento',
      subTipo: tpEvento || descEventos[0] || 'Evento',
      isCancelamento: isCancelamentoEvento,
      cnpj: getTextContent('CNPJ'),
      chave: getTextContent('chNFe'),
      fileName,
      rawXml: xmlText
    };
  }

  // Old cancellation format (procCancNFe): pre-evento NF-e systems
  const isProcCancNFe = doc.getElementsByTagName('procCancNFe').length > 0;
  if (isProcCancNFe) {
    return {
      tipo: 'evento',
      subTipo: '110111',
      isCancelamento: true,
      cnpj: getTextContent('CNPJ'),
      chave: getTextContent('chNFe'),
      fileName,
      rawXml: xmlText
    };
  }

  // Check for Consultation results (e.g. retConsSitNFe downloaded from SEFAZ portal)
  const isConsulta = doc.getElementsByTagName('retConsSitNFe').length > 0;
  if (isConsulta) {
    return {
      tipo: 'consulta',
      subTipo: xMotivos[0] || 'Consulta',
      isCancelamento: isCancel,
      chave: getTextContent('chNFe'),
      fileName,
      rawXml: xmlText
    };
  }

  // Check for Inutilization
  const isInut = doc.getElementsByTagName('retInutNFe').length > 0 || 
                doc.getElementsByTagName('inutNFe').length > 0 ||
                doc.getElementsByTagName('infInut').length > 0;
  
  if (isInut) {
    const nNFIni = getTextContent('nNFIni');
    const nNFFin = getTextContent('nNFFin');
    const serie = getTextContent('serie');
    const modelo = getTextContent('mod');
    const cnpj = getTextContent('CNPJ');
    
    if (nNFIni && nNFFin && serie && modelo && cnpj) {
      return {
        tipo: 'inutilizacao',
        cnpj: cnpj,
        ie: getTextContent('IE'),
        modelo: modelo,
        serie: serie,
        nNFIni: parseInt(nNFIni) || 0,
        nNFFin: parseInt(nNFFin) || 0,
        data: getTextContent('dhRecbto') || getTextContent('dhEmi') || '',
        fileName,
        rawXml: xmlText
      };
    }
  }
  
  // Check for NF-e / NFC-e
  const isNfe = doc.getElementsByTagName('infNFe').length > 0;
  if (isNfe) {
    const numero = getTextContent('nNF');
    const serie = getTextContent('serie');
    const modelo = getTextContent('mod');
    const tpEmis = getTextContent('tpEmis');
    const tpNF = getTextContent('tpNF');
    
    // Extract Emitente and Destinatário
    const emit = doc.getElementsByTagName('emit')[0];
    const dest = doc.getElementsByTagName('dest')[0];
    
    const emitCnpj = emit?.getElementsByTagName('CNPJ')[0]?.textContent || '';
    const emitNome = emit?.getElementsByTagName('xNome')[0]?.textContent || '';
    let destCnpj = dest?.getElementsByTagName('CNPJ')[0]?.textContent || '';
    let destNome = dest?.getElementsByTagName('xNome')[0]?.textContent || '';
    // Fallback: if DOM missed the dest block (can happen with certain XML namespace handling),
    // extract via regex directly from the raw text
    if (!destCnpj) {
      const m = xmlText.match(/<dest[\s>][\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
      if (m) destCnpj = m[1];
    }
    if (!destNome) {
      const m = xmlText.match(/<dest[\s>][\s\S]*?<xNome>([^<]+)<\/xNome>/);
      if (m) destNome = m[1];
    }

    // Group each item's NET value (vProd - vDesc + vOutro/vFrete/vSeg) by its CFOP, so the
    // note's vNF (already net of discount) can later be split by natureza da operação even
    // when a single note mixes more than one CFOP. Using gross vProd as the weight here would
    // misallocate vNF whenever items in different CFOPs carry different desconto amounts.
    const cfopValores: Record<string, number> = {};
    Array.from(doc.getElementsByTagName('det')).forEach(det => {
      const cfop = det.getElementsByTagName('CFOP')[0]?.textContent || '';
      const num = (tag: string) => parseFloat(det.getElementsByTagName(tag)[0]?.textContent || '0') || 0;
      const valorNetoItem = num('vProd') - num('vDesc') + num('vOutro') + num('vFrete') + num('vSeg');
      if (cfop) cfopValores[cfop] = (cfopValores[cfop] || 0) + valorNetoItem;
    });

    if (numero && serie && modelo) {
      // tpNF === '0' (entrada) does NOT mean "discard": a company can issue its own
      // NFe under CFOP de entrada (ex: 1202 devolução de venda, 1949, baixa de estoque)
      // using its own numbering/série — that note still occupies a real slot in the
      // sequence being audited, so it must be kept (just excluded from revenue later).
      return {
        tipo: 'nfe',
        cnpj: emitCnpj, // Default to issuer for legacy compatibility
        emitCnpj,
        emitNome,
        destCnpj,
        destNome,
        ie: getTextContent('IE'),
        razaoSocial: emitNome,
        modelo,
        serie,
        numero,
        isContingencia: tpEmis === '9',
        isCancelamento: isCancel,
        chave: getTextContent('chNFe') || (doc.getElementsByTagName('infNFe')[0]?.getAttribute('Id') || '').replace('NFe', ''),
        data: getTextContent('dhEmi'),
        valor: getTextContent('vNF'),
        natureza: getTextContent('natOp'),
        protocolo: getTextContent('nProt'),
        dhRecbto: getTextContent('dhRecbto') || undefined,
        tpNF,
        cfopValores,
        extract: extrairAuditoria(doc),
        fileName,
        rawXml: xmlText
      };
    }
  }

  return { tipo: 'outro', fileName };
}

// Contingência autorizada fora do prazo: emitida em modo offline (tpEmis=9), tem protocolo
// mas o SEFAZ só recebeu mais de 30 minutos após a emissão.
function isForaDoPrazo(xml: XmlData): boolean {
  if (!xml.isContingencia || !xml.protocolo || !xml.dhRecbto || !xml.data) return false;
  const emi = new Date(xml.data).getTime();
  const rec = new Date(xml.dhRecbto).getTime();
  return !isNaN(emi) && !isNaN(rec) && (rec - emi) > 1_800_000;
}

// CFOP 5929 não entra no faturamento contábil (baixa de estoque por doação).
function isAlertCfop(cfop: string): boolean {
  return cfop === '5929';
}

// Distingue CFOP de venda genuína (5101/5102/5401/6101... etc) de saída que NÃO é
// venda (transferência x151-x156, devolução de compra x201-x212/x410-x413, remessas/
// consignação/bonificação/amostra x901-x949) — os últimos 3 dígitos do CFOP definem
// a natureza da operação de forma consistente entre 5xxx (interno), 6xxx (interestadual)
// e 7xxx (exterior), então basta olhar o resto da divisão por 1000.
function isCfopVenda(cfop: string): boolean {
  if (!/^\d{4}$/.test(cfop)) return false;
  const resto = parseInt(cfop, 10) % 1000;
  if (resto >= 151 && resto <= 156) return false;
  if (resto >= 201 && resto <= 212) return false;
  // 408/409 = transferência sujeita a ST (Transferência de produção/mercadoria
  // de terceiros, em operação com produto sujeito ao regime de substituição
  // tributária) — ficava faltando aqui, então uma transferência entre filiais
  // sob ST (ex: CFOP 5409) passava como se fosse venda.
  if (resto >= 408 && resto <= 413) return false;
  if (resto >= 901 && resto <= 949) return false;
  return true;
}

function parseSped(text: string, fileName: string): SpedData | null {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('|0000|')) return null;
  const h = lines[0].split('|');
  // |0000|COD_VER|COD_FIN|DT_INI|DT_FIN|NOME|CNPJ|...
  const dtIni = h[4] || '';
  const dtFin = h[5] || '';
  const razaoSocial = h[6] || '';
  const cnpj = h[7] || '';
  const c100: SpedC100[] = [];
  for (const line of lines) {
    if (!line.startsWith('|C100|')) continue;
    const f = line.split('|');
    // |C100|IND_OPER|IND_EMIT|COD_PART|COD_MOD|COD_SIT|SER|NUM_DOC|CHV_NFE|DT_DOC|DT_E_S|VL_DOC|...
    c100.push({
      indOper: f[2] || '',
      codMod: f[5] || '',
      codSit: f[6] || '',
      ser: f[7] || '',
      numDoc: f[8] || '',
      chave: f[9] || '',
      dtDoc: f[10] || '',
      vlDoc: f[12] || '',
    });
  }
  return { cnpj, razaoSocial, dtIni, dtFin, c100, fileName, rawText: text };
}

function gerarSpedCorrigido(spedData: SpedData, xmlsParaAdicionar: XmlData[]): string {
  if (xmlsParaAdicionar.length === 0) return spedData.rawText;

  const dtSped = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}${m[2]}${m[1]}` : '';
  };
  const vlSped = (v: string) => {
    const n = parseFloat((v ?? '').replace(',', '.'));
    return isNaN(n) ? '0,00' : n.toFixed(2).replace('.', ',');
  };

  const novasC100 = xmlsParaAdicionar.map(x => {
    const dt = dtSped(x.data ?? '');
    const vl = vlSped(x.valor ?? '0');
    // Segue o mesmo padrão das NFC-e saída já presentes no SPED:
    // campos tributários (VL_BC_ICMS, VL_ICMS, PIS, COFINS...) ficam vazios
    // VL_MERC = VL_DOC, IND_FRT=9 (sem frete), IND_PGTO=2 (outros)
    // |C100|IND_OPER|IND_EMIT|COD_PART|COD_MOD|COD_SIT|SER|NUM_DOC|CHV_NFE|DT_DOC|DT_E_S|VL_DOC|IND_PGTO|VL_DESC|VL_ABAT_NT|VL_MERC|IND_FRT|VL_FRT|VL_SEG|VL_OUT_DA|VL_BC_ICMS|VL_ICMS|VL_BC_ICMS_ST|VL_ICMS_ST|VL_IPI|VL_PIS|VL_COFINS|VL_PIS_ST|VL_COFINS_ST
    return `|C100|1|0||${x.modelo ?? '55'}|00|${x.serie ?? ''}|${x.numero ?? ''}|${x.chave ?? ''}|${dt}|${dt}|${vl}|2|||${vl}|9|||||||||||||`;
  });

  let lines = spedData.rawText.split(/\r?\n/);

  // Inserir novos C100 antes do C990
  const c990Idx = lines.findIndex(l => l.trimStart().startsWith('|C990|'));
  if (c990Idx >= 0) {
    lines = [...lines.slice(0, c990Idx), ...novasC100, ...lines.slice(c990Idx)];
  } else {
    const b9Idx = lines.findIndex(l => l.trimStart().startsWith('|9001|'));
    const at = b9Idx >= 0 ? b9Idx : lines.length;
    lines = [...lines.slice(0, at), ...novasC100, ...lines.slice(at)];
  }

  // Recalcular C990 (total de registros do bloco C incluindo C990)
  const newC990Idx = lines.findIndex(l => l.trimStart().startsWith('|C990|'));
  if (newC990Idx >= 0) {
    const cCount = lines.filter(l => /^\|C\d/.test(l.trimStart())).length;
    lines[newC990Idx] = `|C990|${cCount}|`;
  }

  // Atualizar 9900|C100 e 9900|C990 com novas contagens
  const countOf = (tipo: string) => lines.filter(l => l.split('|')[1] === tipo).length;
  for (const tipo of ['C100', 'C190', 'C990']) {
    const idx = lines.findIndex(l => { const p = l.split('|'); return p[1] === '9900' && p[2] === tipo; });
    if (idx >= 0) lines[idx] = `|9900|${tipo}|${countOf(tipo)}|`;
  }

  // Recalcular 9900|9900 (conta as próprias linhas 9900)
  const n9900 = lines.filter(l => l.split('|')[1] === '9900').length;
  const self9900 = lines.findIndex(l => { const p = l.split('|'); return p[1] === '9900' && p[2] === '9900'; });
  if (self9900 >= 0) lines[self9900] = `|9900|9900|${n9900}|`;

  // Recalcular 9990 (total de registros do bloco 9)
  const block9 = lines.filter(l => { const t = l.split('|')[1]; return t === '9001' || t === '9900' || t === '9990' || t === '9999'; }).length;
  const idx9990 = lines.findIndex(l => l.trimStart().startsWith('|9990|'));
  if (idx9990 >= 0) lines[idx9990] = `|9990|${block9}|`;

  // Recalcular 9999 (total de linhas no arquivo)
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const idx9999 = nonEmpty.findIndex(l => l.trimStart().startsWith('|9999|'));
  if (idx9999 >= 0) nonEmpty[idx9999] = `|9999|${nonEmpty.length}|`;

  return nonEmpty.join('\r\n') + '\r\n';
}

function agruparFaixas(numeros: number[]) {
  if (numeros.length === 0) return [];
  const sorted = [...numeros].sort((a, b) => a - b);
  const faixas: number[][] = [];
  let faixa = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i-1] + 1) {
      faixa.push(sorted[i]);
    } else {
      faixas.push(faixa);
      faixa = [sorted[i]];
    }
  }
  faixas.push(faixa);
  return faixas;
}

function formatarFaixas(faixas: number[][]) {
  return faixas.map(f => 
    f.length === 1 ? f[0] : `${f[0]} a ${f[f.length - 1]}`
  ).join(', ');
}

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

// Dia da semana só a partir do calendário (Y-M-D), sem passar pelo fuso do
// dhEmi nem do navegador — "new Date(isoComOffset).getDay()" pode escorregar
// pro dia errado perto da meia-noite dependendo do fuso local de quem roda o
// app. Date.UTC com os 3 números soltos elimina essa ambiguidade.
function diaDaSemana(dataYMD: string): number {
  const [y, m, d] = dataYMD.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
}

function getMonthYear(dateStr?: string) {
  if (!dateStr || dateStr.length < 7) return '';
  const parts = dateStr.split('-');
  if (parts.length < 2) return '';
  const year = parts[0];
  const month = parts[1];
  const mIdx = parseInt(month) - 1;
  if (mIdx >= 0 && mIdx < 12) {
    return `${MESES[mIdx]}/${year}`;
  }
  return '';
}

// Chave de período de um SPED no mesmo formato do filtro de mês da tela
// ("Julho/2026") — é o que permite guardar um SPED por mês e puxar o certo
// quando o usuário troca o filtro, em vez de um único SPED ativo por vez.
function spedPeriodKey(sped: SpedData): string {
  const mIdx = parseInt(sped.dtIni.slice(2, 4)) - 1;
  const ano = sped.dtIni.slice(4, 8);
  if (mIdx >= 0 && mIdx < 12 && ano) return `${MESES[mIdx]}/${ano}`;
  return sped.dtIni;
}

// DT_INI ilegível (vazio, truncado, arquivo corrompido) faz spedPeriodKey
// cair no fallback e devolver "" ou lixo como chave — daí esse SPED vira uma
// "competência" própria, nunca reconhecida como duplicata do SPED bom do
// mesmo mês, e as notas dos dois somam (visto em produção: SPED mostrando
// quase o dobro de saídas). Por isso todo SPED tem essa data validada ANTES
// de entrar em mergeSpedBatch/upsertSpedManual — se não é uma data DDMMAAAA
// de verdade, o SPED é descartado (com aviso), não silenciosamente aceito.
function spedTemPeriodoValido(sped: SpedData): boolean {
  return /^\d{8}$/.test(sped.dtIni);
}

type SpedEntry = { data: SpedData; original?: SpedData };
type SpedEntries = Record<string, SpedEntry>;

// Upload manual (botão "Anexar SPED"): o arquivo anexado agora sempre vira o
// atual do seu próprio mês — se já havia um SPED daquele mesmo mês, ele vira o
// "original" (usado só pra o diff de "adicionados" entre duas versões da MESMA
// competência, ex: retificadora). Meses diferentes não se sobrescrevem mais.
function upsertSpedManual(entries: SpedEntries, sped: SpedData): SpedEntries {
  const key = spedPeriodKey(sped);
  return { ...entries, [key]: { data: sped, original: entries[key]?.data } };
}

// Upload em lote: pode trazer vários SPEDs de uma vez (um por mês, ou
// duplicados do mesmo mês vindos de arquivos diferentes). Agrupa por
// competência; dentro da mesma competência o que tiver mais notas C100 vence
// e o outro vira "original" — igual à regra que já existia, só que agora
// aplicada por mês em vez de globalmente (senão o SPED de um mês apagava o
// de outro mês só por ter mais linhas).
function mergeSpedBatch(entries: SpedEntries, found: SpedData[]): SpedEntries {
  let result = entries;
  for (const sped of found) {
    const key = spedPeriodKey(sped);
    const existing = result[key];
    if (!existing) {
      result = { ...result, [key]: { data: sped } };
    } else if (sped.c100.length > existing.data.c100.length) {
      result = { ...result, [key]: { data: sped, original: existing.data } };
    } else {
      result = { ...result, [key]: { data: existing.data, original: sped } };
    }
  }
  return result;
}

// Standard CFOP descriptions (Ajuste SINIEF 07/2001), keyed by the last 3 digits.
// The same 3-digit suffix has the same meaning for saída dentro do Estado (5xxx),
// para outro Estado (6xxx) or para o exterior (7xxx), so one table covers all prefixes.
const CFOP_DESCRICOES: Record<string, string> = {
  '101': 'Venda de produção do estabelecimento',
  '102': 'Venda de mercadoria adquirida ou recebida de terceiros',
  '103': 'Venda de produção do estabelecimento, efetuada fora do estabelecimento',
  '104': 'Venda de mercadoria adquirida ou recebida de terceiros, efetuada fora do estabelecimento',
  '105': 'Venda de produção do estabelecimento, que não deva por ele transitar',
  '106': 'Venda de mercadoria adquirida ou recebida de terceiros, que não deva por ele transitar',
  '109': 'Venda de produção do estabelecimento, destinada à Zona Franca de Manaus ou Áreas de Livre Comércio',
  '110': 'Venda de mercadoria adquirida ou recebida de terceiros, destinada à Zona Franca de Manaus ou Áreas de Livre Comércio',
  '111': 'Venda de produção do estabelecimento, remetida anteriormente em consignação',
  '112': 'Venda de mercadoria adquirida ou recebida de terceiros, remetida anteriormente em consignação',
  '113': 'Venda de produção do estabelecimento, destinada a não contribuinte',
  '114': 'Venda de mercadoria adquirida ou recebida de terceiros, destinada a não contribuinte',
  '115': 'Venda de mercadoria adquirida ou recebida de terceiros, recebida anteriormente em consignação',
  '116': 'Venda de produção do estabelecimento originada de encomenda para entrega futura',
  '117': 'Venda de mercadoria adquirida ou recebida de terceiros, originada de encomenda para entrega futura',
  '118': 'Venda de produção do estabelecimento entregue ao destinatário por conta e ordem do adquirente originário, em venda à ordem',
  '119': 'Venda de mercadoria adquirida ou recebida de terceiros entregue ao destinatário por conta e ordem do adquirente originário, em venda à ordem',
  '120': 'Venda de mercadoria adquirida ou recebida de terceiros entregue ao destinatário pelo vendedor remetente, em venda à ordem',
  '122': 'Venda de produção do estabelecimento entregue ao destinatário no território nacional, em venda à ordem, quando a mercadoria não transitar pelo estabelecimento do adquirente originário',
  '124': 'Industrialização efetuada para outra empresa',
  '125': 'Industrialização efetuada para outra empresa quando a mercadoria remetida para utilização no processo tiver sido recebida de terceiros',
  '151': 'Transferência de produção do estabelecimento',
  '152': 'Transferência de mercadoria adquirida ou recebida de terceiros',
  '153': 'Transferência de energia elétrica',
  '155': 'Transferência de produção do estabelecimento, que não deva por ele transitar',
  '156': 'Transferência de mercadoria adquirida ou recebida de terceiros, que não deva por ele transitar',
  '159': 'Transferência de produção do estabelecimento, sujeita ao regime de substituição tributária',
  '160': 'Transferência de mercadoria adquirida ou recebida de terceiros, sujeita ao regime de substituição tributária',
  '201': 'Devolução de compra para industrialização ou produção rural',
  '202': 'Devolução de compra para comercialização',
  '205': 'Devolução de mercadoria recebida em transferência para industrialização ou produção rural',
  '206': 'Devolução de mercadoria recebida em transferência para comercialização',
  '207': 'Devolução de mercadoria recebida em transferência no comércio atacadista destinada a uso, consumo ou ativo imobilizado',
  '208': 'Devolução de mercadoria recebida em doação para industrialização ou produção rural',
  '209': 'Devolução de mercadoria recebida em doação para comercialização',
  '210': 'Devolução de compra para utilização na prestação de serviço',
  '251': 'Venda de energia elétrica para distribuição ou comercialização',
  '252': 'Venda de mercadoria adquirida ou recebida de terceiros, destinada à Zona Franca de Manaus ou Áreas de Livre Comércio, remetida por conta e ordem',
  '253': 'Venda de energia elétrica para consumo',
  '301': 'Venda de produção do estabelecimento efetuada por sujeito passivo por substituição tributária, na condição de contribuinte substituído',
  '302': 'Venda de mercadoria adquirida ou recebida de terceiros efetuada por sujeito passivo por substituição tributária, na condição de contribuinte substituído',
  '303': 'Venda de mercadoria adquirida ou recebida de terceiros sujeita ao regime de substituição tributária, na condição de contribuinte substituto',
  '304': 'Venda de produção do estabelecimento sujeita ao regime de substituição tributária, na condição de contribuinte substituto',
  '401': 'Venda de produção do estabelecimento em operação com produto sujeito ao regime de substituição tributária, na condição de contribuinte substituto',
  '403': 'Venda de mercadoria adquirida ou recebida de terceiros em operação com produto sujeito ao regime de substituição tributária, na condição de contribuinte substituto',
  '405': 'Venda de mercadoria adquirida ou recebida de terceiros em operação com mercadoria sujeita ao regime de substituição tributária, na condição de contribuinte substituído',
  '408': 'Transferência de produção do estabelecimento, em operação com produto sujeito ao regime de substituição tributária',
  '409': 'Transferência de mercadoria adquirida ou recebida de terceiros, em operação com mercadoria sujeita ao regime de substituição tributária',
  '410': 'Devolução de compra para industrialização, em operação com mercadoria sujeita ao regime de substituição tributária',
  '411': 'Devolução de compra para comercialização, em operação com mercadoria sujeita ao regime de substituição tributária',
  '412': 'Devolução de mercadoria recebida em transferência para industrialização, em operação com mercadoria sujeita ao regime de substituição tributária',
  '413': 'Devolução de mercadoria recebida em transferência para comercialização, em operação com mercadoria sujeita ao regime de substituição tributária',
  '414': 'Remessa de produção do estabelecimento para venda fora do estabelecimento, em operação com produto sujeito ao regime de substituição tributária',
  '415': 'Remessa de mercadoria adquirida ou recebida de terceiros para venda fora do estabelecimento, em operação com mercadoria sujeita ao regime de substituição tributária',
  '501': 'Remessa de produção do estabelecimento, com fim específico de exportação',
  '502': 'Remessa de mercadoria adquirida ou recebida de terceiros, com fim específico de exportação',
  '551': 'Venda de bem do ativo imobilizado',
  '552': 'Transferência de bem do ativo imobilizado',
  '553': 'Devolução de compra de bem para o ativo imobilizado',
  '554': 'Remessa de bem do ativo imobilizado para uso fora do estabelecimento',
  '555': 'Devolução de bem do ativo imobilizado de terceiro, recebido para uso fora do estabelecimento',
  '556': 'Devolução de compra de material de uso ou consumo',
  '601': 'Venda de produção do estabelecimento, remetida anteriormente com fim específico de exportação',
  '602': 'Venda de mercadoria adquirida ou recebida de terceiros, remetida anteriormente com fim específico de exportação',
  '651': 'Venda de combustível ou lubrificante de produção do estabelecimento destinada à industrialização subsequente',
  '652': 'Venda de combustível ou lubrificante de produção do estabelecimento destinada a comercialização',
  '653': 'Venda de combustível ou lubrificante adquirido ou recebido de terceiros destinado à industrialização subsequente',
  '654': 'Venda de combustível ou lubrificante adquirido ou recebido de terceiros destinado a comercialização',
  '655': 'Venda de combustível ou lubrificante adquirido ou recebido de terceiros destinado a consumidor ou usuário final',
  '656': 'Venda de combustível ou lubrificante adquirido ou recebido de terceiros para venda a não contribuinte',
  '701': 'Venda de produção do estabelecimento em operação com produto sujeito a regime de ICMS de partilha',
  '901': 'Remessa para industrialização por encomenda',
  '902': 'Retorno de mercadoria utilizada na industrialização por encomenda',
  '903': 'Retorno de mercadoria recebida para industrialização e não aplicada no referido processo',
  '904': 'Remessa para venda fora do estabelecimento',
  '905': 'Remessa para depósito fechado ou armazém geral',
  '906': 'Retorno de mercadoria depositada em depósito fechado ou armazém geral',
  '907': 'Retorno simbólico de mercadoria depositada em depósito fechado ou armazém geral',
  '908': 'Remessa de bem por conta de contrato de comodato',
  '909': 'Retorno de bem recebido por conta de contrato de comodato',
  '910': 'Remessa em bonificação, doação ou brinde',
  '911': 'Remessa de amostra grátis',
  '912': 'Remessa de mercadoria ou bem para demonstração',
  '913': 'Retorno de mercadoria ou bem recebido para demonstração',
  '914': 'Remessa de mercadoria ou bem para exposição ou feira',
  '915': 'Remessa de mercadoria ou bem para conserto ou reparo',
  '916': 'Retorno de mercadoria ou bem recebido para conserto ou reparo',
  '917': 'Remessa de mercadoria em consignação mercantil ou industrial',
  '918': 'Devolução de mercadoria recebida em consignação mercantil ou industrial',
  '919': 'Devolução simbólica de mercadoria vendida ou utilizada em processo industrial, recebida em consignação mercantil ou industrial',
  '920': 'Remessa de vasilhame ou sacaria',
  '921': 'Devolução de vasilhame ou sacaria',
  '922': 'Lançamento efetuado em decorrência de venda de vasilhame ou sacaria',
  '923': 'Remessa de mercadoria ou bem para armazenagem',
  '924': 'Retorno de mercadoria ou bem recebido para armazenagem',
  '925': 'Retorno de armazenagem de produto agropecuário',
  '926': 'Lançamento efetuado a título de reclassificação de mercadoria decorrente de formação de kit ou de sua desagregação',
  '927': 'Lançamento efetuado a título de baixa de estoque decorrente de perda, roubo ou deterioração',
  '928': 'Lançamento efetuado a título de baixa de estoque decorrente do encerramento da atividade da empresa',
  '929': 'Lançamento efetuado a título de baixa de estoque decorrente de doação',
  '931': 'Lançamento efetuado pelo tomador do serviço de transporte para complementar o ICMS retido, correspondente à diferença entre o preço praticado pelo transportador e o valor da base de cálculo da retenção',
  '932': 'Prestação de serviço de transporte iniciada em unidade federada diversa daquela onde o contribuinte está inscrito',
  '933': 'Prestação de serviço tributado pelo ISSQN',
  '934': 'Remessa simbólica de mercadoria depositada em armazém geral ou depósito fechado',
  '949': 'Outra saída de mercadoria ou prestação de serviço não especificado',
};

function descricaoCfop(cfop: string): string {
  const suffix = cfop.slice(-3);
  return CFOP_DESCRICOES[suffix] || `CFOP ${cfop} - Não classificado`;
}

// Situação Tributária do ICMS — CST (Regime Normal, CRT 2/3; Ajuste SINIEF
// 07/2005 Anexo Código de Situação Tributária) e CSOSN (Simples Nacional,
// CRT 1/4; Ajuste SINIEF 11/2019 Anexo III-A). `esperaVicms` reflete o
// próprio layout oficial da NF-e 4.00: 'nao' = o grupo XML daquele código
// (ICMS40/ICMS60/ICMSSN102/...) NEM TEM campo <vICMS> — isenta, suspensa,
// ST já recolhida antes, ou Simples sem destaque de imposto na nota; 'sim'
// = o grupo tem <vICMS> e normalmente vem calculado (vBC × pICMS); 'opcional'
// = o grupo permite <vICMS> mas pode legitimamente vir zerado ou ausente
// (diferimento parcial, "outras" mais flexível).
type CstIcmsInfo = { descricao: string; esperaVicms: 'sim' | 'nao' | 'opcional' };
const CST_ICMS_DESCRICOES: Record<string, CstIcmsInfo> = {
  // CST — Regime Normal
  '00': { descricao: 'Tributada integralmente', esperaVicms: 'sim' },
  '10': { descricao: 'Tributada com cobrança de ICMS por Substituição Tributária', esperaVicms: 'sim' },
  '20': { descricao: 'Com redução de base de cálculo', esperaVicms: 'sim' },
  '30': { descricao: 'Isenta ou não tributada, com cobrança de ICMS por Substituição Tributária', esperaVicms: 'nao' },
  '40': { descricao: 'Isenta', esperaVicms: 'nao' },
  '41': { descricao: 'Não tributada', esperaVicms: 'nao' },
  '50': { descricao: 'Suspensão', esperaVicms: 'nao' },
  '51': { descricao: 'Diferimento', esperaVicms: 'opcional' },
  '60': { descricao: 'ICMS cobrado anteriormente por Substituição Tributária', esperaVicms: 'nao' },
  '70': { descricao: 'Com redução de base de cálculo e cobrança de ICMS por Substituição Tributária', esperaVicms: 'sim' },
  '90': { descricao: 'Outras', esperaVicms: 'opcional' },
  // CSOSN — Simples Nacional
  '101': { descricao: 'Tributada pelo Simples Nacional com permissão de crédito', esperaVicms: 'nao' },
  '102': { descricao: 'Tributada pelo Simples Nacional sem permissão de crédito', esperaVicms: 'nao' },
  '103': { descricao: 'Isenção do ICMS no Simples Nacional para faixa de receita bruta', esperaVicms: 'nao' },
  '201': { descricao: 'Tributada pelo Simples Nacional com permissão de crédito e com cobrança de ICMS por ST', esperaVicms: 'nao' },
  '202': { descricao: 'Tributada pelo Simples Nacional sem permissão de crédito e com cobrança de ICMS por ST', esperaVicms: 'nao' },
  '203': { descricao: 'Isenção do ICMS no Simples Nacional para faixa de receita bruta e com cobrança de ICMS por ST', esperaVicms: 'nao' },
  '300': { descricao: 'Imune', esperaVicms: 'nao' },
  '400': { descricao: 'Não tributada pelo Simples Nacional', esperaVicms: 'nao' },
  '500': { descricao: 'ICMS cobrado anteriormente por Substituição Tributária ou por antecipação', esperaVicms: 'nao' },
  '900': { descricao: 'Outros', esperaVicms: 'opcional' },
};

// Usa o texto oficial do CFOP_DESCRICOES pra separar "produção do
// estabelecimento" de "mercadoria adquirida ou recebida de terceiros" — não
// é uma lista própria de sufixos, é literalmente a descrição oficial que já
// existe no dicionário acima, então cobre toda a família 101/102, 401/403/
// 405 etc. sem precisar listar sufixo por sufixo.
function classificarOrigemCfop(cfop: string): 'propria' | 'revenda' | null {
  if (!cfop) return null;
  const desc = CFOP_DESCRICOES[cfop.slice(-3)];
  if (!desc) return null;
  if (desc.includes('produção do estabelecimento')) return 'propria';
  if (desc.includes('adquirida ou recebida de terceiros')) return 'revenda';
  return null;
}

// Ortogonal a própria/revenda — um item pode ser produção própria SUJEITA a
// ST, ou revenda sujeita a ST. Também vem do texto oficial do CFOP, não de
// uma lista de sufixos própria.
function cfopSujeitoAST(cfop: string): boolean {
  if (!cfop) return false;
  const desc = CFOP_DESCRICOES[cfop.slice(-3)];
  return !!desc && desc.includes('substituição tributária');
}

// "24944" e "0000000024944" são o MESMO código, só com zero à esquerda vindo
// de sistemas diferentes — sem normalizar isso, qualquer comparação entre
// cProd de notas diferentes vira falso positivo em massa.
function normalizarCprod(cProd: string): string {
  if (/^\d+$/.test(cProd)) return cProd.replace(/^0+/, '') || '0';
  return cProd;
}

// Chave de agrupamento por nome — trim+maiúsculas, pra "Pao Frances" e "PAO
// FRANCES " (espaço sobrando, ou caixa diferente entre sistemas) caírem na
// mesma linha do ranking.
function normalizarNomeProduto(xProd: string): string {
  return xProd.trim().toUpperCase();
}

// Devolução de venda tem CFOP próprio (1201/1202/1410/1411/1918/1919 e os
// equivalentes interestaduais 2201/2202/2410/2411/2918/2919) — NÃO dá pra
// usar CFOP_DESCRICOES por sufixo aqui, porque o mesmo sufixo (ex: "201")
// tem texto diferente do lado de entrada ("devolução de venda") e do lado
// de saída ("devolução de compra"); por isso essa é uma lista fechada dos
// códigos reais de devolução de venda, não um texto genérico.
const CFOPS_DEVOLUCAO_VENDA = new Set([
  '1201', '1202', '1203', '1204', '1410', '1411', '1918', '1919',
  '2201', '2202', '2203', '2204', '2410', '2411', '2918', '2919',
]);
function isCfopDevolucaoVenda(cfop: string): boolean {
  return CFOPS_DEVOLUCAO_VENDA.has(cfop);
}

function deduplicateXmls(list: XmlData[]): XmlData[] {
  const seen = new Map<string, XmlData>();
  const result: XmlData[] = [];
  list.forEach(xml => {
    // Include tipo in the key so an 'evento' and an 'nfe' with the same chave are NOT considered duplicates
    const baseKey = xml.chave || `${xml.cnpj || ''}_${xml.modelo || ''}_${xml.serie || ''}_${xml.numero || ''}`;
    const key = `${xml.tipo}::${baseKey}`;
    const existing = seen.get(key);
    if (existing) {
      // Um cliente pode mandar, além do XML original autorizado, uma resposta
      // de cancelamento malformada (mesma chave, mesmo tipo 'nfe', mas com
      // cStat/xMotivo de cancelamento em vez de um evento separado — visto na
      // prática). Se a duplicata descartada indicar cancelamento e a que
      // ficou não, o sinal não pode se perder: é a mesma nota fiscal.
      if (xml.isCancelamento && !existing.isCancelamento) existing.isCancelamento = true;
      return;
    }
    seen.set(key, xml);
    result.push(xml);
  });
  return result;
}

function deduplicateInutilizacoes(list: XmlData[]): XmlData[] {
  const seen = new Set<string>();
  return list.filter(inut => {
    const key = `${inut.cnpj || ''}_${inut.modelo || ''}_${inut.serie || ''}_${inut.nNFIni || 0}_${inut.nNFFin || 0}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateOthers(list: XmlData[]): XmlData[] {
  const seen = new Set<string>();
  return list.filter(item => {
    const key = `${item.tipo}_${item.subTipo || ''}_${item.fileName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// --- Components ---

interface SpedValidationPanelProps {
  spedData: SpedData;
  crossRef: {
    spedSaidasTotal: number;
    spedEntradasTotal: number;
    saidaOk: number;
    saidaFaltantes: SpedC100[];
    formatDt: (d: string) => string;
    periodo: string;
  };
  onClose: () => void;
}

function SpedValidationPanel({ spedData, crossRef, onClose }: SpedValidationPanelProps) {
  const [expandido, setExpandido] = useState(false);
  const { spedSaidasTotal, saidaOk, saidaFaltantes, periodo } = crossRef;
  const temFaltantes = saidaFaltantes.length > 0;

  // Aceita letras nos 12 primeiros caracteres — CNPJ alfanumérico (NT 2026.004);
  // os 2 dígitos verificadores finais continuam sempre numéricos.
  const formatCnpj = (c: string) =>
    c.replace(/^([0-9A-Za-z]{2})([0-9A-Za-z]{3})([0-9A-Za-z]{3})([0-9A-Za-z]{4})(\d{2})$/, '$1.$2.$3/$4-$5');

  const formatValor = (v: string) => {
    const n = parseFloat(v.replace(',', '.'));
    if (isNaN(n)) return v;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const formatDtDoc = (d: string) =>
    d.length === 8 ? `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4)}` : d;

  return (
    <div className="mx-6 mb-0 mt-0 border-t border-slate-100/50 pt-4 pb-3">
      <div className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        temFaltantes
          ? 'bg-amber-50 border-amber-200'
          : 'bg-emerald-50 border-emerald-200'
      )}>
        {/* Header */}
        <div className="flex items-start gap-3">
          <svg className={cn('w-4 h-4 mt-0.5 shrink-0', temFaltantes ? 'text-amber-500' : 'text-emerald-500')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={temFaltantes
              ? 'M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'
              : 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
            } />
          </svg>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn('font-bold', temFaltantes ? 'text-amber-800' : 'text-emerald-800')}>
                SPED Fiscal detectado
              </span>
              <span className="text-[10px] font-mono bg-white/70 border border-slate-200 px-1.5 py-0.5 rounded text-slate-500">
                {spedData.fileName}
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {formatCnpj(spedData.cnpj)} · {spedData.razaoSocial} · {periodo}
            </div>
          </div>
          <button onClick={onClose} className="ml-auto shrink-0 text-slate-400 hover:text-slate-600" title="Fechar">✕</button>
        </div>

        {/* Stats row */}
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-white/70 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs">
            <span className="text-slate-500">No SPED</span>
            <span className="font-bold text-slate-700">{spedSaidasTotal} saídas</span>
          </div>
          <div className="flex items-center gap-1.5 bg-white/70 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-slate-500">Com XML</span>
            <span className="font-bold text-emerald-700">{saidaOk}</span>
          </div>
          <div className={cn(
            'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs border',
            temFaltantes ? 'bg-amber-100 border-amber-300' : 'bg-white/70 border-slate-200'
          )}>
            <span className={cn('w-2 h-2 rounded-full shrink-0', temFaltantes ? 'bg-amber-500' : 'bg-slate-300')} />
            <span className={temFaltantes ? 'text-amber-800' : 'text-slate-500'}>Sem XML</span>
            <span className={cn('font-bold', temFaltantes ? 'text-amber-800' : 'text-slate-400')}>{saidaFaltantes.length}</span>
          </div>
        </div>

        {/* Faltantes expandable list */}
        {temFaltantes && (
          <div className="mt-3">
            <button
              onClick={() => setExpandido(v => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-900 transition-colors"
            >
              <svg className={cn('w-3.5 h-3.5 transition-transform', expandido && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {expandido ? 'Ocultar' : 'Ver'} {saidaFaltantes.length} nota{saidaFaltantes.length !== 1 ? 's' : ''} no SPED sem XML
            </button>
            {expandido && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-amber-200 bg-white custom-scrollbar">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-amber-50 border-b border-amber-200">
                    <tr>
                      <th className="text-left px-3 py-2 text-amber-700 font-semibold">Data</th>
                      <th className="text-left px-3 py-2 text-amber-700 font-semibold">Mod</th>
                      <th className="text-left px-3 py-2 text-amber-700 font-semibold">Série</th>
                      <th className="text-left px-3 py-2 text-amber-700 font-semibold">Número</th>
                      <th className="text-right px-3 py-2 text-amber-700 font-semibold">Valor</th>
                      <th className="text-left px-3 py-2 text-amber-700 font-semibold">Chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saidaFaltantes.map((c, i) => (
                      <tr key={i} className="border-b border-slate-100 hover:bg-amber-50/50">
                        <td className="px-3 py-1.5 text-slate-600">{formatDtDoc(c.dtDoc)}</td>
                        <td className="px-3 py-1.5 text-slate-500">{c.codMod}</td>
                        <td className="px-3 py-1.5 text-slate-500">{c.ser}</td>
                        <td className="px-3 py-1.5 font-mono text-slate-700">{c.numDoc}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-slate-700">{formatValor(c.vlDoc)}</td>
                        <td className="px-3 py-1.5 font-mono text-slate-400 text-[10px] truncate max-w-[180px]" title={c.chave}>{c.chave || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!temFaltantes && (
          <p className="mt-2 text-xs text-emerald-700">
            Todas as {spedSaidasTotal} saídas declaradas no SPED têm XML carregado. Nenhum faltante.
          </p>
        )}
      </div>
    </div>
  );
}

// Easter egg — jogo simples pra passar o tempo enquanto o processamento
// roda em segundo plano (não interfere nele, é só decorativo). Clique/
// espaço pra pular as inutilizações (retângulos escuros) que vêm voando;
// pontuação sobe com a distância. Canvas puro, sem dependências novas.
function EasterEggGame({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const stateRef = useRef({
    playerY: 150,
    velocity: 0,
    jumping: false,
    obstacles: [] as { x: number; w: number; h: number }[],
    speed: 4,
    frame: 0,
    dist: 0,
    over: false,
  });

  const jumpOrRestart = () => {
    const s = stateRef.current;
    if (s.over) {
      s.playerY = 150; s.velocity = 0; s.jumping = false; s.obstacles = [];
      s.speed = 4; s.frame = 0; s.dist = 0; s.over = false;
      setGameOver(false);
      setScore(0);
      return;
    }
    if (!s.jumping) {
      s.jumping = true;
      s.velocity = -9.5;
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const GROUND_Y = 150;
    const PLAYER_X = 36;
    const PLAYER_SIZE = 22;
    let raf = 0;

    const loop = () => {
      const s = stateRef.current;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // fundo
      ctx.fillStyle = '#FCFBF8';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#E5E0D6';
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + PLAYER_SIZE);
      ctx.lineTo(W, GROUND_Y + PLAYER_SIZE);
      ctx.stroke();

      if (!s.over) {
        s.frame++;
        s.dist++;
        if (s.frame % 90 === 0) s.speed = Math.min(s.speed + 0.4, 11);

        // física do pulo
        s.velocity += 0.55;
        s.playerY += s.velocity;
        if (s.playerY > GROUND_Y) { s.playerY = GROUND_Y; s.velocity = 0; s.jumping = false; }

        // spawn de obstáculo
        if (s.frame % Math.max(45, Math.floor(90 - s.speed * 4)) === 0) {
          s.obstacles.push({ x: W, w: 16 + Math.random() * 10, h: 20 + Math.random() * 16 });
        }
        s.obstacles.forEach(o => { o.x -= s.speed; });
        s.obstacles = s.obstacles.filter(o => o.x + o.w > 0);

        // colisão (AABB simples)
        for (const o of s.obstacles) {
          const px1 = PLAYER_X, px2 = PLAYER_X + PLAYER_SIZE;
          const py1 = s.playerY, py2 = s.playerY + PLAYER_SIZE;
          const ox1 = o.x, ox2 = o.x + o.w;
          const oy1 = GROUND_Y + PLAYER_SIZE - o.h, oy2 = GROUND_Y + PLAYER_SIZE;
          if (px2 > ox1 && px1 < ox2 && py2 > oy1 && py1 < oy2) {
            s.over = true;
            setGameOver(true);
            setBest(b => Math.max(b, Math.floor(s.dist / 8)));
          }
        }
        setScore(Math.floor(s.dist / 8));
      }

      // jogador (trigo dourado)
      ctx.fillStyle = '#C9A227';
      ctx.beginPath();
      ctx.roundRect(PLAYER_X, s.playerY, PLAYER_SIZE, PLAYER_SIZE, 6);
      ctx.fill();

      // obstáculos
      ctx.fillStyle = '#423C2C';
      s.obstacles.forEach(o => {
        ctx.beginPath();
        ctx.roundRect(o.x, GROUND_Y + PLAYER_SIZE - o.h, o.w, o.h, 3);
        ctx.fill();
      });

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); jumpOrRestart(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[200] backdrop-blur-sm flex flex-col items-center justify-center p-6"
      style={{background: 'rgba(23,21,15,0.85)'}}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#FCFBF8] rounded-2xl p-5 shadow-2xl" style={{width: 'min(92vw, 420px)'}}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-serif font-semibold text-[#17150F]">Pulando as Inutilizações</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors" title="Fechar">
            <X className="w-5 h-5" />
          </button>
        </div>
        <canvas
          ref={canvasRef}
          width={370}
          height={176}
          onClick={jumpOrRestart}
          className="w-full rounded-lg border border-[#E5E0D6] cursor-pointer touch-none"
        />
        <div className="flex items-center justify-between mt-3 text-sm">
          <span className="text-slate-500">Espaço, ↑ ou clique pra pular</span>
          <span className="font-bold text-[#9A7B12]">Pontos: {score} · Recorde: {best}</span>
        </div>
        {gameOver && (
          <div className="mt-3 text-center">
            <p className="text-sm text-slate-600 mb-2">Bateu numa inutilização! Clique no jogo pra tentar de novo.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('sequencia-fiscal-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('sequencia-fiscal-theme', theme);
  }, [theme]);

  const [xmlList, setXmlList] = useState<XmlData[]>([]);
  const [inutilizacoes, setInutilizacoes] = useState<XmlData[]>([]);
  const [otherXmlsList, setOtherXmlsList] = useState<XmlData[]>([]);
  // NFS-e (Nota Fiscal de Serviços Eletrônica) — schema totalmente diferente
  // da família NF-e, guardada à parte; só aparece um card se algo for encontrado.
  const [nfseList, setNfseList] = useState<XmlData[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalFiles: 0,
    totalXmls: 0,
    validNf: 0,
    inutilizations: 0,
    cancellations: 0,
    nonXmlCount: 0
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [analysis, setAnalysis] = useState<SerieAnalysis[] | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [expandedNfseIdx, setExpandedNfseIdx] = useState<number | null>(null);
  const [manualInutModelo, setManualInutModelo] = useState('65');
  const [manualInutSerie, setManualInutSerie] = useState('');
  const [manualInutIni, setManualInutIni] = useState('');
  const [manualInutFim, setManualInutFim] = useState('');
  const [manualInutData, setManualInutData] = useState('');
  const [portalConsultado, setPortalConsultado] = useState(false);
  const [forcarPainelInutilizacao, setForcarPainelInutilizacao] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedHeaderField, setCopiedHeaderField] = useState<string | null>(null);
  const [showEasterEgg, setShowEasterEgg] = useState(false);

  const copiarCampoHeader = (campo: string, valor: string) => {
    navigator.clipboard.writeText(valor);
    setCopiedHeaderField(campo);
    setTimeout(() => setCopiedHeaderField(null), 1500);
  };

  // Consulta pontual e opcional (clique do usuário, nunca automática) na
  // BrasilAPI — espelha os dados públicos do CNPJ na Receita Federal (situação
  // cadastral, opção pelo Simples/MEI). Serve só de contraste com o CRT
  // declarado nos XMLs; não altera nenhum cálculo da auditoria.
  interface ReceitaConsultaResultado {
    situacao: string;
    opcaoSimples: boolean;
    opcaoMei: boolean;
    razaoSocial: string;
    dataConsulta: string;
  }
  const [receitaConsulta, setReceitaConsulta] = useState<ReceitaConsultaResultado | null>(null);
  const [receitaConsultaStatus, setReceitaConsultaStatus] = useState<'idle' | 'loading' | 'erro'>('idle');

  const consultarSituacaoReceita = async (cnpj: string) => {
    setReceitaConsultaStatus('loading');
    setReceitaConsulta(null);
    try {
      // Timeout defensivo: se a BrasilAPI cair/ficar pendurada, essa consulta
      // (isolada, sob demanda) falha sozinha em 10s sem travar mais nada no
      // app — nenhum outro cálculo/auditoria depende desse resultado.
      const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setReceitaConsulta({
        situacao: data.descricao_situacao_cadastral || 'Desconhecida',
        opcaoSimples: !!data.opcao_pelo_simples,
        opcaoMei: !!data.opcao_pelo_mei,
        razaoSocial: data.razao_social || '',
        dataConsulta: new Date().toLocaleString('pt-BR')
      });
      setReceitaConsultaStatus('idle');
    } catch (err) {
      console.error('Erro ao consultar CNPJ na Receita (BrasilAPI):', err);
      setReceitaConsultaStatus('erro');
    }
  };

  // Mesma BrasilAPI de cima, mas por cliente do Perfil de Clientes — dispara só
  // quando o analista expande a linha daquele cliente específico (nunca em
  // lote/automático pra não estourar limite da API com dezenas de clientes de
  // uma vez), e guarda o resultado num cache pra não reconsultar ao
  // expandir/recolher a mesma linha de novo.
  const buscarDadosCnpj = async (cnpj: string, timeoutMs = 10000): Promise<PerfilClienteReceitaDados> => {
    const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return {
      situacao: data.descricao_situacao_cadastral || 'Desconhecida',
      // null da API = "não informado pela Receita", diferente de "não
      // optante" — mantido como null pra não afirmar algo que a fonte
      // não confirmou.
      opcaoSimples: data.opcao_pelo_simples === null || data.opcao_pelo_simples === undefined ? null : !!data.opcao_pelo_simples,
      opcaoMei: data.opcao_pelo_mei === null || data.opcao_pelo_mei === undefined ? null : !!data.opcao_pelo_mei,
      porte: data.porte || '',
      cnaeDescricao: data.cnae_fiscal_descricao || '',
      naturezaJuridica: data.natureza_juridica || '',
      dataInicioAtividade: data.data_inicio_atividade || '',
      municipio: data.municipio || '',
      uf: data.uf || '',
    };
  };

  const consultarCnpjCliente = async (cnpj: string) => {
    setConsultaClientesCnpj(prev => ({ ...prev, [cnpj]: { status: 'loading' } }));
    try {
      const dados = await buscarDadosCnpj(cnpj);
      setConsultaClientesCnpj(prev => ({ ...prev, [cnpj]: { status: 'ok', dados } }));
    } catch (err) {
      console.error('Erro ao consultar CNPJ de cliente (BrasilAPI):', err);
      setConsultaClientesCnpj(prev => ({ ...prev, [cnpj]: { status: 'erro' } }));
    }
  };

  const [copiedResumoTEF, setCopiedResumoTEF] = useState(false);

  // Monta um resumo em texto do card de Auditoria de Pagamento (TEF) pra
  // copiar e enviar direto pro cliente — empresa, período, formas de
  // pagamento e os percentuais de TEF/POS que hoje só existem visualmente.
  const copiarResumoTEF = () => {
    const empresa = analysis?.[0]?.razaoSocial || '';
    const cnpj = analysis?.[0]?.cnpj || '';
    const ie = analysis?.[0]?.ie || '';
    const periodo = filterMes !== 'Todos' ? filterMes : mesesDisponiveis.join(', ');
    // Sem Math.round aqui de propósito: 464/466 = 99,57% arredondava pra "100%",
    // escondendo os 2 POS manual que sobraram — mesmo bug já corrigido no card
    // de IBS/CBS (commit c653066). formatarPct só mostra casa decimal quando
    // o número não é inteiro de verdade, então 100% genuíno continua "100%".
    const pctIntegrado = auditoriaPagamento.totalCartao > 0
      ? (auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100
      : 0;
    const pctNaoIntegrado = auditoriaPagamento.totalCartao > 0
      ? (auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100
      : 0;
    const pctFalsoTef = auditoriaPagamento.totalCartao > 0
      ? (auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100
      : 0;

    let texto = `RESUMO — AUDITORIA DE PAGAMENTO (TEF)\n`;
    texto += `Empresa: ${empresa}\n`;
    texto += `CNPJ: ${cnpj}\n`;
    texto += `IE: ${ie}\n`;
    if (regimeTributario.label) texto += `Regime: ${regimeTributario.label}\n`;
    texto += `Período: ${periodo}\n\n`;

    texto += `Vendas em cartão sujeitas a TEF: ${auditoriaPagamento.totalCartao}\n`;
    texto += `  • Integradas (TEF de verdade, com autorização): ${auditoriaPagamento.totalIntegrado} (${formatarPct(pctIntegrado)}%)\n`;
    texto += `  • POS manual (sem TEF): ${auditoriaPagamento.totalNaoIntegrado} (${formatarPct(pctNaoIntegrado)}%)\n`;
    if (auditoriaPagamento.notasNaoIntegradas.length > 0) {
      const porFormaPosManual: Record<string, number> = {};
      auditoriaPagamento.notasNaoIntegradas.forEach(n => {
        porFormaPosManual[n.tPagNome] = (porFormaPosManual[n.tPagNome] || 0) + 1;
      });
      Object.entries(porFormaPosManual).forEach(([forma, qtd]) => {
        texto += `      - ${forma}: ${qtd} venda${qtd !== 1 ? 's' : ''} sem TEF\n`;
      });
      // Aqui é contagem de VENDAS (uma por forma usada), enquanto o número de
      // POS manual acima é contagem de PAGAMENTOS — evita a dúvida de "por que
      // a soma da lista não bate com o total lá em cima".
      if (auditoriaPagamento.notasNaoIntegradas.length !== auditoriaPagamento.totalNaoIntegrado) {
        texto += `      (contagem por venda; o total de ${auditoriaPagamento.totalNaoIntegrado} acima é por pagamento — pode diferir se alguma venda teve mais de um pagamento manual na mesma forma)\n`;
      }
    }
    if (auditoriaPagamento.totalFalsoTef > 0) {
      texto += `  • ⚠ Falso TEF (declara integração mas sem autorização): ${auditoriaPagamento.totalFalsoTef} (${formatarPct(pctFalsoTef)}%)\n`;
    }
    if (auditoriaPagamento.totalCartaoNaoAplicavel > 0) {
      texto += `  • Fora do escopo de TEF (não presencial/interestadual): ${auditoriaPagamento.totalCartaoNaoAplicavel}\n`;
    }

    if (auditoriaPagamento.breakdownPorTipoPagamento.length > 0) {
      texto += `\nPor forma de pagamento:\n`;
      auditoriaPagamento.breakdownPorTipoPagamento.forEach(b => {
        texto += `  • ${b.tPagNome}: ${formatarMoeda(b.valor)} (${b.qtd} pagamento${b.qtd !== 1 ? 's' : ''})\n`;
      });
    }

    if (auditoriaPagamento.problemas.length > 0) {
      texto += `\n⚠ ${auditoriaPagamento.problemas.length} problema(s) técnico(s) identificado(s):\n`;
      auditoriaPagamento.problemas.forEach(p => {
        const data = p.xml.data ? new Date(p.xml.data).toLocaleDateString('pt-BR') : '—';
        texto += `  • Série ${p.xml.serie}, Nº ${p.xml.numero} (${data}): ${p.motivo}\n`;
      });

      const problemasTroco = auditoriaPagamento.problemas.filter(p => p.motivo.startsWith('Troco de'));
      if (problemasTroco.length > 0) {
        texto += `\nSobre o(s) troco(s) sem pagamento em Dinheiro correspondente: cartão de crédito/débito e PIX não geram troco — só pagamento em espécie pode. Quando isso aparece, geralmente é por cobrança duplicada no cartão (valor cobrado maior que o da nota) sem o estorno correto ter sido feito, com o sistema jogando a diferença como "troco" em vez de estornar, ou por bug/erro de lançamento no PDV ao registrar a forma de pagamento — não deveria acontecer.`;
      }
    }

    navigator.clipboard.writeText(texto.trim());
    setCopiedResumoTEF(true);
    setTimeout(() => setCopiedResumoTEF(false), 1500);
  };

  const ThemeToggle = () => (
    <button
      onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-white text-sm font-bold transition-all no-print shrink-0"
      style={{background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(201,162,39,0.35)'}}
      title={theme === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro'}
    >
      {theme === 'dark' ? <Sun className="w-4 h-4" style={{color: '#C9A227'}} /> : <Moon className="w-4 h-4" style={{color: '#C9A227'}} />}
      {theme === 'dark' ? 'Claro' : 'Escuro'}
    </button>
  );
  const [analystName, setAnalystName] = useState('');
  const [attachedSources, setAttachedSources] = useState<SourceMetadata[]>([]);
  const [processedFileNames, setProcessedFileNames] = useState<Set<string>>(new Set());
  const [entradaCount, setEntradaCount] = useState(0);
  const [fornecedorEntradaInfo, setFornecedorEntradaInfo] = useState<{ count: number; nomes: string } | null>(null);
  // Um SPED por competência (mês/ano), não um único SPED global — permite
  // anexar o SPED de julho e o de agosto juntos e cada um valer só pro seu mês.
  const [spedEntries, setSpedEntries] = useState<SpedEntries>({});
  const [spedCardFiltro, setSpedCardFiltro] = useState<'Todas' | 'SemXML' | 'Canceladas' | 'NaoDeclarado' | 'Adicionados'>('Todas');
  const [spedCardOpen, setSpedCardOpen] = useState(false);
  const [spedSearch, setSpedSearch] = useState('');
  const spedInputRef = useRef<HTMLInputElement>(null);

  // Editable messages state
  const [consolidatedMessage, setConsolidatedMessage] = useState('');

  // Filters
  const [filterModelo, setFilterModelo] = useState('Todos');
  const [filterMes, setFilterMes] = useState('Todos');
  // Easter egg: Mapa Fiscal só existe pra quem sabe que existe — clicar na
  // logomarca do cabeçalho libera (e esconde de novo, é um toggle). Fica
  // falso por padrão e volta a falso em toda "Nova Análise" de propósito,
  // pra ninguém que pegar o navegador depois já achar destravado.
  const [mapaFiscalDesbloqueado, setMapaFiscalDesbloqueado] = useState(false);
  const [showMapaFiscal, setShowMapaFiscal] = useState(false);
  const [showComparativoMensal, setShowComparativoMensal] = useState(false);
  const [showComparativoSerie, setShowComparativoSerie] = useState(false);
  const [showRankingProdutos, setShowRankingProdutos] = useState(false);
  const [filtroOrigemRanking, setFiltroOrigemRanking] = useState<'todos' | 'propria' | 'revenda' | 'misto'>('todos');
  // Agrupar por cProd (padrão, granular — mostra cadastro divergente como
  // linhas separadas) ou por nome do produto (junta cProd diferente com o
  // mesmo nome — útil quando o cliente recadastrou o produto no meio do
  // período e o analista só quer o total por produto, não por código).
  const [agruparRankingPorNome, setAgruparRankingPorNome] = useState(false);
  const [showRankingNcm, setShowRankingNcm] = useState(false);
  const [showSazonalidade, setShowSazonalidade] = useState(false);
  // Todos os modelos (padrão) ou só NFC-e — NF-e (mod 55) costuma ser
  // atacado/B2B e não reflete o movimento real do caixa/PDV; pra decisão de
  // escala de equipe às vezes só importa o varejo de balcão.
  const [sazonalidadeSomenteNfce, setSazonalidadeSomenteNfce] = useState(false);
  // Dia da semana selecionado pra ver o horário de pico SÓ daquele dia (ex:
  // "nas sextas, em que horário concentra?") — null = agregado de todos os
  // dias, como já era antes.
  const [sazonalidadeDiaSelecionado, setSazonalidadeDiaSelecionado] = useState<number | null>(null);
  const [showDevolucoes, setShowDevolucoes] = useState(false);
  const [showDaysDetail, setShowDaysDetail] = useState(false);
  const [notasPorDiaModoResumido, setNotasPorDiaModoResumido] = useState(false);
  const [showCfopBreakdown, setShowCfopBreakdown] = useState(false);
  const [showCfopPorModelo, setShowCfopPorModelo] = useState(false);
  const [showAnomalias, setShowAnomalias] = useState(false);
  const [showSemAutorizacao, setShowSemAutorizacao] = useState(false);
  const [showMalformadas, setShowMalformadas] = useState(false);
  const [showAuditoriaPagamento, setShowAuditoriaPagamento] = useState(false);
  const [showAuditoriaRegime, setShowAuditoriaRegime] = useState(false);
  const [showAuditoriaIbsCbs, setShowAuditoriaIbsCbs] = useState(false);
  const [showMudancasCadastro, setShowMudancasCadastro] = useState(false);
  const [showNfse, setShowNfse] = useState(false);
  const [nfseBusca, setNfseBusca] = useState('');
  const [showPerfilClientes, setShowPerfilClientes] = useState(false);
  const [perfilClientesBusca, setPerfilClientesBusca] = useState('');
  // CNPJ do cliente com o detalhe (produtos + tendência mensal) expandido —
  // null = nenhum, só a lista resumida.
  const [perfilClienteExpandido, setPerfilClienteExpandido] = useState<string | null>(null);
  const [showPerfilFornecedores, setShowPerfilFornecedores] = useState(false);
  const [perfilFornecedoresBusca, setPerfilFornecedoresBusca] = useState('');
  const [perfilFornecedorExpandido, setPerfilFornecedorExpandido] = useState<string | null>(null);
  // Cache de consulta CNPJ por cliente (Fase 2 do Perfil de Clientes) — chave é
  // o CNPJ, guarda um resultado por cliente já consultado nesta sessão, pra
  // não reconsultar toda vez que a linha é expandida/recolhida de novo.
  interface PerfilClienteReceitaDados {
    situacao: string; opcaoSimples: boolean | null; opcaoMei: boolean | null;
    porte: string; cnaeDescricao: string; naturezaJuridica: string;
    dataInicioAtividade: string; municipio: string; uf: string;
  }
  const [consultaClientesCnpj, setConsultaClientesCnpj] = useState<Record<string, { status: 'loading' | 'ok' | 'erro'; dados?: PerfilClienteReceitaDados }>>({});
  const [auditoriaRegimeBusca, setAuditoriaRegimeBusca] = useState('');
  const [auditoriaPagamentoBusca, setAuditoriaPagamentoBusca] = useState('');
  const [showForaDoEscopoDetalhe, setShowForaDoEscopoDetalhe] = useState(false);
  const [showForaDoPrazo, setShowForaDoPrazo] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [tipoRelatorioPDF, setTipoRelatorioPDF] = useState<'resumido' | 'completo'>('resumido');
  const [exportProgress, setExportProgress] = useState<{ atual: number; total: number; etapa: string; titulo?: string } | null>(null);
  // Janela que só aparece ao gerar o Perfil do Cliente quando a empresa é do Simples: o app não consegue
  // ver se ela optou pelo regime regular de IBS/CBS (híbrido), então o contador responde aqui e o HTML já sai fechado.
  const [confirmaSimples, setConfirmaSimples] = useState<{ crtTxt: string; receitaTxt: string; diverge: boolean } | null>(null);
  const [modoSimplesEscolhido, setModoSimplesEscolhido] = useState<'duvida' | 'puro' | 'hibrido'>('duvida');
  const [showExportXmlMenu, setShowExportXmlMenu] = useState(false);
  const [exportPartes, setExportPartes] = useState(1);
  const [notaSearchQuery, setNotaSearchQuery] = useState('');
  const [notaSearchCampo, setNotaSearchCampo] = useState<'Numero' | 'Chave' | 'Cliente' | 'Item' | 'Ncm' | 'Data' | 'Valor'>('Numero');
  const [filterNotaModelo, setFilterNotaModelo] = useState('Todos');
  const [filterNotaSituacao, setFilterNotaSituacao] = useState('Todas');
  const [filterNotaCfop, setFilterNotaCfop] = useState('Todos');
  const [downloadingDanfeChave, setDownloadingDanfeChave] = useState<string | null>(null);
  const [notasSelecionadas, setNotasSelecionadas] = useState<Set<string>>(new Set());
  const [showSelecionadas, setShowSelecionadas] = useState(false);
  const [baixandoLote, setBaixandoLote] = useState<{ tipo: 'danfe' | 'xml'; atual: number; total: number } | null>(null);
  const [copiedCnpjIdx, setCopiedCnpjIdx] = useState<number | null>(null);

  // Auditoria de XML (confronto com planilha detalhada do Questor)
  const auditoriaInputRef = useRef<HTMLInputElement>(null);
  const [auditoriaLoading, setAuditoriaLoading] = useState(false);
  const [auditoriaErro, setAuditoriaErro] = useState<string | null>(null);
  const [auditoriaResultado, setAuditoriaResultado] = useState<DiferencaAuditoria[] | null>(null);
  const [auditoriaNomeArquivo, setAuditoriaNomeArquivo] = useState('');
  const [auditoriaFiltroTipo, setAuditoriaFiltroTipo] = useState<'Todas' | TipoDiferencaAuditoria>('Todas');

  const formatarMoeda = (valor: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(valor);
  };

  // Mostra 1 casa decimal só quando não é um número redondo — evita que 443/444
  // (99,77%) apareça como "100%" na tela e esconda a nota que ainda falta.
  const formatarPct = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(1).replace('.', ','));

  // Nome de arquivo padrão pra qualquer export: tipo + empresa + período, sem
  // acento/espaço/caractere especial, pra identificar o arquivo sem precisar abrir.
  const sanitizarNomeArquivo = (v: string) =>
    v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  // `fileName` de uma nota guarda o CAMINHO INTEIRO de dentro do zip que o
  // cliente mandou (ex: "Arquivo XML de NFCE.../XML nfce aprovadas/NFCe-...xml")
  // — útil pra saber a origem, péssimo como nome de arquivo pra baixar de volta:
  // reusar isso direto recriava a mesma estrutura de pastas aninhadas dentro
  // do zip exportado. Isso aqui pega só o nome do arquivo em si.
  const nomeBaseArquivo = (caminho: string) => caminho.split(/[\\/]/).pop() || caminho;

  // "Todos os Meses" só faz sentido quando o período carregado realmente tem mais de
  // um mês. Com 2+ meses, usa a faixa "PrimeiroMês_ÚltimoMês_Ano" (ex: Maio_Junho_2026),
  // já ordenado cronologicamente (mesesDisponiveis vem ordenado por texto, não por data).
  const periodoParaNomeArquivo = () => {
    if (filterMes !== 'Todos') return filterMes;
    if (mesesDisponiveis.length === 0) return 'Todos os Meses';
    if (mesesDisponiveis.length === 1) return mesesDisponiveis[0];

    const parsed = mesesDisponiveis
      .map(m => {
        const [nome, ano] = m.split('/');
        return { nome, ano, idx: MESES.indexOf(nome) };
      })
      .sort((a, b) => `${a.ano}${String(a.idx).padStart(2, '0')}`.localeCompare(`${b.ano}${String(b.idx).padStart(2, '0')}`));

    const primeiro = parsed[0];
    const ultimo = parsed[parsed.length - 1];
    return primeiro.ano === ultimo.ano
      ? `${primeiro.nome} ${ultimo.nome} ${primeiro.ano}`
      : `${primeiro.nome} ${primeiro.ano} ${ultimo.nome} ${ultimo.ano}`;
  };

  const nomeArquivoExport = (tipo: string, extensao: string) => {
    const empresaBruta = analysis?.[0]?.razaoSocial || notasSaida[0]?.razaoSocial || '';
    const partes = [tipo, sanitizarNomeArquivo(empresaBruta), sanitizarNomeArquivo(periodoParaNomeArquivo())].filter(Boolean);
    return `${partes.join('_')}.${extensao}`;
  };

  // SPED(s) ativos para o filtro de mês atual: com um mês específico selecionado,
  // é só o SPED daquele mês (se houver); com "Todos", combina os SPEDs de todas as
  // competências carregadas — permite ver os dois meses cruzados ao mesmo tempo.
  const activeSpedList = useMemo<SpedData[]>(() => {
    const keys = Object.keys(spedEntries);
    if (keys.length === 0) return [];
    if (filterMes !== 'Todos') {
      return spedEntries[filterMes] ? [spedEntries[filterMes].data] : [];
    }
    return keys.map(k => spedEntries[k].data);
  }, [spedEntries, filterMes]);

  // Representante pra exibição (razão social/CNPJ/nome de arquivo) — em modo
  // combinado ("Todos" com mais de um mês) o diff "adicionados" e o download do
  // SPED corrigido só valem pra um único SPED por vez, então ficam desabilitados
  // nesse caso (checar activeSpedList.length === 1 antes de usar spedData.rawText).
  const spedData = useMemo<SpedData | null>(
    () => activeSpedList.length > 0 ? activeSpedList[activeSpedList.length - 1] : null,
    [activeSpedList]
  );
  const spedDataOriginal = useMemo<SpedData | null>(() => {
    if (filterMes === 'Todos' || activeSpedList.length !== 1) return null;
    return spedEntries[filterMes]?.original ?? null;
  }, [spedEntries, filterMes, activeSpedList]);

  const spedCrossRef = useMemo(() => {
    if (activeSpedList.length === 0) return null;
    const xmlChaves = new Set(xmlList.filter(x => x.chave).map(x => x.chave!));
    const spedSaidas = activeSpedList.flatMap(s => s.c100.filter(c => c.indOper === '1'));
    const spedEntradasTotal = activeSpedList.reduce((n, s) => n + s.c100.filter(c => c.indOper === '0').length, 0);
    const comChave = spedSaidas.filter(c => c.chave);
    const saidaFaltantes = comChave.filter(c => !xmlChaves.has(c.chave));
    const saidaFaltantesSet = new Set(saidaFaltantes.map(c => c.chave));
    const saidaOk = comChave.length - saidaFaltantes.length;
    const formatDt = (d: string) => d.length === 8 ? `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4)}` : d;

    // Verificação reversa: XMLs de saída NF-e no período do SPED que não estão declarados
    // Chave NF-e: cUF(2) + AAMM(4) + CNPJ(14) + ... → posições 2-5 = AAMM (ex: "2606" = jun/26)
    const toAaMm = (ddmmaaaa: string) =>
      ddmmaaaa.length === 8 ? ddmmaaaa.slice(6, 8) + ddmmaaaa.slice(2, 4) : '';
    // Cada SPED ativo cobre seu próprio intervalo — trata como uma lista de faixas,
    // não uma única faixa contínua (min ini / max fin): senão um mês SEM SPED entre
    // dois meses que TÊM SPED cairia "dentro do período" por engano e seria cobrado
    // como se devesse estar declarado num SPED que não existe.
    const periodos = activeSpedList
      .map(s => ({ ini: toAaMm(s.dtIni), fin: toAaMm(s.dtFin) }))
      .filter(p => p.ini);
    const dentroDeAlgumPeriodo = (aaMm: string) => periodos.some(p => aaMm >= p.ini && aaMm <= p.fin);
    // Filtra apenas NF-e emitidas pela própria empresa (emitCnpj = CNPJ do SPED)
    // tpNF=1 sozinho não basta: XMLs de fornecedor também têm tpNF=1
    // Só remove pontuação (não \D inteiro) — o CNPJ alfanumérico (NT 2026.004)
    // usa letras nos 12 primeiros dígitos, e \D também apagaria essas letras.
    const cleanCnpj = (c: string) => c.replace(/[.\-/\s]/g, '');
    const companyCnpj = cleanCnpj(activeSpedList[0].cnpj);
    const xmlSaidasNfe = xmlList.filter(x =>
      x.chave && x.tipo === 'nfe' && cleanCnpj(x.emitCnpj ?? '') === companyCnpj
    );
    const xmlsForaPeriodo = periodos.length
      ? xmlSaidasNfe.filter(x => !dentroDeAlgumPeriodo(x.chave!.slice(2, 6)))
      : [];
    const xmlsNoPeriodo = periodos.length
      ? xmlSaidasNfe.filter(x => dentroDeAlgumPeriodo(x.chave!.slice(2, 6)))
      : xmlSaidasNfe;
    const spedChavesSet = new Set(comChave.map(c => c.chave));
    const xmlsNaoDeclarados = xmlsNoPeriodo.filter(x => !spedChavesSet.has(x.chave!) && !!x.protocolo);
    const nomesMeses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const mesesFora = [...new Set(xmlsForaPeriodo.map(x => {
      const s = x.chave!.slice(2, 6);
      const mm = parseInt(s.slice(2, 4));
      return `${nomesMeses[mm - 1]}/${s.slice(0, 2)}`;
    }))].sort();

    // Diff: registros que estão no SPED atual mas não estavam no original (adicionados)
    // — só faz sentido comparando duas versões do MESMO mês, por isso fica de fora
    // quando "Todos" está combinando SPEDs de meses diferentes.
    const originalChaves = spedDataOriginal
      ? new Set(spedDataOriginal.c100.filter(c => c.chave).map(c => c.chave))
      : null;
    const adicionados = originalChaves
      ? spedSaidas.filter(c => c.chave && !originalChaves.has(c.chave))
      : [];

    return {
      spedSaidas,
      spedSaidasTotal: spedSaidas.length,
      spedEntradasTotal,
      saidaOk,
      saidaFaltantes,
      saidaFaltantesSet,
      formatDt,
      periodo: activeSpedList.map(s => `${formatDt(s.dtIni)} – ${formatDt(s.dtFin)}`).join(' + '),
      xmlsNaoDeclarados,
      xmlsForaPeriodo,
      mesesFora,
      adicionados,
      temOriginal: !!spedDataOriginal,
    };
  }, [activeSpedList, spedDataOriginal, xmlList]);

  const spedRowsFiltradas = useMemo(() => {
    if (!spedData || !spedCrossRef) return [];
    if (spedCardFiltro === 'NaoDeclarado') return []; // tabela separada no UI
    if (spedCardFiltro === 'Adicionados') return spedCrossRef.adicionados;
    let rows = spedCardFiltro === 'SemXML'
      ? spedCrossRef.saidaFaltantes
      : spedCardFiltro === 'Canceladas'
        ? spedCrossRef.spedSaidas.filter(c => c.codSit === '02' || c.codSit === '06')
        : spedCrossRef.spedSaidas;
    if (spedSearch.trim()) {
      const q = spedSearch.trim().toLowerCase();
      rows = rows.filter(c =>
        c.numDoc.includes(q) ||
        c.chave.toLowerCase().includes(q) ||
        c.dtDoc.includes(q)
      );
    }
    return rows;
  }, [spedData, spedCrossRef, spedCardFiltro, spedSearch]);

  // Nome do filtro ativo, usado tanto no rótulo da aba quanto no nome do arquivo exportado.
  const spedFiltroNomeArquivo = (): string => {
    switch (spedCardFiltro) {
      case 'SemXML': return 'FALTANTE';
      case 'Canceladas': return 'CANCELADAS';
      case 'Adicionados': return 'ADICIONADOS';
      case 'NaoDeclarado': return 'NAO_DECLARADOS';
      default: return 'COMPLETO';
    }
  };

  const exportarSpedTabelaExcel = () => {
    if (!spedData || !spedCrossRef) return;

    let aoa: (string | number)[][];
    if (spedCardFiltro === 'NaoDeclarado') {
      const q = spedSearch.trim().toLowerCase();
      const rows = q
        ? spedCrossRef.xmlsNaoDeclarados.filter(x =>
            (x.numero ?? '').includes(q) || (x.chave ?? '').toLowerCase().includes(q) || (x.data ?? '').includes(q)
          )
        : spedCrossRef.xmlsNaoDeclarados;
      if (rows.length === 0) { alert('Nenhum registro neste filtro para exportar.'); return; }
      aoa = [
        ['Data', 'Modelo', 'Série', 'Nº Doc', 'Valor', 'Chave'],
        ...rows.map(x => [
          x.data ?? '',
          x.modelo ?? '',
          x.serie ?? '',
          x.numero ?? '',
          parseFloat(x.valor || '0') || 0,
          x.chave ?? ''
        ])
      ];
    } else {
      if (spedRowsFiltradas.length === 0) { alert('Nenhum registro neste filtro para exportar.'); return; }
      aoa = [
        ['Data', 'Modelo', 'Série', 'Nº Doc', 'Valor', 'Chave', 'Status'],
        ...spedRowsFiltradas.map(c => {
          const falta = c.chave ? spedCrossRef.saidaFaltantesSet.has(c.chave) : false;
          const cancelada = c.codSit === '02' || c.codSit === '06';
          const status = cancelada ? 'Cancelada' : falta ? 'Sem XML' : 'Com XML';
          return [
            spedCrossRef.formatDt(c.dtDoc),
            c.codMod,
            c.ser,
            c.numDoc,
            parseFloat(c.vlDoc.replace(',', '.')) || 0,
            c.chave,
            status
          ];
        })
      ];
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 46 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SPED');

    const empresa = sanitizarNomeArquivo(spedData.razaoSocial);
    const periodo = sanitizarNomeArquivo(spedCrossRef.periodo);
    XLSX.writeFile(wb, `${empresa}_SPED_XML_${spedFiltroNomeArquivo()}_${periodo}.xlsx`, { compression: true });
  };

  // Empresa principal (CNPJ mais frequente entre emitente/destinatário),
  // chaves canceladas, e um cache de XML já parseado — calculados uma única
  // vez aqui e reaproveitados por todas as auditorias abaixo. Antes, cada
  // auditoria recalculava isso (e reparseava o XML de cada nota) de forma
  // independente; com milhares de notas isso significava passar pela lista
  // inteira e reabrir o parser várias vezes pra cada uma. Mesmo cálculo,
  // mesmos critérios — só compartilhado, não muda nenhum resultado.
  const mainCnpj = useMemo(() => {
    const cnpjCounts: { [cnpj: string]: number } = {};
    xmlList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });
    return Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [xmlList]);

  // A consulta da Receita (BrasilAPI) é sobre um CNPJ específico — se a empresa
  // principal mudar (nova análise, ou upload de um lote de outro cliente), o
  // resultado antigo fica errado pra mostrar. Reseta sempre que mainCnpj muda,
  // pra nunca aparecer "consultado agora" com dado da empresa anterior.
  useEffect(() => {
    setReceitaConsulta(null);
    setReceitaConsultaStatus('idle');
  }, [mainCnpj]);

  // Não restringe por tipo: além do evento de cancelamento normal (tipo
  // 'evento') e consultas, uma nota 'nfe' também pode chegar já carregando
  // seu próprio isCancelamento=true — visto na prática num arquivo malformado
  // que o sistema do cliente gerou com estrutura de nota autorizada mas
  // cStat/xMotivo de cancelamento (cStat=101 reaproveitando o protocolo da
  // autorização original, em vez de vir como evento separado tpEvento=110111).
  // Qualquer XML que autodeclare cancelamento deve excluir essa chave do
  // faturamento, seja qual for o "tipo" em que ele foi classificado.
  const chavesCanceladas = useMemo(() => {
    return new Set<string>(
      xmlList
        .filter(xml => xml.isCancelamento && xml.chave)
        .map(xml => xml.chave!)
    );
  }, [xmlList]);

  // ATENÇÃO — aqui existia o parsedXmlCache: um useMemo que re-parseava TODOS
  // os XMLs na thread principal e guardava os 33k+ DOMs num Map. Com lotes
  // grandes isso estourava a RAM (DOM ocupa 5-10× o tamanho do XML) e congelava
  // o computador inteiro (reproduzido em 2026-08-25 com lote real de 33.261
  // notas — travou o notebook do usuário). NÃO reintroduzir cache de DOM em
  // massa. Os memos de auditoria agora leem xml.extract (campos extraídos no
  // momento do parse, dentro do worker — mesmo padrão do cfopValores).
  const getNotaExtract = (xml: XmlData): NotaExtract | null => {
    if (xml.extract) return xml.extract;
    if (!xml.rawXml || xml.tipo !== 'nfe') return null;
    // Fallback raro (nota que chegou por um caminho sem extração): parseia UMA
    // vez, guarda só o extrato pequeno no próprio objeto e descarta o DOM.
    const ex = extrairAuditoria(parser.parseFromString(xml.rawXml, 'text/xml'));
    xml.extract = ex;
    return ex;
  };

  const faturamentoTotal = useMemo(() => {
    if (!mainCnpj) return 0;

    return xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0')
      .reduce((acc, xml) => {
        if (xml.chave && chavesCanceladas.has(xml.chave)) return acc;
        if (!xml.protocolo) return acc;
        if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return acc;
        return acc + (parseFloat(xml.valor || '0') || 0);
      }, 0);
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Breaks faturamentoTotal down by natureza da operação (CFOP), mirroring the
  // "Totais ICMS por Natureza" report from the fiscal system.
  const breakdownPorCfop = useMemo(() => {
    if (!mainCnpj) return [];


    const totalPorCfop: Record<string, number> = {};
    xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0')
      .forEach(xml => {
        if (xml.chave && chavesCanceladas.has(xml.chave)) return;
        if (!xml.protocolo) return;
        if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return;
        const valorNota = parseFloat(xml.valor || '0') || 0;
        const itens: Record<string, number> = xml.cfopValores || {};
        const totalItens = Object.values(itens).reduce((s, v) => s + v, 0);

        if (totalItens > 0) {
          // Split the note's total value across its CFOPs proportionally to each
          // item's share, so multi-CFOP notes don't get double counted or dropped.
          Object.entries(itens).forEach(([cfop, valorItem]) => {
            totalPorCfop[cfop] = (totalPorCfop[cfop] || 0) + (valorNota * (valorItem / totalItens));
          });
        } else {
          const fallbackCfop = xml.natureza || 'Não identificado';
          totalPorCfop[fallbackCfop] = (totalPorCfop[fallbackCfop] || 0) + valorNota;
        }
      });

    return Object.entries(totalPorCfop)
      .map(([cfop, valor]) => ({
        cfop,
        descricao: /^\d{4}$/.test(cfop) ? descricaoCfop(cfop) : cfop,
        valor
      }))
      .sort((a, b) => a.cfop.localeCompare(b.cfop));
  }, [xmlList, filterMes]);

  // Mesmo critério do breakdownPorCfop, mas separando o valor de cada CFOP
  // entre NF-e (mod 55) e NFC-e (mod 65) — só pro botão "detalhar por modelo",
  // não muda em nada o card original quando não está expandido.
  const breakdownPorCfopPorModelo = useMemo(() => {
    if (!mainCnpj) return {};


    const totalPorCfopModelo: Record<string, { nfe: number; nfce: number }> = {};
    xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0')
      .forEach(xml => {
        if (xml.chave && chavesCanceladas.has(xml.chave)) return;
        if (!xml.protocolo) return;
        if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return;
        const valorNota = parseFloat(xml.valor || '0') || 0;
        const itens: Record<string, number> = xml.cfopValores || {};
        const totalItens = Object.values(itens).reduce((s, v) => s + v, 0);
        const chave = xml.modelo === '65' ? 'nfce' : 'nfe';

        const addValor = (cfop: string, valor: number) => {
          if (!totalPorCfopModelo[cfop]) totalPorCfopModelo[cfop] = { nfe: 0, nfce: 0 };
          totalPorCfopModelo[cfop][chave] += valor;
        };

        if (totalItens > 0) {
          Object.entries(itens).forEach(([cfop, valorItem]) => {
            addValor(cfop, valorNota * (valorItem / totalItens));
          });
        } else {
          addValor(xml.natureza || 'Não identificado', valorNota);
        }
      });

    return totalPorCfopModelo;
  }, [xmlList, filterMes]);

  // Detects two classes of anomalies in saída notes:
  // 1. Notes without an authorization protocol (contingência not regularized with SEFAZ)
  // 2. Notes with the same série+número but different access keys (same number re-emitted)
  const notasAnomalias = useMemo(() => {
    if (!mainCnpj) return {
      semProtocolo: [] as XmlData[],
      semProtocoloAbatidas: 0,
      foraDoPrazo: [] as XmlData[],
      numeroDuplicado: [] as XmlData[][],
      semAutorizacaoNaoContingencia: [] as XmlData[],
      malformadas: [] as (XmlData & { motivoMalformada: string; contaNoFaturamento: boolean })[]
    };

    // Decodifica os 44 dígitos da chave de acesso (cUF+AAMM+CNPJ+mod+série+
    // nNF+tpEmis+cNF+DV) e confere: (1) o dígito verificador bate pelo
    // algoritmo módulo-11 oficial; (2) CNPJ/modelo/série/número embutidos na
    // própria chave batem com os mesmos campos lidos das tags do XML. Isso
    // NÃO detecta fraude (quem fabrica um XML também acerta esses campos
    // fácil) — só pega corrupção/inconsistência interna do arquivo. Por não
    // ser prova de que a venda é inválida, NÃO exclui do faturamento (ao
    // contrário do cancelamento disfarçado abaixo) — só sinaliza pra conferir.
    const validarConsistenciaChave = (xml: XmlData): string | null => {
      const chave = xml.chave;
      if (!chave || !/^\d{44}$/.test(chave)) return null;

      const corpo = chave.slice(0, 43);
      let soma = 0, peso = 2;
      for (let i = corpo.length - 1; i >= 0; i--) {
        soma += parseInt(corpo[i], 10) * peso;
        peso = peso === 9 ? 2 : peso + 1;
      }
      const resto = soma % 11;
      const dvEsperado = resto < 2 ? 0 : 11 - resto;
      if (dvEsperado !== parseInt(chave[43], 10)) {
        return `Dígito verificador da chave não confere (esperado ${dvEsperado}, encontrado ${chave[43]})`;
      }

      const cnpjChave = chave.slice(6, 20);
      const modChave = chave.slice(20, 22);
      const serieChave = parseInt(chave.slice(22, 25), 10);
      const nnfChave = parseInt(chave.slice(25, 34), 10);

      const cnpjXml = (xml.emitCnpj || '').replace(/[.\-/\s]/g, '');
      if (cnpjXml && cnpjChave !== cnpjXml) {
        return `CNPJ na chave (${cnpjChave}) não bate com o CNPJ do emitente no XML (${cnpjXml})`;
      }
      if (xml.modelo && modChave !== xml.modelo.padStart(2, '0')) {
        return `Modelo na chave (${modChave}) não bate com o modelo do XML (${xml.modelo})`;
      }
      if (xml.serie && !isNaN(parseInt(xml.serie, 10)) && serieChave !== parseInt(xml.serie, 10)) {
        return `Série na chave (${serieChave}) não bate com a série do XML (${xml.serie})`;
      }
      if (xml.numero && !isNaN(parseInt(xml.numero, 10)) && nnfChave !== parseInt(xml.numero, 10)) {
        return `Número na chave (${nnfChave}) não bate com o número do XML (${xml.numero})`;
      }
      return null;
    };

    // Checklist manual de regras básicas de estrutura (o navegador não tem
    // validação de XSD nativa, e uma engine XSD completa não roda em JS puro
    // — então em vez de carregar os .xsd oficiais, checamos aqui as regras
    // mais importantes do leiaute: formato/tamanho de campos obrigatórios.
    // Uma nota REALMENTE autorizada pelo SEFAZ já passou por XSD completo na
    // autorização — isso só pega arquivo corrompido/truncado depois, ou nunca
    // validado por ninguém (gerado à parte). Junta todos os problemas achados
    // numa única mensagem, sem parar no primeiro.
    const validarEstruturaBasica = (xml: XmlData): string | null => {
      const problemas: string[] = [];

      if (!xml.chave || !/^\d{44}$/.test(xml.chave)) {
        problemas.push(`chave de acesso não tem 44 dígitos numéricos (${xml.chave ? xml.chave.length : 0} caractere(s))`);
      }
      const cnpj = xml.emitCnpj || '';
      if (!cnpj || cnpj.length !== 14) {
        problemas.push(`CNPJ do emitente com tamanho inválido (${cnpj.length || 0} caractere(s), esperado 14)`);
      }
      if (xml.modelo !== '55' && xml.modelo !== '65') {
        problemas.push(`modelo "${xml.modelo || '?'}" não é 55 (NF-e) nem 65 (NFC-e)`);
      }
      const valorNum = parseFloat(xml.valor || '');
      if (xml.valor === undefined || xml.valor === '' || isNaN(valorNum) || valorNum < 0) {
        problemas.push(`valor da nota ausente ou inválido ("${xml.valor ?? ''}")`);
      }
      if (!xml.data || isNaN(new Date(xml.data).getTime())) {
        problemas.push('data de emissão ausente ou inválida');
      }

      return problemas.length > 0 ? problemas.join('; ') : null;
    };

    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' &&
      xml.emitCnpj === mainCnpj &&
      xml.tpNF !== '0' &&
      !(xml.chave && chavesCanceladas.has(xml.chave))
    );

    // Nota com ESTRUTURA de nota autorizada (tipo 'nfe', não um evento
    // separado) mas que ela própria já vem com cStat/xMotivo de cancelamento
    // (ex: cStat=101 reaproveitando o protocolo da autorização original) —
    // visto na prática num arquivo que o sistema do cliente gerou de forma
    // não padronizada. Já é excluída do faturamento (chavesCanceladas cobre
    // isCancelamento em qualquer tipo), mas precisa aparecer destacada aqui:
    // não é o fluxo normal de cancelamento (evento tpEvento=110111 separado).
    const malformadasCancelamento = xmlList.filter(xml =>
      xml.tipo === 'nfe' &&
      xml.emitCnpj === mainCnpj &&
      xml.tpNF !== '0' &&
      xml.isCancelamento
    ).map(xml => ({
      ...xml,
      motivoMalformada: 'Estrutura de nota autorizada, mas o próprio XML já vem com cStat/xMotivo de cancelamento (não é o evento de cancelamento normal)',
      contaNoFaturamento: false
    }));

    // Chave × dados internos: os 44 dígitos da chave já embutem CNPJ/modelo/
    // série/número — se não baterem com as mesmas tags do XML, é sinal de
    // corrupção/inconsistência no arquivo. Roda só sobre "saidas" (já exclui
    // canceladas) porque isso NÃO prova que a venda é inválida — só pede
    // conferência, então continua contando no faturamento.
    const malformadasChaveInconsistente = saidas
      .map(xml => ({ xml, motivo: validarConsistenciaChave(xml) }))
      .filter((r): r is { xml: XmlData; motivo: string } => r.motivo !== null)
      .map(r => ({ ...r.xml, motivoMalformada: r.motivo, contaNoFaturamento: true }));

    // Checklist manual de estrutura básica (ver validarEstruturaBasica acima) —
    // mesmo raciocínio da chave: não prova venda inválida, então continua
    // contando no faturamento, só pede conferência.
    const malformadasEstruturaInvalida = saidas
      .map(xml => ({ xml, motivo: validarEstruturaBasica(xml) }))
      .filter((r): r is { xml: XmlData; motivo: string } => r.motivo !== null)
      .map(r => ({ ...r.xml, motivoMalformada: r.motivo, contaNoFaturamento: true }));

    // Uma mesma nota pode falhar mais de uma checagem de "pra conferir" ao
    // mesmo tempo (ex: modelo errado quebra tanto a consistência da chave
    // quanto o checklist de estrutura) — agrupa por chave (ou série+número se
    // não tiver chave) pra aparecer uma linha só, com os motivos concatenados,
    // em vez de duplicar a mesma nota na tabela.
    const paraConferirPorNota = new Map<string, XmlData & { motivoMalformada: string; contaNoFaturamento: boolean }>();
    [...malformadasChaveInconsistente, ...malformadasEstruturaInvalida].forEach(item => {
      const key = item.chave || `${item.serie}-${item.numero}`;
      const existente = paraConferirPorNota.get(key);
      if (existente) {
        existente.motivoMalformada = `${existente.motivoMalformada}; ${item.motivoMalformada}`;
      } else {
        paraConferirPorNota.set(key, { ...item });
      }
    });

    const malformadas = [...malformadasCancelamento, ...Array.from(paraConferirPorNota.values())];

    const foraDoPrazo = saidas.filter(isForaDoPrazo);

    // Contingência não regularizada: emitida offline (tpEmis=9) sem nProt,
    // desconsiderando notas que têm versão autorizada com a mesma chave/série+número.
    const saidasComProtocolo = saidas.filter(x => !!x.protocolo);
    const chavesComProtocolo = new Set(saidasComProtocolo.map(x => x.chave).filter(Boolean));
    const seriesNumerosComProtocolo = new Set(saidasComProtocolo.map(x => `${x.serie}-${x.numero}`));
    const semProtocolo = saidas.filter(xml =>
      xml.isContingencia && !xml.protocolo &&
      !(xml.chave && chavesComProtocolo.has(xml.chave)) &&
      !seriesNumerosComProtocolo.has(`${xml.serie}-${xml.numero}`)
    );
    const semProtocoloAbatidas = 0; // kept for UI compat, no longer shown

    // Group by série+número; any group with more than one distinct chave is a duplicate number
    const bySerieNumero: Record<string, XmlData[]> = {};
    saidas.forEach(xml => {
      const key = `${xml.serie}-${xml.numero}`;
      if (!bySerieNumero[key]) bySerieNumero[key] = [];
      bySerieNumero[key].push(xml);
    });
    const numeroDuplicado = Object.values(bySerieNumero).filter(group => group.length > 1);

    // Notas sem autorização que NÃO são contingência offline (tpEmis != 9):
    // rejeitadas, timeout ou XML sem nProt por outro motivo.
    const semAutorizacaoNaoContingencia = saidas.filter(xml =>
      !xml.isContingencia && !xml.protocolo &&
      !(xml.chave && chavesComProtocolo.has(xml.chave)) &&
      !seriesNumerosComProtocolo.has(`${xml.serie}-${xml.numero}`)
    );

    // Cross-reference com inutilizações: se o mesmo série+número foi inutilizado,
    // o analista precisa saber — pode indicar numeração reaproveitada indevidamente.
    // Só remove pontuação — preserva letras do CNPJ alfanumérico (NT 2026.004).
    const cleanCnpjLocal = (c: string) => c.replace(/[.\-/\s]/g, '');
    const seriesNumerosInutilizados = new Set<string>(
      inutilizacoes
        .filter(i => cleanCnpjLocal(i.cnpj ?? '') === mainCnpj)
        .flatMap(i => {
          const items: string[] = [];
          for (let n = (i.nNFIni ?? 0); n <= (i.nNFFin ?? 0); n++) {
            items.push(`${i.serie}-${n}`);
          }
          return items;
        })
    );

    const semAutorizacaoComFlag = semAutorizacaoNaoContingencia.map(xml => ({
      ...xml,
      temInutilizacao: seriesNumerosInutilizados.has(`${xml.serie}-${xml.numero}`)
    }));

    return { semProtocolo, semProtocoloAbatidas, foraDoPrazo, numeroDuplicado, semAutorizacaoNaoContingencia: semAutorizacaoComFlag, malformadas };
  }, [xmlList, inutilizacoes, chavesCanceladas, mainCnpj]);

  // Regime tributário do emitente principal, lido do <CRT> (Código de Regime
  // Tributário): 1/2 = Simples Nacional, 3 = Regime Normal. Simples Nacional
  // não tem obrigatoriedade de TEF; Regime Normal tem, então essa distinção
  // muda a severidade do alerta na Auditoria de Pagamento (TEF).
  const regimeTributario = useMemo(() => {
    if (!mainCnpj) return { crt: '', label: null as string | null, isSimples: false, isMei: false };

    // Nem toda nota tem <CRT> preenchido (varia por sistema/versão do emissor)
    // — percorre as notas do período até achar uma que realmente traga o
    // dado, em vez de desistir na primeira (que pode ser justo uma sem ele).
    // Prioriza o período/mês selecionado; só cai pra qualquer nota da empresa
    // se nenhuma do período tiver CRT.
    const buscarCrt = (notas: XmlData[]) => {
      for (const nota of notas) {
        const valor = getNotaExtract(nota)?.crt;
        if (valor) return valor;
      }
      return '';
    };
    const daEmpresa = xmlList.filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.rawXml);
    const doPeriodo = daEmpresa.filter(xml => filterMes === 'Todos' || getMonthYear(xml.data) === filterMes);
    const crt = buscarCrt(doPeriodo) || buscarCrt(daEmpresa);

    const isSimples = crt === '1' || crt === '2';
    // CRT=4 (MEI) foi liberado pela NT 2024.001 — MEI não é "Simples Nacional"
    // no sentido estrito (regime próprio, embora sob o guarda-chuva do SIMEI),
    // mas também não tem obrigatoriedade de TEF, então fica com flag própria.
    const isMei = crt === '4';
    const label = isSimples ? 'Simples Nacional' : isMei ? 'MEI' : crt === '3' ? 'Regime Normal' : null;
    return { crt, label, isSimples, isMei };
  }, [xmlList, filterMes, mainCnpj]);

  const crtLabel: Record<string, string> = { '1': 'Simples Nacional', '2': 'Simples Nacional (sublimite)', '3': 'Regime Normal', '4': 'MEI' };

  // Auditoria de Regime: levanta prova de qual regime tributário as próprias
  // notas declaram (CRT) e se isso é consistente com o jeito que o ICMS é
  // calculado item a item (CSOSN = padrão Simples, CST = padrão Normal) — um
  // caso real mostrou uma empresa declarando Simples Nacional em 100% das
  // notas (CRT=1 + CSOSN em tudo) o ano inteiro, mesmo nunca tendo sido
  // optante de verdade (erro de cadastro no sistema de emissão do cliente).
  // Isso o app NÃO detecta sozinho (precisaria consultar a Receita Federal),
  // mas reúne a evidência pro analista confrontar com o cadastro oficial.
  const auditoriaRegime = useMemo(() => {
    const vazio = {
      totalNotas: 0, crtCounts: [] as { crt: string; label: string; qtd: number; primeira: string; ultima: string }[],
      crtPredominante: '', crtPredominanteLabel: '', pctPredominante: 0, consistente: true, mudouNoPeriodo: false,
      inconsistencias: [] as { xml: XmlData; motivo: string }[], amostra: [] as XmlData[],
      semCrt: [] as XmlData[], temAlerta: false,
    };
    if (!mainCnpj) return vazio;


    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    ).sort((a, b) => (a.data || '').localeCompare(b.data || ''));

    if (saidas.length === 0) return vazio;

    const porCrt: Record<string, { qtd: number; primeira: string; ultima: string }> = {};
    const inconsistencias: { xml: XmlData; motivo: string }[] = [];
    const amostraPorCrt = new Map<string, XmlData>();
    // Nota sem <CRT> nenhum é, em si, uma inconsistência de padronização —
    // não deve ser descartada silenciosamente do total, senão "100% consistente"
    // vira uma conta enganosa (só sobre quem tinha o campo, não sobre o total).
    const semCrt: XmlData[] = [];

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      const crt = ex?.crt || '';
      if (!crt) { semCrt.push(xml); return; }

      if (!porCrt[crt]) porCrt[crt] = { qtd: 0, primeira: xml.data || '', ultima: xml.data || '' };
      porCrt[crt].qtd++;
      if ((xml.data || '') < porCrt[crt].primeira) porCrt[crt].primeira = xml.data || '';
      if ((xml.data || '') > porCrt[crt].ultima) porCrt[crt].ultima = xml.data || '';
      if (!amostraPorCrt.has(crt)) amostraPorCrt.set(crt, xml);

      // Confere se o jeito que o ICMS foi calculado bate com o CRT declarado.
      // Por Convênio SINIEF s/nº de 1970 (Anexo III-A, incluído pelo Ajuste
      // SINIEF 11/2019): CSOSN só vale pra CRT 1 (Simples pleno) e 4 (MEI).
      // CRT 2 (Simples Nacional com excesso de sublimite) usa CST igual
      // Regime Normal pra ICMS/ISS — LC 123/2006 arts. 13-A/19/20 e Resolução
      // CGSN 140/2018 art. 12 tiram o direito de recolher ICMS/ISS pelo
      // Simples nesse caso, mas a empresa continua Simples Nacional pros
      // demais tributos. Por isso CRT 2 entra junto com CRT 3 na expectativa
      // de CST, não junto com 1/4 na expectativa de CSOSN.
      const temCsosn = ex!.dets.some(d => d.icmsTemCsosn);
      const temCst = ex!.dets.some(d => d.icmsTemCst);
      const esperaCsosn = crt === '1' || crt === '4';
      const esperaCst = crt === '2' || crt === '3';
      if (esperaCsosn && temCst && !temCsosn) {
        inconsistencias.push({ xml, motivo: `CRT=${crt} (${crtLabel[crt] || crt}) mas os itens usam CST (padrão Regime Normal) em vez de CSOSN` });
      } else if (esperaCst && temCsosn && !temCst) {
        inconsistencias.push({ xml, motivo: `CRT=${crt} (${crtLabel[crt] || crt}) mas os itens usam CSOSN (padrão Simples Nacional) em vez de CST` });
      }
    });

    const crtCounts = Object.entries(porCrt)
      .map(([crt, v]) => ({
        crt, label: crtLabel[crt] || crt, qtd: v.qtd,
        primeira: v.primeira ? new Date(v.primeira).toLocaleDateString('pt-BR') : '',
        ultima: v.ultima ? new Date(v.ultima).toLocaleDateString('pt-BR') : '',
      }))
      .sort((a, b) => b.qtd - a.qtd);

    const crtPredominante = crtCounts[0]?.crt || '';
    // % sobre o TOTAL de saídas do período, não só sobre quem tinha CRT —
    // se 3 de 491 notas não trouxerem o campo, isso já não é "100%". Sem
    // Math.round pelo mesmo motivo: 490/491 arredondava pra "100%" mesmo
    // sobrando 1 nota destoante (mesmo bug corrigido no card de IBS/CBS e no
    // TEF — formatarPct mostra a casa decimal quando não é 100% de verdade).
    const pctPredominante = saidas.length > 0 ? ((crtCounts[0]?.qtd || 0) / saidas.length) * 100 : 0;
    const mudouNoPeriodo = crtCounts.length > 1;

    return {
      totalNotas: saidas.length,
      crtCounts,
      crtPredominante,
      crtPredominanteLabel: crtLabel[crtPredominante] || crtPredominante,
      pctPredominante,
      consistente: inconsistencias.length === 0,
      mudouNoPeriodo,
      inconsistencias,
      amostra: Array.from(amostraPorCrt.values()),
      semCrt,
      temAlerta: mudouNoPeriodo || semCrt.length > 0,
    };
  }, [xmlList, filterMes]);

  // Auditoria de CST/CSOSN do ICMS: reúne tudo que é referente a situação
  // tributária do ICMS num só lugar — (1) distribuição de código em uso
  // (quanto cada CST/CSOSN representa do faturamento), e (2) duas
  // conferências objetivas, direto do próprio layout oficial da NF-e, sem
  // interpretar produto/CFOP: item com código que pelo layout NEM TEM campo
  // de ICMS (isento/suspenso/ST já recolhido antes) mas ainda assim traz
  // ICMS destacado — sinal de erro de configuração no emissor; e, pra código
  // que tem <vICMS>, se a conta vBC × pICMS bate com o valor declarado.
  type CstUso = { codigo: string; descricao: string; conhecido: boolean; qtdItens: number; valor: number; pct: number; produtoAmostra: string };
  type CstProblema = { tipo: 'destacado_indevido' | 'conta_nao_bate'; codigo: string; xml: XmlData; xProd: string; vICMS: number; vBC: number | null; pICMS: number | null; esperado?: number };
  const auditoriaCst = useMemo(() => {
    const vazio = { totalItens: 0, totalNotas: 0, usos: [] as CstUso[], problemas: [] as CstProblema[] };
    if (!mainCnpj) return vazio;

    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    type Acum = { qtdItens: number; valor: number; produtoAmostra: string };
    const mapaUso = new Map<string, Acum>();
    const problemas: CstProblema[] = [];
    let totalItens = 0;
    const notasComItem = new Set<string>();

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      let notaTemItem = false;
      ex.dets.forEach(det => {
        if (!det.icmsCodigo) return;
        totalItens++;
        notaTemItem = true;
        let a = mapaUso.get(det.icmsCodigo);
        if (!a) { a = { qtdItens: 0, valor: 0, produtoAmostra: det.xProd || '(sem descrição)' }; mapaUso.set(det.icmsCodigo, a); }
        a.qtdItens++;
        a.valor += det.vProd;

        const info = CST_ICMS_DESCRICOES[det.icmsCodigo];
        const vICMS = det.vICMS ?? 0;
        if (info?.esperaVicms === 'nao' && vICMS > 0.01) {
          problemas.push({ tipo: 'destacado_indevido', codigo: det.icmsCodigo, xml, xProd: det.xProd, vICMS, vBC: det.vBCIcms, pICMS: det.pICMS });
        } else if ((info?.esperaVicms === 'sim' || info?.esperaVicms === 'opcional') && det.vBCIcms != null && det.pICMS != null && det.vBCIcms > 0 && det.pICMS > 0) {
          const esperado = det.vBCIcms * (det.pICMS / 100);
          if (Math.abs(esperado - vICMS) > 0.02) {
            problemas.push({ tipo: 'conta_nao_bate', codigo: det.icmsCodigo, xml, xProd: det.xProd, vICMS, vBC: det.vBCIcms, pICMS: det.pICMS, esperado });
          }
        }
      });
      if (notaTemItem) notasComItem.add(xml.chave || xml.fileName);
    });

    const totalValor = Array.from(mapaUso.values()).reduce((s, a) => s + a.valor, 0);
    const usos: CstUso[] = Array.from(mapaUso.entries())
      .map(([codigo, a]) => ({
        codigo,
        descricao: CST_ICMS_DESCRICOES[codigo]?.descricao || '(código não encontrado na tabela oficial de CST/CSOSN)',
        conhecido: !!CST_ICMS_DESCRICOES[codigo],
        qtdItens: a.qtdItens, valor: a.valor,
        pct: totalValor > 0 ? (a.valor / totalValor) * 100 : 0,
        produtoAmostra: a.produtoAmostra,
      }))
      .sort((a, b) => b.valor - a.valor);

    return { totalItens, totalNotas: notasComItem.size, usos, problemas };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Auditoria de IBS/CBS (Reforma Tributária — EC 132/2023 + LC 214/2025):
  // 2026 é o período de teste (0,1% IBS + 0,9% CBS, compensável), quando o
  // grupo <IBSCBS> por item começa a aparecer no XML. Só confere presença/
  // ausência do grupo — não audita se a alíquota/valor calculado está
  // correto (isso mudaria a cada ano da transição até 2033).
  const auditoriaIbsCbs = useMemo(() => {
    const vazio = { totalNotas: 0, notasComGrupo: 0, pctComGrupo: 0, amostraSemGrupo: [] as XmlData[], amostraComGrupo: [] as XmlData[] };
    if (!mainCnpj) return vazio;


    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    let notasComGrupo = 0;
    const amostraSemGrupo: XmlData[] = [];
    const amostraComGrupo: XmlData[] = [];
    // No máximo 1 nota por dia em cada amostra (não as N primeiras da lista) —
    // assim a amostra cobre o período inteiro e ajuda a enxergar em que dia
    // o sistema do cliente começou (ou parou) de preencher o grupo IBS/CBS.
    const diasVistosSemGrupo = new Set<string>();
    const diasVistosComGrupo = new Set<string>();

    const saidasOrdenadas = [...saidas].sort((a, b) => (a.data || '').localeCompare(b.data || ''));

    saidasOrdenadas.forEach(xml => {
      const temGrupo = getNotaExtract(xml)?.dets.some(d => d.temIbsCbs) ?? false;
      const dia = xml.data ? xml.data.slice(0, 10) : '';
      if (temGrupo) {
        notasComGrupo++;
        if (amostraComGrupo.length < 50 && !diasVistosComGrupo.has(dia)) {
          diasVistosComGrupo.add(dia);
          amostraComGrupo.push(xml);
        }
      } else {
        if (amostraSemGrupo.length < 50 && !diasVistosSemGrupo.has(dia)) {
          diasVistosSemGrupo.add(dia);
          amostraSemGrupo.push(xml);
        }
      }
    });

    return {
      totalNotas: saidas.length,
      notasComGrupo,
      // Sem arredondar pra inteiro: 443/444 vira 99,77% e não pode virar "100%" na tela
      // (arredondar escondia justamente a nota que falta o grupo IBS/CBS).
      pctComGrupo: (notasComGrupo / saidas.length) * 100,
      amostraSemGrupo,
      amostraComGrupo,
    };
  }, [xmlList, filterMes]);

  // Auditoria estrutural de cClassTrib: valida cada item que já traz o grupo
  // <IBSCBS> contra a tabela oficial do Portal da NF-e (embutida em
  // cclasstribTabela.ts). Só checagens determinísticas — código × código:
  // formato, prefixo CST↔cClassTrib, existência na tabela, vigência na data
  // de emissão, permissão pro modelo (NF-e/NFC-e) e redução de alíquota
  // compatível. NUNCA interpreta nome de produto nem sugere qual código
  // "deveria" ser — isso é decisão do contador, não do app.
  const auditoriaClassTrib = useMemo(() => {
    type Problema = {
      nivel: 'erro' | 'alerta';
      code: string;
      motivo: string;
      itens: number;
      notas: Set<string>;
      exemplo: string; // "série/número" da primeira nota afetada
    };
    type CodigoUsado = { code: string; nome: string; cst: string; redIBS: number; redCBS: number; itens: number; notas: Set<string>; valor: number; vIBS: number; vCBS: number; naTabela: boolean; produtos: Map<string, ProdutoDoCodigo> };
    const vazio = { totalItens: 0, totalNotas: 0, itensOk: 0, problemas: [] as Problema[], codigosUsados: [] as CodigoUsado[], totalIBS: 0, totalCBS: 0, ncmsDistintos: 0, cclassTribUnicoSuspeito: false };
    if (!mainCnpj) return vazio;

    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    const problemas = new Map<string, Problema>();
    const registrar = (nivel: 'erro' | 'alerta', code: string, motivo: string, xml: XmlData) => {
      const key = `${code}|${motivo}`;
      let p = problemas.get(key);
      if (!p) {
        p = { nivel, code, motivo, itens: 0, notas: new Set(), exemplo: `${xml.serie}/${xml.numero}` };
        problemas.set(key, p);
      }
      p.itens++;
      if (xml.chave) p.notas.add(xml.chave);
    };

    const usados = new Map<string, CodigoUsado>();
    const notasComItemVerificado = new Set<string>();
    // Diversidade de NCM no período — usado só pra julgar se "um cClassTrib
    // só" é plausível (catálogo pouco variado) ou suspeito (catálogo variado
    // mas o sistema nunca varia o código, sinal de valor fixo/padrão).
    const ncmsDistintos = new Set<string>();
    let totalItens = 0;
    let itensComProblema = 0;

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      const dataEmissao = (xml.data || '').slice(0, 10); // YYYY-MM-DD, comparável como string
      const idNota = xml.chave || `${xml.serie}/${xml.numero}`;
      ex.dets.forEach(det => {
        if (!det.temIbsCbs) return; // ausência do grupo já é coberta pela auditoria IBS/CBS acima
        totalItens++;
        notasComItemVerificado.add(idNota);
        // Valor do item pra dar ao analista a noção de quanto da venda cai em
        // cada classificação (vProd bruto do item, sem rateio de desconto da nota).
        const vProd = det.vProd;
        // IBS/CBS já calculados pelo sistema do cliente e destacados no próprio
        // item — nenhum cálculo nosso, só leitura do que o XML declara.
        // Monofásico (sem gIBSCBS) fica de fora dessa soma.
        const vIBSItem = det.vIBS ?? 0;
        const vCBSItem = det.cbs?.v ?? 0;
        // Nome e NCM do produto COMO O CLIENTE CADASTROU — vão pro laudo pra o
        // analista enxergar qual produto caiu em qual classificação; o app não
        // julga se a classificação é adequada, só lista.
        const xProdItem = det.xProd || '(sem descrição)';
        const ncmItem = det.ncm;
        if (ncmItem) ncmsDistintos.add(ncmItem);
        // CST e cClassTrib já vieram extraídos como filhos DIRETOS de <IBSCBS>
        // (nunca o CSTReg/cClassTribReg de gTribRegular).
        const cst = det.ibsCst;
        const code = det.cClassTrib;
        let temProblema = false;
        const erro = (c: string, m: string) => { registrar('erro', c, m, xml); temProblema = true; };
        const alerta = (c: string, m: string) => { registrar('alerta', c, m, xml); temProblema = true; };

        // 1. Formato
        if (!/^\d{3}$/.test(cst)) erro(code || '—', `CST "${cst || '(vazio)'}" fora do formato oficial (3 dígitos)`);
        if (!/^\d{6}$/.test(code)) erro(code || '—', `cClassTrib "${code || '(vazio)'}" fora do formato oficial (6 dígitos)`);

        if (/^\d{6}$/.test(code)) {
          // 2. Prefixo: os 3 primeiros dígitos do cClassTrib são o próprio CST
          if (/^\d{3}$/.test(cst) && code.slice(0, 3) !== cst) {
            erro(code, `prefixo do cClassTrib (${code.slice(0, 3)}) não bate com o CST declarado (${cst})`);
          }

          const entry = CCLASSTRIB_TABELA[code];
          const u = usados.get(code) ?? {
            code, nome: entry?.nome ?? '(não consta na tabela oficial)', cst: entry?.cst ?? cst,
            redIBS: entry?.redIBS ?? 0, redCBS: entry?.redCBS ?? 0, itens: 0, notas: new Set<string>(), valor: 0, vIBS: 0, vCBS: 0, naTabela: !!entry,
            produtos: new Map<string, ProdutoDoCodigo>(),
          };
          u.itens++;
          u.notas.add(idNota);
          u.valor += vProd;
          u.vIBS += vIBSItem;
          u.vCBS += vCBSItem;
          const prodKey = `${xProdItem}|${ncmItem}`;
          const p = u.produtos.get(prodKey) ?? { xProd: xProdItem, ncm: ncmItem, itens: 0, valor: 0, vIbsCbs: 0 };
          p.itens++;
          p.valor += vProd;
          p.vIbsCbs += vIBSItem + vCBSItem;
          u.produtos.set(prodKey, p);
          usados.set(code, u);

          if (!entry) {
            // 3. Existência
            erro(code, `cClassTrib não localizado na tabela oficial (${CCLASSTRIB_VERSAO})`);
          } else {
            // 4. Vigência na data de emissão
            if (dataEmissao && (dataEmissao < entry.ini || (entry.fim && dataEmissao > entry.fim))) {
              erro(code, `fora de vigência na data de emissão (válido de ${entry.ini}${entry.fim ? ` a ${entry.fim}` : ' em diante'})`);
            }
            // 5. Permissão pro modelo do documento
            if (xml.modelo === '65' && !entry.nfce) erro(code, 'código não permitido em NFC-e (indNFCe = Não na tabela oficial)');
            if (xml.modelo === '55' && !entry.nfe) erro(code, 'código não permitido em NF-e (indNFe = Não na tabela oficial)');

            // 6. Redução de alíquota × tabela — só quando o grupo padrão gIBSCBS
            // existe (regimes monofásicos usam outra estrutura e ficam de fora).
            if (det.temGIbsCbs) {
              const conferir = (rotulo: string, xmlRed: number | null, tabRed: number) => {
                if (tabRed > 0) {
                  if (xmlRed === null) alerta(code, `tabela prevê redução de ${tabRed}% no ${rotulo}, mas o XML não traz o grupo de redução (gRed)`);
                  else if (Math.abs(xmlRed - tabRed) > 0.001) erro(code, `redução de ${rotulo} divergente: XML informa ${xmlRed}%, tabela oficial prevê ${tabRed}%`);
                } else if (xmlRed !== null && xmlRed > 0) {
                  erro(code, `XML informa redução de ${xmlRed}% no ${rotulo}, mas a tabela oficial não prevê redução pra esse código`);
                }
              };
              conferir('IBS (UF)', det.uf?.red ?? null, entry.redIBS);
              conferir('IBS (Município)', det.mun?.red ?? null, entry.redIBS);
              conferir('CBS', det.cbs?.red ?? null, entry.redCBS);
            }
          }
        }

        if (temProblema) itensComProblema++;
      });
    });

    const lista = Array.from(problemas.values())
      .sort((a, b) => (a.nivel === b.nivel ? b.itens - a.itens : a.nivel === 'erro' ? -1 : 1));
    const codigos = Array.from(usados.values()).sort((a, b) => b.itens - a.itens);
    // Um único cClassTrib pro período inteiro só é normal quando o catálogo
    // também é pouco variado (loja de nicho, poucos NCMs). Com catálogo
    // variado (≥10 NCMs distintos) e ainda assim zero variação de código,
    // é sinal de sistema jogando um valor fixo/padrão em vez de classificar
    // produto a produto — mesma classificação pra tudo por acidente, não
    // por análise. Limiar de 10 é arbitrário mas propositalmente baixo: o
    // objetivo é avisar, não provar erro (isso cabe ao contador confirmar).
    const cclassTribUnicoSuspeito = codigos.length === 1 && ncmsDistintos.size >= 10;
    return {
      totalItens,
      totalNotas: notasComItemVerificado.size,
      itensOk: totalItens - itensComProblema,
      problemas: lista,
      codigosUsados: codigos,
      totalIBS: codigos.reduce((s, c) => s + c.vIBS, 0),
      totalCBS: codigos.reduce((s, c) => s + c.vCBS, 0),
      ncmsDistintos: ncmsDistintos.size,
      cclassTribUnicoSuspeito,
    };
  }, [xmlList, filterMes]);

  // Laudo de Classificação Tributária IBS/CBS em janela própria pra imprimir/
  // salvar como PDF — lista os produtos DO CADASTRO DO CLIENTE dentro de cada
  // código, pra o analista enxergar visualmente qual classificação destoa
  // (ex: pão em "tributação integral" numa padaria) e corrigir no cadastro.
  // O laudo não julga nada: só organiza o que o XML declara.
  const exportarLaudoIbsCbs = () => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const empresa = analysis?.[0]?.razaoSocial || notasSaida[0]?.razaoSocial || '';
    const periodo = periodoParaNomeArquivo();
    const hoje = new Date().toLocaleDateString('pt-BR');
    const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const secoesProblemas = auditoriaClassTrib.problemas.length === 0
      ? `<div class="box ok">✓ Todos os ${auditoriaClassTrib.totalItens} itens verificados usam códigos existentes na tabela oficial, vigentes na data de emissão, permitidos pro modelo do documento e com redução de alíquota compatível.</div>`
      : auditoriaClassTrib.problemas.map(p => `
        <div class="box ${p.nivel === 'erro' ? 'erro' : 'alerta'}">
          ${p.nivel === 'erro' ? '🔴' : '🟡'} <strong class="mono">${esc(p.code)}</strong> — ${esc(p.motivo)}<br/>
          <span class="sub">${p.itens} item(ns) em ${p.notas.size} nota(s) · ex: nota ${esc(p.exemplo)}</span>
        </div>`).join('');

    const secaoUnicoSuspeito = auditoriaClassTrib.cclassTribUnicoSuspeito
      ? `<div class="box alerta">🟡 Só <strong class="mono">${esc(auditoriaClassTrib.codigosUsados[0]?.code || '')}</strong> foi usado no período inteiro, apesar de ${auditoriaClassTrib.ncmsDistintos} NCMs distintos no catálogo — vale confirmar se o sistema do cliente classifica produto a produto ou aplica um valor fixo/padrão pra tudo. Cada código pode estar estruturalmente correto e ainda assim ser resultado de um cadastro que nunca foi de fato analisado.</div>`
      : '';

    const linhasResumo = auditoriaClassTrib.codigosUsados.map(c => `
      <tr>
        <td class="mono${c.naTabela ? '' : ' erro-txt'}">${esc(c.code)}</td>
        <td>${esc(c.nome)}</td>
        <td class="num">${c.naTabela ? `${c.redIBS}%` : '—'}</td>
        <td class="num">${c.naTabela ? `${c.redCBS}%` : '—'}</td>
        <td class="num">${c.itens}</td>
        <td class="num">${c.notas.size}</td>
        <td class="num">${moeda(c.valor)}</td>
        <td class="num">${moeda(c.vIBS + c.vCBS)}</td>
      </tr>`).join('');

    const secoesPorCodigo = auditoriaClassTrib.codigosUsados.map(c => {
      const produtos = (Array.from(c.produtos.values()) as ProdutoDoCodigo[]).sort((a, b) => b.valor - a.valor);
      const linhas = produtos.map(p => `
        <tr>
          <td>${esc(p.xProd)}</td>
          <td class="mono">${esc(p.ncm)}</td>
          <td class="num">${p.itens}</td>
          <td class="num">${moeda(p.valor)}</td>
          <td class="num">${moeda(p.vIbsCbs)}</td>
        </tr>`).join('');
      return `
        <div class="secao">
          <h2><span class="mono">${esc(c.code)}</span> — ${esc(c.nome)}</h2>
          <div class="meta">Redução IBS ${c.naTabela ? `${c.redIBS}%` : '—'} · Redução CBS ${c.naTabela ? `${c.redCBS}%` : '—'} · ${produtos.length} produto(s) distinto(s) · ${c.itens} item(ns) · ${moeda(c.valor)} em vendas</div>
          <table>
            <thead><tr><th>Produto (como consta no cadastro do cliente)</th><th>NCM</th><th class="num">Itens</th><th class="num">Valor</th><th class="num">IBS+CBS destacado</th></tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>`;
    }).join('');

    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<title>Laudo IBS-CBS ${esc(empresa)} ${esc(periodo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'IBM Plex Sans', sans-serif; color: #17150F; background: #fff; font-size: 11px; padding: 32px 40px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; }
  header { border-bottom: 2px solid #C9A227; padding-bottom: 14px; margin-bottom: 18px; }
  h1 { font-family: 'Newsreader', serif; font-size: 22px; font-weight: 600; }
  .empresa { font-size: 13px; font-weight: 700; margin-top: 8px; }
  .head-meta { color: #78736A; margin-top: 3px; }
  h2 { font-family: 'Newsreader', serif; font-size: 15px; font-weight: 600; border-left: 3px solid #C9A227; padding-left: 8px; margin: 0 0 4px; }
  .secao { margin-top: 22px; page-break-inside: avoid; }
  .meta { color: #78736A; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #A29C92; border-bottom: 1px solid #E5E0D6; padding: 4px 8px 4px 0; }
  th.num { text-align: right; }
  td { border-bottom: 1px solid #EFEBE3; padding: 3.5px 8px 3.5px 0; vertical-align: top; }
  tr.total td { border-top: 2px solid #E5E0D6; font-weight: 700; }
  .box { border-radius: 6px; padding: 8px 12px; margin: 6px 0; border: 1px solid; }
  .box.ok { background: #f2f8f2; border-color: #cde3cd; color: #2c6e2c; }
  .box.erro { background: #fdf2f2; border-color: #f0caca; color: #a33030; }
  .box.alerta { background: #fdf8ec; border-color: #ecdcae; color: #8a6d1a; }
  .erro-txt { color: #a33030; font-weight: 700; }
  .sub { opacity: 0.75; font-size: 10px; }
  footer { margin-top: 28px; border-top: 1px solid #E5E0D6; padding-top: 10px; color: #78736A; font-size: 10px; line-height: 1.5; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  @page { margin: 14mm; size: A4; }
</style></head><body>
<header>
  <h1>Laudo de Classificação Tributária — IBS/CBS</h1>
  <div class="empresa">${esc(empresa)}</div>
  <div class="head-meta">CNPJ ${esc(mainCnpj || '')} · Período: ${esc(periodo)} · Gerado em ${hoje} · Tabela oficial: ${esc(CCLASSTRIB_VERSAO)} (Portal Nacional da NF-e)</div>
</header>

<div class="secao">
  <h2>Resultado da verificação estrutural</h2>
  <div class="meta">${auditoriaClassTrib.totalItens} item(ns) em ${auditoriaClassTrib.totalNotas} nota(s) verificados — formato, prefixo CST, existência na tabela oficial, vigência, permissão pro modelo do documento e redução de alíquota.</div>
  ${secoesProblemas}
  ${secaoUnicoSuspeito}
</div>

<div class="secao">
  <h2>Resumo por código de classificação</h2>
  <table>
    <thead><tr><th>cClassTrib</th><th>Descrição oficial</th><th class="num">Red. IBS</th><th class="num">Red. CBS</th><th class="num">Itens</th><th class="num">Notas</th><th class="num">Valor (vProd)</th><th class="num">IBS+CBS destacado</th></tr></thead>
    <tbody>
      ${linhasResumo}
      <tr class="total"><td colspan="6" class="num">Total do período</td><td class="num">${moeda(auditoriaClassTrib.codigosUsados.reduce((s, c) => s + c.valor, 0))}</td><td class="num">${moeda(auditoriaClassTrib.totalIBS + auditoriaClassTrib.totalCBS)}</td></tr>
    </tbody>
  </table>
</div>

${secoesPorCodigo}

<footer>
  <strong>Metodologia e limites deste laudo.</strong> As checagens acima são estruturais e determinísticas — cada código do XML foi comparado com a Tabela de Classificação Tributária do IBS e da CBS (${esc(CCLASSTRIB_VERSAO)}, Portal Nacional da NF-e / Informe Técnico 2025.002). Os valores de IBS e CBS exibidos são os que o próprio sistema emissor do contribuinte calculou e destacou nos documentos (vIBS + vCBS); em 2026, período de teste da Reforma Tributária (EC 132/2023, LC 214/2025), esses valores são compensáveis e não representam recolhimento efetivo. <strong>Este laudo não avalia se o código atribuído a cada produto é o adequado</strong> — a lista de produtos por código existe justamente para que o analista identifique classificações que destoam do enquadramento esperado (Anexos da LC 214/2025) e providencie a correção no cadastro do sistema emissor. Documento gerado pelo Sequência Fiscal.
</footer>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    // Espera as fontes carregarem antes de abrir o diálogo de impressão
    if (win) win.onload = () => setTimeout(() => win.print(), 400);
  };

  // ——— Três auditorias aditivas (não alteram nenhum cálculo existente) ———

  // (1) Conferência aritmética do IBS/CBS: valor destacado bate com base ×
  // alíquota efetiva? vIBS = UF + Município? Totais da nota (IBSCBSTot) batem
  // com a soma dos itens? Pega emissor com fórmula/arredondamento errado —
  // barato de achar agora no ano-teste, caro de descobrir em 2027.
  const auditoriaIbsCbsAritmetica = useMemo(() => {
    type Diverg = { motivo: string; itens: number; notas: Set<string>; exemplo: string };
    const vazio = { itensVerificados: 0, notasVerificadas: 0, divergencias: [] as Diverg[] };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    const divergencias = new Map<string, Diverg>();
    const registrar = (motivo: string, xml: XmlData) => {
      let d = divergencias.get(motivo);
      if (!d) { d = { motivo, itens: 0, notas: new Set(), exemplo: `${xml.serie}/${xml.numero}` }; divergencias.set(motivo, d); }
      d.itens++;
      if (xml.chave) d.notas.add(xml.chave);
    };
    // ±R$ 0,011 de tolerância — arredondamento a 2 casas pode divergir 1 centavo
    const bate = (a: number, b: number) => Math.abs(a - b) <= 0.011;

    let itensVerificados = 0;
    const notasVerificadas = new Set<string>();

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      let somaVBC = 0, somaVIBS = 0, somaVCBS = 0, temItens = false;
      ex.dets.forEach(det => {
        if (!det.temGIbsCbs) return; // sem grupo padrão (ausente ou monofásico) — fora desta conferência
        itensVerificados++;
        temItens = true;
        if (xml.chave) notasVerificadas.add(xml.chave);
        const vBC = det.vBC ?? 0;
        somaVBC += vBC;
        // Alíquota efetiva: com gRed presente vale pAliqEfet; sem gRed, a cheia.
        const conferirParcela = (p: ParcelaIbsExtract | undefined, rotulo: string): number => {
          if (!p) return 0;
          const aliq = p.temRed ? p.aliqEfet : p.aliq;
          if (aliq != null && p.v != null && !bate(p.v, vBC * aliq / 100)) {
            registrar(`${rotulo}: valor destacado difere de base × alíquota efetiva`, xml);
          }
          return p.v ?? 0;
        };
        const vUF = conferirParcela(det.uf, 'IBS (UF)');
        const vMun = conferirParcela(det.mun, 'IBS (Município)');
        if (det.vIBS != null && !bate(det.vIBS, vUF + vMun)) registrar('vIBS do item difere de IBS UF + IBS Município', xml);
        somaVIBS += det.vIBS ?? 0;
        somaVCBS += conferirParcela(det.cbs, 'CBS');
      });
      if (!temItens) return;
      // Totais da nota — a NT define IBSCBSTot como somatório dos campos dos itens
      if (!ex.tot) { registrar('nota com itens IBS/CBS mas sem o grupo de totais (IBSCBSTot)', xml); return; }
      if (ex.tot.vBC != null && !bate(ex.tot.vBC, somaVBC)) registrar('total da base (vBCIBSCBS) difere da soma das bases dos itens', xml);
      if (ex.tot.vIBS != null && !bate(ex.tot.vIBS, somaVIBS)) registrar('total de IBS da nota difere da soma dos itens', xml);
      if (ex.tot.vCBS != null && !bate(ex.tot.vCBS, somaVCBS)) registrar('total de CBS da nota difere da soma dos itens', xml);
    });

    return {
      itensVerificados,
      notasVerificadas: notasVerificadas.size,
      divergencias: Array.from(divergencias.values()).sort((a, b) => b.itens - a.itens),
    };
  }, [xmlList, filterMes]);

  // (2) Linha do tempo de cadastro por cProd: o mesmo código interno de
  // produto mudou de NCM, CEST ou cClassTrib dentro do período? Compara o
  // produto com ele mesmo — zero interpretação de descrição. CFOP e CST de
  // ICMS ficam de fora de propósito: variam legitimamente por tipo de
  // operação/destino e gerariam falso positivo.
  const auditoriaCadastroProdutos = useMemo(() => {
    type NotaAmostra = { numero: string; serie: string; chave: string; data: string };
    type ValorVisto = { valor: string; primeira: string; ultima: string; itens: number; amostra: NotaAmostra[] };
    type Mudanca = { cProd: string; xProd: string; campo: string; valores: ValorVisto[] };
    const vazio = { totalProdutos: 0, mudancas: [] as Mudanca[] };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    const ordenadas = [...saidas].sort((a, b) => (a.data || '').localeCompare(b.data || ''));
    const registro = new Map<string, { xProd: string; campos: Record<string, Map<string, ValorVisto>> }>();

    ordenadas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      const dia = (xml.data || '').slice(0, 10);
      ex.dets.forEach(det => {
        const cProd = det.cProd;
        if (!cProd) return;
        let r = registro.get(cProd);
        if (!r) {
          r = { xProd: '', campos: { NCM: new Map(), CEST: new Map(), cClassTrib: new Map(), 'Nome do Produto': new Map(), 'Código de Barras (EAN)': new Map(), 'Benefício Fiscal': new Map() } };
          registro.set(cProd, r);
        }
        r.xProd = det.xProd || r.xProd;
        // Amostra de até 3 notas por valor — prova rápida (número/série/chave)
        // pra abrir o XML na hora, sem precisar caçar qual nota causou o quê.
        const anotar = (campo: string, valor: string) => {
          const v = r!.campos[campo].get(valor) ?? { valor, primeira: dia, ultima: dia, itens: 0, amostra: [] };
          v.itens++;
          v.ultima = dia;
          if (v.amostra.length < 3) {
            v.amostra.push({ numero: xml.numero || '', serie: xml.serie || '', chave: xml.chave || '', data: dia });
          }
          r!.campos[campo].set(valor, v);
        };
        anotar('NCM', det.ncm || '(vazio)');
        anotar('CEST', det.cest || '(vazio)');
        // Nome do produto trocando pro mesmo cProd é tão relevante quanto NCM —
        // costuma ser código reaproveitado pra outro produto, não só um typo.
        anotar('Nome do Produto', det.xProd || '(vazio)');
        // Código de barras trocando pro mesmo cProd é o mesmo alerta: produto
        // físico diferente usando o código interno de outro.
        anotar('Código de Barras (EAN)', det.cEan || '(vazio)');
        // Benefício fiscal quase sempre fica vazio (só existe quando o produto
        // tem incentivo/redução específica) — por isso o alerta real é quando
        // ele aparece, some ou muda de código no meio do período.
        anotar('Benefício Fiscal', det.cBenef || '(vazio)');
        // cClassTrib só é anotado quando o item TEM o grupo IBSCBS — nota
        // anterior à adoção do grupo não pode contar como "mudança de código".
        if (det.temIbsCbs) anotar('cClassTrib', det.cClassTrib || '(vazio)');
      });
    });

    const mudancas: Mudanca[] = [];
    registro.forEach((r, cProd) => {
      Object.entries(r.campos).forEach(([campo, m]) => {
        if (m.size > 1) {
          mudancas.push({
            cProd, xProd: r.xProd, campo,
            valores: Array.from(m.values()).sort((a, b) => a.primeira.localeCompare(b.primeira)),
          });
        }
      });
    });
    mudancas.sort((a, b) => a.cProd.localeCompare(b.cProd, undefined, { numeric: true }) || a.campo.localeCompare(b.campo));
    return { totalProdutos: registro.size, mudancas };
  }, [xmlList, filterMes]);

  // Exporta a lista COMPLETA de mudanças de cadastro — a tela tem rolagem
  // interna, mas nunca corta linha nenhuma; isso aqui é só pra ter em Excel
  // quando forem muitas mudanças de uma vez.
  const exportarMudancasCadastroExcel = () => {
    const formatarData = (d: string) => d.split('-').reverse().join('/');
    const formatarValor = (v: { valor: string; primeira: string; ultima: string; itens: number; amostra: { numero: string; serie: string; data: string }[] }) => {
      const amostra = v.amostra.map(a => `nº ${a.numero || '?'}${a.serie ? `/${a.serie}` : ''} (${formatarData(a.data)})`).join(', ');
      return `${v.valor} (${formatarData(v.primeira)} a ${formatarData(v.ultima)}, ${v.itens} item(ns)${amostra ? `, ex: ${amostra}` : ''})`;
    };

    // Uma linha por mudança (não por valor) — o "De → Para" fica junto na
    // mesma linha pra ficar claro que é uma comparação, não dados soltos.
    const aoa: (string | number)[][] = [
      ['cProd', 'Produto', 'Campo', 'Qtde de Valores no Período', 'Primeiro Valor', 'Data (1ª aparição)', 'Último Valor', 'Data (última aparição)', 'Detalhe Completo (De → Para)'],
    ];
    auditoriaCadastroProdutos.mudancas.forEach(m => {
      const primeiro = m.valores[0];
      const ultimo = m.valores[m.valores.length - 1];
      aoa.push([
        m.cProd, m.xProd, m.campo, m.valores.length,
        primeiro.valor, formatarData(primeiro.primeira),
        ultimo.valor, formatarData(ultimo.ultima),
        m.valores.map(formatarValor).join(' → '),
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 90 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mudancas Cadastro');

    // Segunda aba: mesmo nome de produto em cProd diferentes (inverso da
    // primeira aba) — formato de linha diferente, por isso fica separado.
    if (produtosSuspeitos.nomeDuplicado.length > 0) {
      const aoaNomes: (string | number)[][] = [
        ['Produto', 'Quantidade de Códigos Diferentes', 'cProd Usados (com amostra de nota)'],
      ];
      produtosSuspeitos.nomeDuplicado.forEach(p => {
        const detalhe = p.cProds
          .map(c => `${c.cProd} (nº ${c.amostra.numero || '?'}${c.amostra.serie ? `/${c.amostra.serie}` : ''}, ${formatarData(c.amostra.data)})`)
          .join(' | ');
        aoaNomes.push([p.xProd, p.cProds.length, detalhe]);
      });
      const wsNomes = XLSX.utils.aoa_to_sheet(aoaNomes);
      wsNomes['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(wb, wsNomes, 'Nomes Duplicados');
    }

    XLSX.writeFile(wb, nomeArquivoExport('mudancas_cadastro', 'xlsx'), { compression: true });
  };

  // (2b) Produtos suspeitos: duas checagens pontuais, mais estritas que a
  // linha do tempo de cadastro acima —
  //   1. NCM zerado (00000000) — cadastro claramente incompleto, não é uma
  //      classificação tributária válida.
  //   2. Mesmo cProd vendido ora com CFOP de "produção do estabelecimento"
  //      ora de "mercadoria adquirida ou recebida de terceiros" — ao
  //      contrário da checagem geral de CFOP (deixada de fora do item acima
  //      de propósito, porque CFOP varia legitimamente por operação), aqui
  //      o alvo é só essa inconsistência específica de origem da mercadoria,
  //      que costuma ser erro de cadastro (não variação legítima).
  const produtosSuspeitos = useMemo(() => {
    type NotaAmostra = { numero: string; serie: string; chave: string; data: string };
    type NcmZerado = { cProd: string; xProd: string; ocorrencias: number };
    type CfopMisto = { cProd: string; xProd: string; cfopsPropria: string[]; cfopsRevenda: string[] };
    type NomeDuplicado = { xProd: string; cProds: { cProd: string; amostra: NotaAmostra }[] };
    const vazio = { ncmZerado: [] as NcmZerado[], cfopMisto: [] as CfopMisto[], nomeDuplicado: [] as NomeDuplicado[] };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    const ncmZeradoMap = new Map<string, NcmZerado>();
    const cfopMistoMap = new Map<string, { xProd: string; propria: Set<string>; revenda: Set<string> }>();
    // Inverso do "mudanças de cadastro": lá é "mesmo cProd, valor mudou";
    // aqui é "mesmo nome, cProd diferente" — pode ser produto cadastrado em
    // duplicidade (fragmenta relatório/estoque) ou um código reaproveitado.
    // Chave do mapa interno é o cProd NORMALIZADO (sem zero à esquerda) — sem
    // isso, "24944" e "0000000024944" contam como dois códigos diferentes.
    // O valor guarda uma amostra (1 nota) de onde aquele cProd apareceu, pra
    // facilitar achar a nota sem precisar caçar no XML.
    const nomeParaCprods = new Map<string, Map<string, { cProd: string; amostra: NotaAmostra }>>();

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      const dia = (xml.data || '').slice(0, 10);
      ex.dets.forEach(det => {
        if (!det.cProd) return;

        if (det.ncm && /^0+$/.test(det.ncm)) {
          const r = ncmZeradoMap.get(det.cProd) || { cProd: det.cProd, xProd: det.xProd, ocorrencias: 0 };
          r.ocorrencias++;
          r.xProd = det.xProd || r.xProd;
          ncmZeradoMap.set(det.cProd, r);
        }

        const origem = classificarOrigemCfop(det.cfop);
        if (origem) {
          let r = cfopMistoMap.get(det.cProd);
          if (!r) {
            r = { xProd: det.xProd, propria: new Set(), revenda: new Set() };
            cfopMistoMap.set(det.cProd, r);
          }
          r.xProd = det.xProd || r.xProd;
          (origem === 'propria' ? r.propria : r.revenda).add(det.cfop);
        }

        if (det.xProd) {
          let m2 = nomeParaCprods.get(det.xProd);
          if (!m2) { m2 = new Map(); nomeParaCprods.set(det.xProd, m2); }
          const chave = normalizarCprod(det.cProd);
          if (!m2.has(chave)) {
            m2.set(chave, {
              cProd: det.cProd,
              amostra: { numero: xml.numero || '', serie: xml.serie || '', chave: xml.chave || '', data: dia },
            });
          }
        }
      });
    });

    const cfopMisto: CfopMisto[] = Array.from(cfopMistoMap.entries())
      .filter(([, r]) => r.propria.size > 0 && r.revenda.size > 0)
      .map(([cProd, r]) => ({
        cProd, xProd: r.xProd,
        cfopsPropria: Array.from(r.propria).sort(),
        cfopsRevenda: Array.from(r.revenda).sort(),
      }))
      .sort((a, b) => a.cProd.localeCompare(b.cProd, undefined, { numeric: true }));

    const nomeDuplicado: NomeDuplicado[] = Array.from(nomeParaCprods.entries())
      .filter(([, cprods]) => cprods.size > 1)
      .map(([xProd, cprods]) => ({
        xProd,
        cProds: Array.from(cprods.values()).sort((a, b) => a.cProd.localeCompare(b.cProd, undefined, { numeric: true })),
      }))
      .sort((a, b) => b.cProds.length - a.cProds.length || a.xProd.localeCompare(b.xProd));

    return {
      ncmZerado: Array.from(ncmZeradoMap.values()).sort((a, b) => b.ocorrencias - a.ocorrencias),
      cfopMisto,
      nomeDuplicado,
    };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Mapa Fiscal: raio-X consolidado do período — não calcula nada novo além
  // do ticket médio, só reúne números que já existem espalhados em outras
  // auditorias (faturamento, produtos distintos, % IBS/CBS, conformidade
  // cClassTrib, cadastros divergentes, produtos suspeitos) num resumo único.
  // Núcleo de agregação do Mapa Fiscal — roda tanto pro card resumo (um grupo
  // só) quanto pros comparativos por mês e por série (um grupo por chave).
  // Recebe as notas nfe do CNPJ principal, saída E entrada-própria juntas: a
  // saída alimenta faturamento/produtos/origem/presença; a entrada-própria
  // (tpNF=0) só entra pra achar devolução de venda (CFOP dedicado, ver
  // isCfopDevolucaoVenda) — o resto de entrada-própria (baixa de estoque etc.)
  // não conta em nenhuma métrica aqui.
  const calcularMapaFiscalAgregado = (notas: XmlData[]) => {
    let faturamento = 0, quantidadeNotas = 0, notasComGrupo = 0, notasNaoPresenciais = 0;
    let valorPropria = 0, valorRevenda = 0, valorST = 0;
    let valorDevolvido = 0, quantidadeDevolucoes = 0;
    const produtosSet = new Set<string>();

    notas.forEach(xml => {
      if (xml.tpNF === '0') {
        const ex = getNotaExtract(xml);
        if (!ex) return;
        let valorDevolucaoNota = 0;
        let temDevolucao = false;
        ex.dets.forEach(det => {
          if (isCfopDevolucaoVenda(det.cfop)) { valorDevolucaoNota += det.vProd; temDevolucao = true; }
        });
        if (temDevolucao) { valorDevolvido += valorDevolucaoNota; quantidadeDevolucoes++; }
        return;
      }

      faturamento += parseFloat(xml.valor || '0') || 0;
      quantidadeNotas++;

      const ex = getNotaExtract(xml);
      if (ex) {
        let temGrupo = false;
        ex.dets.forEach(det => {
          if (det.cProd) produtosSet.add(det.cProd);
          if (det.temIbsCbs) temGrupo = true;
          // Origem (própria/revenda) e ST são dimensões independentes — um
          // item pode ser própria+ST ou revenda+ST. Por isso os 3 % abaixo
          // não somam 100%: cada um é uma fatia isolada do faturamento,
          // igual "participação de ST" costuma ser reportado.
          const origem = classificarOrigemCfop(det.cfop);
          if (origem === 'propria') valorPropria += det.vProd;
          else if (origem === 'revenda') valorRevenda += det.vProd;
          if (cfopSujeitoAST(det.cfop)) valorST += det.vProd;
        });
        if (temGrupo) notasComGrupo++;
        // Mesmo critério da Auditoria de Pagamento: indPres vazio, "1"
        // (presencial) ou "5" (entrega a domicílio) conta como presencial;
        // qualquer outro (internet, teleatendimento etc.) é canal não presencial.
        const isPresencial = ex.indPres === '' || ex.indPres === '1' || ex.indPres === '5';
        if (!isPresencial) notasNaoPresenciais++;
      }
    });

    return {
      faturamento,
      quantidadeNotas,
      ticketMedio: quantidadeNotas > 0 ? faturamento / quantidadeNotas : 0,
      produtosDistintos: produtosSet.size,
      pctComGrupoIbsCbs: quantidadeNotas > 0 ? (notasComGrupo / quantidadeNotas) * 100 : 0,
      pctProducaoPropria: faturamento > 0 ? (valorPropria / faturamento) * 100 : 0,
      pctRevenda: faturamento > 0 ? (valorRevenda / faturamento) * 100 : 0,
      pctST: faturamento > 0 ? (valorST / faturamento) * 100 : 0,
      pctNaoPresencial: quantidadeNotas > 0 ? (notasNaoPresenciais / quantidadeNotas) * 100 : 0,
      valorDevolvido,
      quantidadeDevolucoes,
      pctDevolvido: faturamento > 0 ? (valorDevolvido / faturamento) * 100 : 0,
    };
  };

  const mapaFiscal = useMemo(() => {
    if (!mainCnpj) return null;
    const notasDoPeriodo = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    const saidas = notasDoPeriodo.filter(xml => xml.tpNF !== '0');
    if (saidas.length === 0) return null;
    const agregado = calcularMapaFiscalAgregado(notasDoPeriodo);

    return {
      faturamento: faturamentoTotal,
      quantidadeNotas: saidas.length,
      ticketMedio: faturamentoTotal / saidas.length,
      produtosDistintos: auditoriaCadastroProdutos.totalProdutos,
      pctComGrupoIbsCbs: auditoriaIbsCbs.totalNotas > 0 ? auditoriaIbsCbs.pctComGrupo : null,
      pctConformeCclasstrib: auditoriaClassTrib.totalItens > 0
        ? (auditoriaClassTrib.itensOk / auditoriaClassTrib.totalItens) * 100
        : null,
      cadastrosDivergentes: auditoriaCadastroProdutos.mudancas.length + produtosSuspeitos.nomeDuplicado.length,
      produtosSuspeitosTotal: produtosSuspeitos.ncmZerado.length + produtosSuspeitos.cfopMisto.length,
      pctNaoPresencial: agregado.pctNaoPresencial,
      pctDevolvido: agregado.pctDevolvido,
      valorDevolvido: agregado.valorDevolvido,
      quantidadeDevolucoes: agregado.quantidadeDevolucoes,
    };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas, faturamentoTotal, auditoriaCadastroProdutos, auditoriaIbsCbs, auditoriaClassTrib, produtosSuspeitos]);

  // Comparativo mensal: a mesma agregação do Mapa Fiscal, mas pra TODOS os
  // meses de uma vez (uma passada só por xmlList, sem depender do filterMes
  // atual) — é o que permite comparar os meses lado a lado com variação %.
  const mapaFiscalPorMes = useMemo(() => {
    if (!mainCnpj) return [];
    const porMes = new Map<string, XmlData[]>();

    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || xml.emitCnpj !== mainCnpj) return;
      if (!xml.protocolo) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      const mes = getMonthYear(xml.data);
      if (!mes) return;
      const lista = porMes.get(mes);
      if (lista) lista.push(xml); else porMes.set(mes, [xml]);
    });

    return Array.from(porMes.entries())
      .map(([mes, notas]) => ({ mes, ...calcularMapaFiscalAgregado(notas) }))
      .sort((a, b) => {
        const [nomeA, anoA] = a.mes.split('/');
        const [nomeB, anoB] = b.mes.split('/');
        const chaveA = `${anoA}${String(MESES.indexOf(nomeA)).padStart(2, '0')}`;
        const chaveB = `${anoB}${String(MESES.indexOf(nomeB)).padStart(2, '0')}`;
        return chaveA.localeCompare(chaveB);
      });
  }, [xmlList, mainCnpj, chavesCanceladas]);

  // Séries por mês: NÃO é um detalhamento rico (isso já vive no Comparativo
  // Mensal) — é só a contagem de notas de cada série (+ modelo, pra não
  // confundir série "1" do NF-e com série "1" da NFC-e) em cada mês, lado a
  // lado. Objetivo bem pontual: o analista bater o olho numa linha (uma
  // série) e notar que ela sumiu — ou é nova — no mês mais recente, algo que
  // some dentro de qualquer métrica agregada por mês.
  // Inclui SAÍDA e ENTRADA-própria (tpNF=0) — ao contrário do resto do Mapa
  // Fiscal, aqui não é sobre faturamento. Um cliente pode reservar uma série
  // inteira só pra devolução/transferência recebida (entrada própria); se
  // essa série fosse filtrada fora, ela sumiria da lista inteira (não só uma
  // célula), justamente o tipo de "sumiço" que essa tabela existe pra pegar.
  const matrizSeriePorMes = useMemo(() => {
    const vazio = { series: [] as string[], meses: [] as string[], matriz: new Map<string, Map<string, number>>() };
    if (!mainCnpj) return vazio;
    const seriesSet = new Set<string>();
    const mesesSet = new Set<string>();
    const matriz = new Map<string, Map<string, number>>();

    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || xml.emitCnpj !== mainCnpj) return;
      if (!xml.protocolo) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      const mes = getMonthYear(xml.data);
      if (!mes) return;
      const serie = `Série ${xml.serie || '?'}${xml.modelo ? ` (mod. ${xml.modelo})` : ''}`;
      seriesSet.add(serie);
      mesesSet.add(mes);
      let porMes = matriz.get(serie);
      if (!porMes) { porMes = new Map(); matriz.set(serie, porMes); }
      porMes.set(mes, (porMes.get(mes) || 0) + 1);
    });

    const meses = Array.from(mesesSet).sort((a, b) => {
      const [nomeA, anoA] = a.split('/');
      const [nomeB, anoB] = b.split('/');
      const chaveA = `${anoA}${String(MESES.indexOf(nomeA)).padStart(2, '0')}`;
      const chaveB = `${anoB}${String(MESES.indexOf(nomeB)).padStart(2, '0')}`;
      return chaveA.localeCompare(chaveB);
    });
    const series = Array.from(seriesSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return { series, meses, matriz };
  }, [xmlList, mainCnpj, chavesCanceladas]);

  // Ranking de Produtos: quem mais vende, e qual a origem de cada um (própria
  // vs revenda) — responde "quais produtos compõem a produção própria" e dá
  // um raio-X de gestão além do fiscal. Valor é a soma de vProd dos itens
  // (não o valor da nota), então pode divergir um pouco do faturamento
  // oficial quando há desconto/frete não rateado por item.
  // Núcleo do ranking, isolado pra poder rodar tanto no período filtrado
  // inteiro (rankingProdutos) quanto mês a mês (rankingProdutosPorMes) sem
  // duplicar a lógica de agregação.
  // Quantidade por unidade — nunca soma qCom cru: "5 KG + 3 UN" não é 8 de
  // nada. Se o produto só usa uma unidade, é um número limpo; se usa mais de
  // uma, cada unidade fica separada (front decide como mostrar isso).
  type QuantidadePorUnidade = { unidade: string; quantidade: number };
  type ProdutoRanking = { cProd: string; cProdsCount: number; xProd: string; valor: number; porUnidade: QuantidadePorUnidade[]; origem: 'propria' | 'revenda' | 'misto' | 'indefinida'; pct: number; pctAcumulado: number; classeAbc: 'A' | 'B' | 'C' };
  // agruparPorNome=false (padrão): uma linha por cProd — mostra cadastro
  // divergente (mesmo produto recadastrado com código novo) como linhas
  // separadas, útil pra auditoria. agruparPorNome=true: uma linha por nome
  // de produto, juntando todo cProd que caiu no mesmo nome — útil quando o
  // analista só quer o total por produto e não se importa com o código.
  const calcularRankingDeNotas = (notas: XmlData[], agruparPorNome: boolean): { produtos: ProdutoRanking[]; faturamentoConsiderado: number } => {
    type Acum = { cProds: Set<string>; xProd: string; valor: number; porUnidade: Map<string, number>; origemPropria: number; origemRevenda: number };
    const mapa = new Map<string, Acum>();
    const getOrCreate = (cProd: string, xProd: string) => {
      const key = agruparPorNome ? normalizarNomeProduto(xProd || cProd) : cProd;
      let p = mapa.get(key);
      if (!p) {
        p = { cProds: new Set([cProd]), xProd: xProd || '(sem descrição)', valor: 0, porUnidade: new Map(), origemPropria: 0, origemRevenda: 0 };
        mapa.set(key, p);
      } else {
        p.cProds.add(cProd);
      }
      return p;
    };
    notas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      if (xml.tpNF === '0') {
        // Entrada própria: só interessa devolução de venda, pra descontar do
        // produto que a originou — ranking fica líquido (venda − devolvido),
        // não bruto. Outra entrada própria (baixa de estoque etc.) fica fora.
        ex.dets.forEach(det => {
          if (!det.cProd || !isCfopDevolucaoVenda(det.cfop)) return;
          const p = getOrCreate(det.cProd, det.xProd);
          p.xProd = det.xProd || p.xProd;
          p.valor -= det.vProd;
          const unidade = det.uCom || '(sem unidade)';
          p.porUnidade.set(unidade, (p.porUnidade.get(unidade) || 0) - det.qCom);
        });
        return;
      }
      ex.dets.forEach(det => {
        if (!det.cProd) return;
        // CFOP que não é venda de verdade (transferência, remessa,
        // bonificação/doação/amostra, consignação, devolução de compra) fica
        // fora do ranking — conta no Total de Saídas geral (métrica
        // diferente), mas não é venda pro produto.
        if (!isCfopVenda(det.cfop)) return;
        const p = getOrCreate(det.cProd, det.xProd);
        p.xProd = det.xProd || p.xProd;
        p.valor += det.vProd;
        const unidade = det.uCom || '(sem unidade)';
        p.porUnidade.set(unidade, (p.porUnidade.get(unidade) || 0) + det.qCom);
        const origem = classificarOrigemCfop(det.cfop);
        if (origem === 'propria') p.origemPropria++;
        else if (origem === 'revenda') p.origemRevenda++;
      });
    });

    const faturamentoConsiderado = Array.from(mapa.values()).reduce((s, p) => s + p.valor, 0);

    const base = Array.from(mapa.values())
      .map(p => {
        const cProdsArr = Array.from(p.cProds).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return {
          cProd: cProdsArr.join(' / '), cProdsCount: cProdsArr.length, xProd: p.xProd, valor: p.valor,
          porUnidade: Array.from(p.porUnidade.entries())
            .map(([unidade, quantidade]) => ({ unidade, quantidade }))
            .sort((a, b) => b.quantidade - a.quantidade),
          origem: (p.origemPropria > 0 && p.origemRevenda > 0) ? 'misto' as const
            : p.origemPropria > 0 ? 'propria' as const
            : p.origemRevenda > 0 ? 'revenda' as const
            : 'indefinida' as const,
          pct: faturamentoConsiderado > 0 ? (p.valor / faturamentoConsiderado) * 100 : 0,
        };
      })
      .sort((a, b) => b.valor - a.valor);

    // Curva ABC (Pareto clássico): A = até 80% do faturamento acumulado,
    // B = até 95%, C = o resto — cada produto carrega o % acumulado até ele
    // na lista ordenada por valor, não o % individual.
    let acumulado = 0;
    const produtos: ProdutoRanking[] = base.map(p => {
      acumulado += p.pct;
      const classeAbc: 'A' | 'B' | 'C' = acumulado <= 80 ? 'A' : acumulado <= 95 ? 'B' : 'C';
      return { ...p, pctAcumulado: acumulado, classeAbc };
    });

    return { produtos, faturamentoConsiderado };
  };

  // "5 KG + 3 UN" nunca vira "8" — cada unidade fica separada; só junta as
  // parcelas num texto quando o produto genuinamente usa mais de uma.
  const formatarQuantidadePorUnidade = (porUnidade: QuantidadePorUnidade[]): string => {
    // != 0 (não > 0): produto com mais devolução do que venda no período fica
    // com quantidade líquida negativa — mostra isso em vez de escondida como "—".
    const comValor = porUnidade.filter(u => u.quantidade !== 0);
    if (comValor.length === 0) return '—';
    return comValor
      .map(u => `${u.quantidade.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${u.unidade}`)
      .join(' + ');
  };

  const rankingProdutos = useMemo(() => {
    const vazio = { produtos: [] as ProdutoRanking[], faturamentoConsiderado: 0 };
    if (!mainCnpj) return vazio;
    // Inclui entrada própria (tpNF=0) junto com a saída — calcularRankingDeNotas
    // usa a entrada só pra achar devolução de venda e descontar do produto,
    // deixando o ranking líquido em vez de bruto.
    const notas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (notas.length === 0) return vazio;
    return calcularRankingDeNotas(notas, agruparRankingPorNome);
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas, agruparRankingPorNome]);

  // Mesmo ranking, mas um por mês — só usado na exportação, pra quando
  // "Todos" está selecionado com 2+ meses: sem isso, o Excel soma tudo junto
  // e esconde se o produto mais vendido mudou de um mês pro outro.
  const rankingProdutosPorMes = useMemo(() => {
    type PorMes = Map<string, { produtos: ProdutoRanking[]; faturamentoConsiderado: number }>;
    if (!mainCnpj) return new Map() as PorMes;
    const porMes = new Map<string, XmlData[]>();
    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || xml.emitCnpj !== mainCnpj || !xml.rawXml) return;
      if (!xml.protocolo) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      const mes = getMonthYear(xml.data);
      if (!mes) return;
      const lista = porMes.get(mes);
      if (lista) lista.push(xml); else porMes.set(mes, [xml]);
    });
    const resultado = new Map<string, { produtos: ProdutoRanking[]; faturamentoConsiderado: number }>();
    porMes.forEach((notas, mes) => resultado.set(mes, calcularRankingDeNotas(notas, agruparRankingPorNome)));
    return resultado;
  }, [xmlList, mainCnpj, chavesCanceladas, agruparRankingPorNome]);

  // Perfil de Clientes: quem compra da empresa via NF-e (mod 55) — NFC-e fica
  // de fora de propósito, porque o destinatário quase nunca tem CNPJ (venda a
  // consumidor final), então não há "cliente" pra perfilar, só volume agregado
  // (isso já existe na Sazonalidade). Só considera saída (tpNF=1): entrada
  // própria (devolução recebida) não representa uma compra do cliente, fica
  // fora do perfil por simplicidade — é um fluxo de retorno, não de venda.
  // Valor por cliente soma det.vProd dos itens com CFOP de venda (mesmo
  // critério do Ranking de Produtos), não o vNF da nota — uma nota com item
  // de frete/não-venda misturado não infla o total do cliente.
  type ClientePerfilProduto = { xProd: string; valor: number };
  type ClientePerfilMes = { mes: string; valor: number; quantidade: number };
  type ClientePerfil = {
    cnpj: string; nome: string; quantidadeNotas: number; totalComprado: number;
    ticketMedio: number; primeiraCompra: string; ultimaCompra: string;
    produtos: ClientePerfilProduto[]; porMes: ClientePerfilMes[];
  };
  const perfilClientes = useMemo(() => {
    const vazio: { clientes: ClientePerfil[]; totalConsiderado: number } = { clientes: [], totalConsiderado: 0 };
    if (!mainCnpj) return vazio;
    type Acum = {
      nome: string; quantidadeNotas: number; totalComprado: number;
      primeiraCompra: string; ultimaCompra: string;
      produtos: Map<string, { xProd: string; valor: number }>;
      porMes: Map<string, { valor: number; quantidade: number }>;
    };
    const mapa = new Map<string, Acum>();
    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || xml.emitCnpj !== mainCnpj || xml.modelo !== '55' || xml.tpNF !== '1') return;
      if (!xml.rawXml || !xml.protocolo || !xml.destCnpj) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return;
      const ex = getNotaExtract(xml);
      if (!ex) return;
      let valorNota = 0;
      const produtosDaNota: { cProd: string; xProd: string; valor: number }[] = [];
      ex.dets.forEach(det => {
        if (!det.cProd || !isCfopVenda(det.cfop)) return;
        valorNota += det.vProd;
        produtosDaNota.push({ cProd: det.cProd, xProd: det.xProd, valor: det.vProd });
      });
      if (valorNota <= 0) return; // nota sem nenhum item de venda de verdade

      let c = mapa.get(xml.destCnpj);
      if (!c) {
        c = { nome: xml.destNome || '(sem nome)', quantidadeNotas: 0, totalComprado: 0, primeiraCompra: xml.data || '', ultimaCompra: xml.data || '', produtos: new Map(), porMes: new Map() };
        mapa.set(xml.destCnpj, c);
      }
      if (xml.destNome) c.nome = xml.destNome;
      c.quantidadeNotas++;
      c.totalComprado += valorNota;
      if (xml.data && (!c.primeiraCompra || xml.data < c.primeiraCompra)) c.primeiraCompra = xml.data;
      if (xml.data && (!c.ultimaCompra || xml.data > c.ultimaCompra)) c.ultimaCompra = xml.data;
      produtosDaNota.forEach(p => {
        const existente = c!.produtos.get(p.cProd);
        if (existente) existente.valor += p.valor;
        else c!.produtos.set(p.cProd, { xProd: p.xProd || '(sem descrição)', valor: p.valor });
      });
      const chavePeriodo = (xml.data || '').slice(0, 7); // "2026-07", sortável direto como string
      if (chavePeriodo.length === 7) {
        const m = c.porMes.get(chavePeriodo);
        if (m) { m.valor += valorNota; m.quantidade++; }
        else c.porMes.set(chavePeriodo, { valor: valorNota, quantidade: 1 });
      }
    });

    const totalConsiderado = Array.from(mapa.values()).reduce((s, c) => s + c.totalComprado, 0);
    const clientes: ClientePerfil[] = Array.from(mapa.entries())
      .map(([cnpj, c]) => ({
        cnpj, nome: c.nome, quantidadeNotas: c.quantidadeNotas, totalComprado: c.totalComprado,
        ticketMedio: c.quantidadeNotas > 0 ? c.totalComprado / c.quantidadeNotas : 0,
        primeiraCompra: c.primeiraCompra, ultimaCompra: c.ultimaCompra,
        produtos: Array.from(c.produtos.values())
          .sort((a, b) => b.valor - a.valor)
          .slice(0, 5),
        porMes: Array.from(c.porMes.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([chave, m]) => ({ mes: getMonthYear(chave), valor: m.valor, quantidade: m.quantidade })),
      }))
      .sort((a, b) => b.totalComprado - a.totalComprado);

    // Se não achou nenhum cliente de NF-e mas a empresa TEM saída de NFC-e no
    // período, o card não deve simplesmente sumir sem explicação — o analista
    // vê "cadê o Perfil de Clientes?" e acha que quebrou (já aconteceu). Esse
    // sinal deixa a tela mostrar "normal, essa empresa vende só a consumidor"
    // em vez de só esconder o card calado.
    const vendeSoPorNfce = clientes.length === 0 && xmlList.some(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.modelo === '65' && xml.tpNF === '1' &&
      xml.rawXml && xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );

    return { clientes, totalConsiderado, vendeSoPorNfce };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Perfil de Fornecedores: espelho do Perfil de Clientes, mas pra NF-e de
  // ENTRADA (quem vende PRA empresa auditada, não quem compra dela). Essas
  // notas já são extraídas com dets/cfopValores iguais a qualquer outra — só
  // nunca tinham um lugar próprio pra virar perfil, ficavam só contadas em
  // "fornecedorEntradaInfo" (aviso informativo) sem detalhe nenhum.
  // Importante pra Reforma Tributária: o crédito de IBS/CBS que a empresa
  // consegue aproveitar depende do REGIME do fornecedor — por isso cada
  // fornecedor aqui já traz o CRT declarado por ELE MESMO na própria nota
  // (emit/CRT), sem precisar de nenhuma consulta externa; a consulta à
  // Receita (BrasilAPI) continua disponível como complemento, igual no
  // Perfil de Clientes.
  // totalIcmsDestacado/totalIbsDestacado: soma do vICMS/vIBS declarado item a
  // item nas notas de entrada — é a base do crédito que a empresa pode
  // aproveitar (ICMS hoje; IBS/CBS quando o fornecedor já adaptar o sistema
  // na fase de teste da Reforma). Não é o crédito EFETIVO (isso depende do
  // regime da própria empresa auditada — Simples normalmente não aproveita
  // crédito de ICMS, por exemplo), só o que está destacado na nota.
  type FornecedorPerfil = ClientePerfil & { crtDeclarado: string; crtDeclaradoLabel: string; totalIcmsDestacado: number; totalIbsDestacado: number; sinalIcmsFora: string };
  const perfilFornecedores = useMemo(() => {
    const vazio: { fornecedores: FornecedorPerfil[]; totalConsiderado: number } = { fornecedores: [], totalConsiderado: 0 };
    if (!mainCnpj) return vazio;
    type AcumFornecedor = {
      nome: string; quantidadeNotas: number; totalComprado: number;
      primeiraCompra: string; ultimaCompra: string;
      produtos: Map<string, { xProd: string; valor: number }>;
      porMes: Map<string, { valor: number; quantidade: number }>;
      crtDeclarado: string; crtData: string; // crt da nota mais recente vista até agora
      totalIcmsDestacado: number; totalIbsDestacado: number;
      // sinais de ICMS fora do DAS declarados pelo próprio emitente (nunca inferidos de ausência de ICMS):
      // CRT 2 (Simples com excesso de sublimite) ou ICMS destacado por CST em emitente do Simples (CRT 1/2)
      sinalCrt2: boolean; sinalCst: boolean;
    };
    const mapa = new Map<string, AcumFornecedor>();
    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || xml.destCnpj !== mainCnpj || !xml.emitCnpj || xml.emitCnpj === mainCnpj) return;
      if (!xml.rawXml || !xml.protocolo) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return;
      const ex = getNotaExtract(xml);
      if (!ex) return;
      let valorNota = 0;
      let icmsNota = 0;
      let ibsNota = 0;
      let cstTributado = false;
      const produtosDaNota: { cProd: string; xProd: string; valor: number }[] = [];
      ex.dets.forEach(det => {
        if (!det.cProd) return;
        valorNota += det.vProd;
        icmsNota += det.vICMS || 0;
        ibsNota += det.vIBS || 0;
        if (det.icmsTemCst && (det.vICMS || 0) > 0 && (ex.crt === '1' || ex.crt === '2')) cstTributado = true;
        produtosDaNota.push({ cProd: det.cProd, xProd: det.xProd, valor: det.vProd });
      });
      if (valorNota <= 0) return;

      let f = mapa.get(xml.emitCnpj);
      if (!f) {
        f = { nome: xml.emitNome || '(sem nome)', quantidadeNotas: 0, totalComprado: 0, primeiraCompra: xml.data || '', ultimaCompra: xml.data || '', produtos: new Map(), porMes: new Map(), crtDeclarado: '', crtData: '', totalIcmsDestacado: 0, totalIbsDestacado: 0, sinalCrt2: false, sinalCst: false };
        mapa.set(xml.emitCnpj, f);
      }
      if (xml.emitNome) f.nome = xml.emitNome;
      f.quantidadeNotas++;
      f.totalComprado += valorNota;
      f.totalIcmsDestacado += icmsNota;
      f.totalIbsDestacado += ibsNota;
      if (ex.crt === '2') f.sinalCrt2 = true;
      if (cstTributado) f.sinalCst = true;
      if (xml.data && (!f.primeiraCompra || xml.data < f.primeiraCompra)) f.primeiraCompra = xml.data;
      if (xml.data && (!f.ultimaCompra || xml.data > f.ultimaCompra)) f.ultimaCompra = xml.data;
      // Mantém o CRT da nota mais RECENTE — regime declarado hoje importa
      // mais que o de uma nota antiga, caso o fornecedor tenha mudado.
      if (ex.crt && xml.data && (!f.crtData || xml.data > f.crtData)) { f.crtDeclarado = ex.crt; f.crtData = xml.data; }
      produtosDaNota.forEach(p => {
        const existente = f!.produtos.get(p.cProd);
        if (existente) existente.valor += p.valor;
        else f!.produtos.set(p.cProd, { xProd: p.xProd || '(sem descrição)', valor: p.valor });
      });
      const chavePeriodo = (xml.data || '').slice(0, 7);
      if (chavePeriodo.length === 7) {
        const m = f.porMes.get(chavePeriodo);
        if (m) { m.valor += valorNota; m.quantidade++; }
        else f.porMes.set(chavePeriodo, { valor: valorNota, quantidade: 1 });
      }
    });

    const totalConsiderado = Array.from(mapa.values()).reduce((s, f) => s + f.totalComprado, 0);
    const fornecedores: FornecedorPerfil[] = Array.from(mapa.entries())
      .map(([cnpj, f]) => ({
        cnpj, nome: f.nome, quantidadeNotas: f.quantidadeNotas, totalComprado: f.totalComprado,
        ticketMedio: f.quantidadeNotas > 0 ? f.totalComprado / f.quantidadeNotas : 0,
        primeiraCompra: f.primeiraCompra, ultimaCompra: f.ultimaCompra,
        crtDeclarado: f.crtDeclarado, crtDeclaradoLabel: crtLabel[f.crtDeclarado] || (f.crtDeclarado ? `CRT ${f.crtDeclarado}` : '—'),
        totalIcmsDestacado: f.totalIcmsDestacado, totalIbsDestacado: f.totalIbsDestacado, sinalIcmsFora: f.sinalCrt2 ? 'crt2' : f.sinalCst ? 'cst' : '',
        produtos: Array.from(f.produtos.values())
          .sort((a, b) => b.valor - a.valor)
          .slice(0, 5),
        porMes: Array.from(f.porMes.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([chave, m]) => ({ mes: getMonthYear(chave), valor: m.valor, quantidade: m.quantidade })),
      }))
      .sort((a, b) => b.totalComprado - a.totalComprado);

    return { fornecedores, totalConsiderado };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Mix de alíquotas de IBS/CBS lido do grupo <IBSCBS> de cada item das notas
  // (saídas da empresa e entradas de fornecedor): quanto do valor está em
  // tributação integral, reduzida, zero (ex.: cesta básica, Anexo I da LC
  // 214/2025) ou fora de incidência. Só código × tabela oficial — o app NUNCA
  // interpreta nome de produto/NCM. Item sem o grupo (sistema não adaptado,
  // ou Simples antes de 2027) conta como alíquota cheia e entra na cobertura,
  // pra quem lê saber o quanto do mix é dado e o quanto é suposição. "fator"
  // = média ponderada de (1 − redução) sobre o valor; a redução de IBS e CBS
  // é ponderada pelo peso de cada um na alíquota de referência (CBS 8,8 +
  // IBS 17,7), que na prática é igual nos dois.
  type MixLado = {
    total: number; comGrupo: number; coberturaPct: number; fator: number;
    porCodigo: { code: string; nome: string; efeito: string; valor: number }[];
    porMes: { mes: string; pct: number }[];
    // maiores produtos vendidos e o cClassTrib que o emissor usa neles (o dominante por valor); só no lado das saídas
    topProdutos: { xProd: string; valor: number; code: string; nome: string; efeito: string; nCodigos: number }[];
  };
  const mixAliquotas = useMemo(() => {
    const lado = () => ({ total: 0, comGrupo: 0, somaFator: 0, codigos: new Map<string, { nome: string; efeito: string; valor: number }>(), meses: new Map<string, { total: number; comGrupo: number }>(), produtos: new Map<string, { xProd: string; valor: number; codigos: Map<string, number> }>() });
    const acum = { saidas: lado(), entradas: lado() };
    if (!mainCnpj) {
      const vazio: MixLado = { total: 0, comGrupo: 0, coberturaPct: 0, fator: 1, porCodigo: [], porMes: [], topProdutos: [] };
      return { saidas: vazio, entradas: vazio };
    }
    const PESO_IBS = 17.7 / 26.5;
    xmlList.forEach(xml => {
      if (xml.tipo !== 'nfe' || !xml.rawXml || !xml.protocolo) return;
      if (xml.chave && chavesCanceladas.has(xml.chave)) return;
      if (filterMes !== 'Todos' && getMonthYear(xml.data) !== filterMes) return;
      let a: ReturnType<typeof lado> | null = null;
      if (xml.emitCnpj === mainCnpj && xml.tpNF !== '0') a = acum.saidas;
      else if (xml.destCnpj === mainCnpj && xml.emitCnpj && xml.emitCnpj !== mainCnpj) a = acum.entradas;
      if (!a) return;
      const ex = getNotaExtract(xml);
      if (!ex) return;
      ex.dets.forEach(det => {
        const v = det.vProd;
        if (!(v > 0)) return;
        a!.total += v;
        const mesChave = (xml.data || '').slice(0, 7);
        const mm = a!.meses.get(mesChave) || { total: 0, comGrupo: 0 };
        mm.total += v;
        if (det.temIbsCbs) mm.comGrupo += v;
        a!.meses.set(mesChave, mm);
        if (a === acum.saidas) {
          const pk = det.cProd || det.xProd || '(sem código)';
          const pr = a.produtos.get(pk) || { xProd: det.xProd || '(sem descrição)', valor: 0, codigos: new Map<string, number>() };
          const ck = det.temIbsCbs ? (det.cClassTrib || '(sem cClassTrib)') : 'sem-grupo';
          pr.valor += v;
          pr.codigos.set(ck, (pr.codigos.get(ck) || 0) + v);
          a.produtos.set(pk, pr);
        }
        if (!det.temIbsCbs) {
          a!.somaFator += v;
          const sem = a!.codigos.get('sem-grupo') || { nome: 'Item sem o grupo IBS/CBS (assumido em alíquota cheia)', efeito: 'Integral (suposição)', valor: 0 };
          sem.valor += v; a!.codigos.set('sem-grupo', sem);
          return;
        }
        a!.comGrupo += v;
        const ent = CCLASSTRIB_TABELA[det.cClassTrib];
        const cst = det.ibsCst || '';
        let f = 1;
        let efeito = 'Integral';
        if (cst.startsWith('4')) { f = 0; efeito = 'Fora de incidência / isento'; }
        else if (ent) {
          const red = ent.redIBS * PESO_IBS + ent.redCBS * (1 - PESO_IBS);
          f = 1 - red / 100;
          efeito = f <= 0.0001 ? 'Alíquota zero' : f < 0.9999 ? `Reduzida (${(red).toFixed(0)}% de redução)` : 'Integral';
        }
        a!.somaFator += v * f;
        const chave = det.cClassTrib || '(sem cClassTrib)';
        const c = a!.codigos.get(chave) || { nome: ent ? ent.nome : '(código fora da tabela oficial)', efeito, valor: 0 };
        c.valor += v; a!.codigos.set(chave, c);
      });
    });
    const fecha = (a: ReturnType<typeof lado>): MixLado => ({
      total: a.total, comGrupo: a.comGrupo,
      coberturaPct: a.total > 0 ? (a.comGrupo / a.total) * 100 : 0,
      fator: a.total > 0 ? a.somaFator / a.total : 1,
      porCodigo: Array.from(a.codigos.entries()).map(([code, c]) => ({ code, ...c })).sort((x, y) => y.valor - x.valor),
      porMes: Array.from(a.meses.entries())
        .filter(([chave]) => chave.length === 7)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([chave, m]) => ({ mes: getMonthYear(chave), pct: m.total > 0 ? (m.comGrupo / m.total) * 100 : 0 })),
      topProdutos: Array.from(a.produtos.values())
        .sort((x, y) => y.valor - x.valor)
        .slice(0, 15)
        .map(p => {
          const code = Array.from(p.codigos.entries()).sort((x, y) => y[1] - x[1])[0]?.[0] || 'sem-grupo';
          const cod = a.codigos.get(code);
          return { xProd: p.xProd, valor: p.valor, code, nome: cod ? cod.nome : '', efeito: cod ? cod.efeito : 'Integral (suposição)', nCodigos: p.codigos.size };
        }),
    });
    return { saidas: fecha(acum.saidas), entradas: fecha(acum.entradas) };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  // Exporta o ranking respeitando o filtro de origem selecionado na tela (se
  // estiver em "Todos", exporta todos) — a tela só desenha os 20 primeiros,
  // isso aqui exporta a lista inteira, útil quando o catálogo é grande.
  const exportarRankingProdutosExcel = () => {
    const origemLabelExport: Record<string, string> = { propria: 'Produção própria', revenda: 'Revenda', misto: 'Misto', indefinida: 'Indefinida' };
    const aplicarFiltro = (produtos: ProdutoRanking[]) =>
      filtroOrigemRanking === 'todos' ? produtos : produtos.filter(p => p.origem === filtroOrigemRanking);

    const montarAba = (produtos: ProdutoRanking[]) => {
      const linhas = aplicarFiltro(produtos);
      const aoa: (string | number)[][] = [
        ['#', 'Produto', 'cProd', 'Origem', 'Quantidade', 'Valor (vProd)', '% do Total', '% Acumulado', 'Curva ABC'],
      ];
      linhas.forEach((p, i) => {
        // Quantidade some como texto de propósito — "5 KG + 3 UN" não é uma
        // soma válida, então não faz sentido fingir que é um número só.
        aoa.push([i + 1, p.xProd, p.cProd, origemLabelExport[p.origem], formatarQuantidadePorUnidade(p.porUnidade), p.valor, Math.round(p.pct * 10) / 10, Math.round(p.pctAcumulado * 10) / 10, p.classeAbc]);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 5 }, { wch: 36 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 10 }];
      // Formato de milhar com vírgula decimal (padrão BR) nas colunas de
      // valor e %, senão sai "44992,47" sem separador de milhar.
      for (let linha = 0; linha < linhas.length; linha++) {
        const celValor = XLSX.utils.encode_cell({ r: linha + 1, c: 5 });
        if (ws[celValor]) ws[celValor].z = '#,##0.00';
        const celPct = XLSX.utils.encode_cell({ r: linha + 1, c: 6 });
        if (ws[celPct]) ws[celPct].z = '#,##0.0';
        const celPctAcum = XLSX.utils.encode_cell({ r: linha + 1, c: 7 });
        if (ws[celPctAcum]) ws[celPctAcum].z = '#,##0.0';
      }
      return ws;
    };

    const wb = XLSX.utils.book_new();

    // "Todos" com 2+ meses no lote: uma aba por mês (pra dar pra comparar se
    // o produto mais vendido mudou), mais uma aba "Total" com tudo somado —
    // sem isso, o Excel escondia justamente essa diferença mês a mês.
    if (filterMes === 'Todos' && rankingProdutosPorMes.size >= 2) {
      const mesesOrdenados: string[] = Array.from(rankingProdutosPorMes.keys() as IterableIterator<string>).sort((a: string, b: string) => {
        const [nomeA, anoA] = a.split('/');
        const [nomeB, anoB] = b.split('/');
        const chaveA = `${anoA}${String(MESES.indexOf(nomeA)).padStart(2, '0')}`;
        const chaveB = `${anoB}${String(MESES.indexOf(nomeB)).padStart(2, '0')}`;
        return chaveA.localeCompare(chaveB);
      });
      mesesOrdenados.forEach(mes => {
        const dados = rankingProdutosPorMes.get(mes);
        if (!dados) return;
        // "/" não é permitido em nome de aba do Excel.
        const nomeAba = mes.replace('/', ' ').slice(0, 31);
        XLSX.utils.book_append_sheet(wb, montarAba(dados.produtos), nomeAba);
      });
      XLSX.utils.book_append_sheet(wb, montarAba(rankingProdutos.produtos), 'Total (Todos os Meses)'.slice(0, 31));
    } else {
      XLSX.utils.book_append_sheet(wb, montarAba(rankingProdutos.produtos), 'Ranking Produtos');
    }

    XLSX.writeFile(wb, nomeArquivoExport('ranking_produtos', 'xlsx'), { compression: true });
  };

  // Top NCMs: qual categoria fiscal mais fatura no período — concentração de
  // faturamento por NCM ajuda a enxergar risco de ST/IBS-CBS por categoria,
  // não só por produto isolado. xProdAmostra é só um produto real daquele
  // NCM, pra dar contexto — o NCM sozinho (8 dígitos) não diz muita coisa.
  type NcmRanking = { ncm: string; xProdAmostra: string; valor: number; produtosDistintos: number; pct: number };
  const rankingNcm = useMemo(() => {
    const vazio = { ncms: [] as NcmRanking[], faturamentoConsiderado: 0 };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;

    type Acum = { ncm: string; xProdAmostra: string; valor: number; produtos: Set<string> };
    const mapa = new Map<string, Acum>();
    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      ex.dets.forEach(det => {
        if (!isCfopVenda(det.cfop)) return;
        const ncm = det.ncm || '(vazio)';
        let a = mapa.get(ncm);
        if (!a) { a = { ncm, xProdAmostra: det.xProd || '(sem descrição)', valor: 0, produtos: new Set() }; mapa.set(ncm, a); }
        a.valor += det.vProd;
        if (det.cProd) a.produtos.add(det.cProd);
      });
    });

    const faturamentoConsiderado = Array.from(mapa.values()).reduce((s, a) => s + a.valor, 0);
    const ncms: NcmRanking[] = Array.from(mapa.values())
      .map(a => ({
        ncm: a.ncm, xProdAmostra: a.xProdAmostra, valor: a.valor,
        produtosDistintos: a.produtos.size,
        pct: faturamentoConsiderado > 0 ? (a.valor / faturamentoConsiderado) * 100 : 0,
      }))
      .sort((a, b) => b.valor - a.valor);

    return { ncms, faturamentoConsiderado };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  const exportarRankingNcmExcel = () => {
    const aoa: (string | number)[][] = [
      ['#', 'NCM', 'Produto (amostra)', 'Produtos Distintos', 'Valor', '% do Total'],
    ];
    rankingNcm.ncms.forEach((n, i) => {
      aoa.push([i + 1, n.ncm, n.xProdAmostra, n.produtosDistintos, n.valor, Math.round(n.pct * 10) / 10]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 36 }, { wch: 16 }, { wch: 14 }, { wch: 10 }];
    for (let linha = 0; linha < rankingNcm.ncms.length; linha++) {
      const celValor = XLSX.utils.encode_cell({ r: linha + 1, c: 4 });
      if (ws[celValor]) ws[celValor].z = '#,##0.00';
      const celPct = XLSX.utils.encode_cell({ r: linha + 1, c: 5 });
      if (ws[celPct]) ws[celPct].z = '#,##0.0';
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Top NCMs');
    XLSX.writeFile(wb, nomeArquivoExport('ranking_ncm', 'xlsx'), { compression: true });
  };

  // Sazonalidade: em que dia da semana e em que horário o faturamento (e o
  // volume de notas) se concentra — direto pra decisão de escala/produção,
  // sem precisar abrir nota por nota. Hora vem direto da string do dhEmi
  // (posições 11-12, "HH"), sem passar por Date — já é o horário local do
  // emitente, não precisa (e não deve) converter fuso.
  const sazonalidade = useMemo(() => {
    const vazio = {
      porDiaSemana: [] as { dia: string; faturamento: number; quantidadeNotas: number; pct: number }[],
      porHora: [] as { hora: number; faturamento: number; quantidadeNotas: number; pct: number }[],
      porDiaEHora: [] as { dia: string; horas: { hora: number; faturamento: number; quantidadeNotas: number; pct: number }[] }[],
    };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes) &&
      (!sazonalidadeSomenteNfce || xml.modelo === '65')
    );
    if (saidas.length === 0) return vazio;

    const acumDia = Array.from({ length: 7 }, () => ({ faturamento: 0, quantidadeNotas: 0 }));
    const acumHora = Array.from({ length: 24 }, () => ({ faturamento: 0, quantidadeNotas: 0 }));
    // Cruzamento dia × horário — pra responder "nas sextas, em que horário
    // concentra?" em vez de só ver a média de todos os dias juntos.
    const acumDiaHora = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ faturamento: 0, quantidadeNotas: 0 })));

    saidas.forEach(xml => {
      const dataStr = xml.data || '';
      if (dataStr.length < 10) return;
      const valorNota = parseFloat(xml.valor || '0') || 0;

      // Mesmo rateio proporcional por CFOP do "Totais por Natureza da Operação"
      // (xml.cfopValores) — só que aqui só soma a fatia que É venda de verdade
      // (isCfopVenda), pra transferência/baixa de estoque/devolução de compra
      // não inflar o pico de horário/dia como se fosse venda. Sem CFOP
      // identificável (raro), assume venda — mesmo critério do isSaidaVenda
      // em auditoriaPagamento.
      const itens: Record<string, number> = xml.cfopValores || {};
      const totalItens = Object.values(itens).reduce((s, v) => s + v, 0);
      const valorVenda = totalItens > 0
        ? valorNota * (Object.entries(itens).reduce((s, [cfop, v]) => s + (isCfopVenda(cfop) ? v : 0), 0) / totalItens)
        : valorNota;
      if (valorVenda <= 0.005) return;

      const dia = diaDaSemana(dataStr.slice(0, 10));
      acumDia[dia].faturamento += valorVenda;
      acumDia[dia].quantidadeNotas++;

      const hora = parseInt(dataStr.slice(11, 13), 10);
      if (!isNaN(hora) && hora >= 0 && hora < 24) {
        acumHora[hora].faturamento += valorVenda;
        acumHora[hora].quantidadeNotas++;
        acumDiaHora[dia][hora].faturamento += valorVenda;
        acumDiaHora[dia][hora].quantidadeNotas++;
      }
    });

    const totalDia = acumDia.reduce((s, a) => s + a.faturamento, 0);
    const totalHora = acumHora.reduce((s, a) => s + a.faturamento, 0);

    return {
      porDiaSemana: acumDia.map((a, i) => ({ dia: DIAS_SEMANA[i], ...a, pct: totalDia > 0 ? (a.faturamento / totalDia) * 100 : 0 })),
      porHora: acumHora.map((a, i) => ({ hora: i, ...a, pct: totalHora > 0 ? (a.faturamento / totalHora) * 100 : 0 })),
      porDiaEHora: acumDiaHora.map((horasDoDia, i) => {
        const totalDoDia = horasDoDia.reduce((s, h) => s + h.faturamento, 0);
        return {
          dia: DIAS_SEMANA[i],
          horas: horasDoDia.map((h, hi) => ({ hora: hi, ...h, pct: totalDoDia > 0 ? (h.faturamento / totalDoDia) * 100 : 0 })),
        };
      }),
    };
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas, sazonalidadeSomenteNfce]);

  // Devoluções: produto a produto, quem mais volta — os totais (valor, %,
  // quantidade de notas) já vêm prontos de mapaFiscal (mesma agregação,
  // única fonte da verdade pro card resumo e pro comparativo); isso aqui é só
  // o detalhamento por produto, que exige abrir item a item.
  type ProdutoDevolvido = { cProd: string; xProd: string; valor: number; porUnidade: QuantidadePorUnidade[]; pct: number };
  const devolucoesProdutos = useMemo(() => {
    if (!mainCnpj) return [] as ProdutoDevolvido[];
    const entradasProprias = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF === '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (entradasProprias.length === 0) return [];

    type Acum = { cProd: string; xProd: string; valor: number; porUnidade: Map<string, number> };
    const mapa = new Map<string, Acum>();
    let valorTotal = 0;

    entradasProprias.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      ex.dets.forEach(det => {
        if (!isCfopDevolucaoVenda(det.cfop) || !det.cProd) return;
        valorTotal += det.vProd;
        let p = mapa.get(det.cProd);
        if (!p) { p = { cProd: det.cProd, xProd: det.xProd || '(sem descrição)', valor: 0, porUnidade: new Map() }; mapa.set(det.cProd, p); }
        p.xProd = det.xProd || p.xProd;
        p.valor += det.vProd;
        const unidade = det.uCom || '(sem unidade)';
        p.porUnidade.set(unidade, (p.porUnidade.get(unidade) || 0) + det.qCom);
      });
    });

    return Array.from(mapa.values())
      .map(p => ({
        cProd: p.cProd, xProd: p.xProd, valor: p.valor,
        porUnidade: Array.from(p.porUnidade.entries()).map(([unidade, quantidade]) => ({ unidade, quantidade })).sort((a, b) => b.quantidade - a.quantidade),
        pct: valorTotal > 0 ? (p.valor / valorTotal) * 100 : 0,
      }))
      .sort((a, b) => b.valor - a.valor);
  }, [xmlList, filterMes, mainCnpj, chavesCanceladas]);

  const exportarDevolucoesExcel = () => {
    const aoa: (string | number)[][] = [
      ['#', 'Produto', 'cProd', 'Quantidade Devolvida', 'Valor Devolvido', '% do Total Devolvido'],
    ];
    devolucoesProdutos.forEach((p, i) => {
      aoa.push([i + 1, p.xProd, p.cProd, formatarQuantidadePorUnidade(p.porUnidade), p.valor, Math.round(p.pct * 10) / 10]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 5 }, { wch: 36 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 12 }];
    for (let linha = 0; linha < devolucoesProdutos.length; linha++) {
      const celValor = XLSX.utils.encode_cell({ r: linha + 1, c: 4 });
      if (ws[celValor]) ws[celValor].z = '#,##0.00';
      const celPct = XLSX.utils.encode_cell({ r: linha + 1, c: 5 });
      if (ws[celPct]) ws[celPct].z = '#,##0.0';
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Devolucoes');
    XLSX.writeFile(wb, nomeArquivoExport('devolucoes', 'xlsx'), { compression: true });
  };

  // Relatório do Mapa Fiscal em janela própria pra imprimir/salvar como PDF —
  // mesmo padrão do Laudo IBS/CBS (exportarLaudoIbsCbs): monta um HTML
  // autocontido, abre em blob numa aba nova e dispara o print depois que a
  // fonte carrega. Consolida TUDO que vive dentro do card Mapa Fiscal (resumo,
  // comparativo mensal, séries por mês, ranking, NCMs, sazonalidade,
  // devoluções) mais Mudanças de Cadastro — o card de auditoria de cadastro
  // que fica logo abaixo, mas que o contador pediu junto no mesmo PDF.
  const exportarRelatorioMapaFiscalPdf = () => {
    if (!mapaFiscal) return;
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const empresa = analysis?.[0]?.razaoSocial || notasSaida[0]?.razaoSocial || '';
    const periodo = periodoParaNomeArquivo();
    const hoje = new Date().toLocaleDateString('pt-BR');
    const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const dataFmt = (d: string) => d.split('-').reverse().join('/');
    const LIMITE_LISTA = 50;

    const resumoItens: { label: string; valor: string }[] = [
      { label: 'Faturamento', valor: moeda(mapaFiscal.faturamento) },
      { label: 'Notas válidas', valor: String(mapaFiscal.quantidadeNotas) },
      { label: 'Ticket médio', valor: moeda(mapaFiscal.ticketMedio) },
      { label: 'Produtos distintos', valor: String(mapaFiscal.produtosDistintos) },
    ];
    if (mapaFiscal.pctComGrupoIbsCbs !== null) resumoItens.push({ label: 'Com grupo IBS/CBS', valor: `${formatarPct(mapaFiscal.pctComGrupoIbsCbs)}%` });
    if (mapaFiscal.pctConformeCclasstrib !== null) resumoItens.push({ label: 'Conformidade cClassTrib', valor: `${formatarPct(mapaFiscal.pctConformeCclasstrib)}%` });
    resumoItens.push(
      { label: 'Cadastros divergentes', valor: String(mapaFiscal.cadastrosDivergentes) },
      { label: 'Produtos suspeitos', valor: String(mapaFiscal.produtosSuspeitosTotal) },
      { label: 'Devolvido', valor: `${formatarPct(mapaFiscal.pctDevolvido)}% (${moeda(mapaFiscal.valorDevolvido)})` },
      { label: 'Não presencial', valor: `${formatarPct(mapaFiscal.pctNaoPresencial)}%` },
    );
    const htmlResumo = `
      <div class="secao">
        <h2>Resumo do período</h2>
        <div class="grid-resumo">
          ${resumoItens.map(r => `<div class="item-resumo"><div class="rotulo">${esc(r.label)}</div><div class="valor">${esc(r.valor)}</div></div>`).join('')}
        </div>
      </div>`;

    const htmlComparativoMensal = mapaFiscalPorMes.length < 2 ? '' : (() => {
      type Linha = { label: string; formato: 'moeda' | 'numero' | 'pct'; valor: (m: typeof mapaFiscalPorMes[number]) => number };
      const linhas: Linha[] = [
        { label: 'Faturamento', formato: 'moeda', valor: m => m.faturamento },
        { label: 'Notas válidas', formato: 'numero', valor: m => m.quantidadeNotas },
        { label: 'Ticket médio', formato: 'moeda', valor: m => m.ticketMedio },
        { label: 'Produtos distintos', formato: 'numero', valor: m => m.produtosDistintos },
        { label: 'Com grupo IBS/CBS', formato: 'pct', valor: m => m.pctComGrupoIbsCbs },
        { label: 'Produção própria', formato: 'pct', valor: m => m.pctProducaoPropria },
        { label: 'Revenda', formato: 'pct', valor: m => m.pctRevenda },
        { label: 'Sujeito a ST', formato: 'pct', valor: m => m.pctST },
        { label: 'Não presencial', formato: 'pct', valor: m => m.pctNaoPresencial },
        { label: 'Devolvido', formato: 'pct', valor: m => m.pctDevolvido },
      ];
      const fmt = (v: number, formato: string) => formato === 'moeda' ? moeda(v) : formato === 'pct' ? `${formatarPct(v)}%` : String(v);
      const linhasHtml = linhas.map(l => `
        <tr>
          <td>${esc(l.label)}</td>
          ${mapaFiscalPorMes.map(m => `<td class="num">${esc(fmt(l.valor(m), l.formato))}</td>`).join('')}
        </tr>`).join('');
      return `
        <div class="secao">
          <h2>Comparativo mensal</h2>
          <table>
            <thead><tr><th>Indicador</th>${mapaFiscalPorMes.map(m => `<th class="num">${esc(m.mes)}</th>`).join('')}</tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const htmlSeriesPorMes = (matrizSeriePorMes.series.length < 2 || matrizSeriePorMes.meses.length < 2) ? '' : (() => {
      const linhasHtml = matrizSeriePorMes.series.map(serie => {
        const porMes = matrizSeriePorMes.matriz.get(serie);
        const totalSerie = porMes ? Array.from(porMes.values() as IterableIterator<number>).reduce((s: number, q: number) => s + q, 0) : 0;
        const celulas = matrizSeriePorMes.meses.map(mes => {
          const qtd = porMes?.get(mes) || 0;
          const buraco = qtd === 0 && totalSerie > 0;
          return `<td class="num${buraco ? ' erro-txt buraco' : ''}">${qtd > 0 ? qtd : '—'}</td>`;
        }).join('');
        return `<tr><td>${esc(serie)}</td>${celulas}</tr>`;
      }).join('');
      return `
        <div class="secao">
          <h2>Séries por mês</h2>
          <div class="meta">Quantidade de notas válidas de cada série em cada mês. Célula em vermelho é uma série com movimento em outro mês do período, mas nenhuma nota neste mês.</div>
          <table>
            <thead><tr><th>Série</th>${matrizSeriePorMes.meses.map(mes => `<th class="num">${esc(mes)}</th>`).join('')}</tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const htmlRanking = rankingProdutos.produtos.length === 0 ? '' : (() => {
      const origemLabel: Record<string, string> = { propria: 'Produção própria', revenda: 'Revenda', misto: 'Misto', indefinida: 'Indefinida' };
      const visiveis = rankingProdutos.produtos.slice(0, LIMITE_LISTA);
      const linhasHtml = visiveis.map((p, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${esc(p.xProd)}</td>
          <td class="mono">${esc(p.cProd)}</td>
          <td>${esc(origemLabel[p.origem])}</td>
          <td class="num">${esc(p.classeAbc)}</td>
          <td class="num">${esc(formatarQuantidadePorUnidade(p.porUnidade))}</td>
          <td class="num">${moeda(p.valor)}</td>
          <td class="num">${formatarPct(p.pct)}%</td>
        </tr>`).join('');
      const qtdClasseA = rankingProdutos.produtos.filter(p => p.classeAbc === 'A').length;
      return `
        <div class="secao">
          <h2>Ranking de produtos</h2>
          <div class="meta">Curva ABC: ${qtdClasseA} produto(s) (Classe A) já somam 80% do faturamento do catálogo inteiro (${rankingProdutos.produtos.length} produto(s) distinto(s)).${rankingProdutos.produtos.length > LIMITE_LISTA ? ` Mostrando os ${LIMITE_LISTA} primeiros — lista completa no Excel.` : ''}</div>
          <table>
            <thead><tr><th>#</th><th>Produto</th><th>cProd</th><th>Origem</th><th class="num">ABC</th><th class="num">Quantidade</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const htmlNcm = rankingNcm.ncms.length === 0 ? '' : (() => {
      const visiveis = rankingNcm.ncms.slice(0, LIMITE_LISTA);
      const linhasHtml = visiveis.map((n, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="mono${n.ncm === '(vazio)' ? ' erro-txt' : ''}">${esc(n.ncm)}</td>
          <td>${esc(n.xProdAmostra)}</td>
          <td class="num">${n.produtosDistintos}</td>
          <td class="num">${moeda(n.valor)}</td>
          <td class="num">${formatarPct(n.pct)}%</td>
        </tr>`).join('');
      return `
        <div class="secao">
          <h2>Top NCMs</h2>
          <div class="meta">${rankingNcm.ncms.length} NCM(s) distinto(s) no período.${rankingNcm.ncms.length > LIMITE_LISTA ? ` Mostrando os ${LIMITE_LISTA} primeiros — lista completa no Excel.` : ''}</div>
          <table>
            <thead><tr><th>#</th><th>NCM</th><th>Produto (amostra)</th><th class="num">Produtos</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const htmlSazonalidade = sazonalidade.porDiaSemana.every(d => d.quantidadeNotas === 0) ? '' : (() => {
      const linhasDia = sazonalidade.porDiaSemana.map(d => `
        <tr><td>${esc(d.dia)}</td><td class="num">${d.quantidadeNotas}</td><td class="num">${moeda(d.faturamento)}</td><td class="num">${formatarPct(d.pct)}%</td></tr>`).join('');
      const horasComMovimento = sazonalidade.porHora.filter(h => h.quantidadeNotas > 0);
      const linhasHora = horasComMovimento.map(h => `
        <tr><td>${String(h.hora).padStart(2, '0')}h</td><td class="num">${h.quantidadeNotas}</td><td class="num">${moeda(h.faturamento)}</td><td class="num">${formatarPct(h.pct)}%</td></tr>`).join('');
      return `
        <div class="secao duas-colunas">
          <div>
            <h2>Sazonalidade — dia da semana</h2>
            <div class="meta">Só venda de verdade (exclui transferência, baixa de estoque, devolução de compra e outras saídas que não são venda).</div>
            <table><thead><tr><th>Dia</th><th class="num">Notas</th><th class="num">Faturamento</th><th class="num">%</th></tr></thead><tbody>${linhasDia}</tbody></table>
          </div>
          <div>
            <h2>Sazonalidade — horário</h2>
            <div class="meta">Só venda de verdade (exclui transferência, baixa de estoque, devolução de compra e outras saídas que não são venda).</div>
            <table><thead><tr><th>Hora</th><th class="num">Notas</th><th class="num">Faturamento</th><th class="num">%</th></tr></thead><tbody>${linhasHora}</tbody></table>
          </div>
        </div>`;
    })();

    const htmlDevolucoes = mapaFiscal.quantidadeDevolucoes === 0 ? '' : (() => {
      const visiveis = devolucoesProdutos.slice(0, LIMITE_LISTA);
      const linhasHtml = visiveis.map((p, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${esc(p.xProd)}</td>
          <td class="mono">${esc(p.cProd)}</td>
          <td class="num">${esc(formatarQuantidadePorUnidade(p.porUnidade))}</td>
          <td class="num">${moeda(p.valor)}</td>
          <td class="num">${formatarPct(p.pct)}%</td>
        </tr>`).join('');
      return `
        <div class="secao">
          <h2>Devoluções</h2>
          <div class="box alerta">🟡 ${formatarPct(mapaFiscal.pctDevolvido)}% do faturamento do período voltou como devolução de venda (${moeda(mapaFiscal.valorDevolvido)} em ${mapaFiscal.quantidadeDevolucoes} nota(s)).</div>
          <table>
            <thead><tr><th>#</th><th>Produto</th><th>cProd</th><th class="num">Qtd Devolvida</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const LIMITE_MUDANCAS = 100;
    const htmlMudancas = auditoriaCadastroProdutos.mudancas.length === 0 ? '' : (() => {
      const visiveis = auditoriaCadastroProdutos.mudancas.slice(0, LIMITE_MUDANCAS);
      const linhasHtml = visiveis.map(m => {
        const primeiro = m.valores[0];
        const ultimo = m.valores[m.valores.length - 1];
        return `
          <tr>
            <td class="mono">${esc(m.cProd)}</td>
            <td>${esc(m.xProd)}</td>
            <td>${esc(m.campo)}</td>
            <td>${esc(primeiro.valor)} <span class="sub">(${dataFmt(primeiro.primeira)})</span></td>
            <td>${esc(ultimo.valor)} <span class="sub">(${dataFmt(ultimo.ultima)})</span></td>
          </tr>`;
      }).join('');
      return `
        <div class="secao">
          <h2>Mudanças de cadastro no período</h2>
          <div class="meta">${auditoriaCadastroProdutos.mudancas.length} mudança(s) detectada(s) — o mesmo código de produto saiu com classificações diferentes em datas diferentes.${auditoriaCadastroProdutos.mudancas.length > LIMITE_MUDANCAS ? ` Mostrando as ${LIMITE_MUDANCAS} primeiras — lista completa (com o histórico intermediário) no Excel.` : ''}</div>
          <table>
            <thead><tr><th>cProd</th><th>Produto</th><th>Campo</th><th>Primeiro valor</th><th>Último valor</th></tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const htmlNomeDuplicado = produtosSuspeitos.nomeDuplicado.length === 0 ? '' : (() => {
      const visiveis = produtosSuspeitos.nomeDuplicado.slice(0, LIMITE_MUDANCAS);
      const linhasHtml = visiveis.map(p => `
        <tr>
          <td>${esc(p.xProd)}</td>
          <td class="mono">${p.cProds.map(c => esc(c.cProd)).join(', ')}</td>
        </tr>`).join('');
      return `
        <div class="secao">
          <h2>Nomes duplicados (mesmo nome, cProd diferente)</h2>
          <div class="meta">${produtosSuspeitos.nomeDuplicado.length} nome(s) de produto associado(s) a mais de um código interno.${produtosSuspeitos.nomeDuplicado.length > LIMITE_MUDANCAS ? ` Mostrando os ${LIMITE_MUDANCAS} primeiros — lista completa (com amostra de nota) no Excel.` : ''}</div>
          <table>
            <thead><tr><th>Produto</th><th>cProd usados</th></tr></thead>
            <tbody>${linhasHtml}</tbody>
          </table>
        </div>`;
    })();

    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<title>Mapa Fiscal ${esc(empresa)} ${esc(periodo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'IBM Plex Sans', sans-serif; color: #17150F; background: #fff; font-size: 11px; padding: 32px 40px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; }
  header { border-bottom: 2px solid #C9A227; padding-bottom: 14px; margin-bottom: 18px; }
  h1 { font-family: 'Newsreader', serif; font-size: 22px; font-weight: 600; }
  .empresa { font-size: 13px; font-weight: 700; margin-top: 8px; }
  .head-meta { color: #78736A; margin-top: 3px; }
  h2 { font-family: 'Newsreader', serif; font-size: 15px; font-weight: 600; border-left: 3px solid #C9A227; padding-left: 8px; margin: 0 0 4px; }
  .secao { margin-top: 22px; page-break-inside: avoid; }
  .secao.duas-colunas { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
  .meta { color: #78736A; margin-bottom: 6px; }
  .grid-resumo { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 20px; margin-top: 6px; }
  .item-resumo .rotulo { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: #A29C92; }
  .item-resumo .valor { font-size: 14px; font-weight: 700; margin-top: 1px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #A29C92; border-bottom: 1px solid #E5E0D6; padding: 4px 8px 4px 0; }
  th.num { text-align: right; }
  td { border-bottom: 1px solid #EFEBE3; padding: 3.5px 8px 3.5px 0; vertical-align: top; }
  .box { border-radius: 6px; padding: 8px 12px; margin: 6px 0; border: 1px solid; }
  .box.ok { background: #f2f8f2; border-color: #cde3cd; color: #2c6e2c; }
  .box.erro { background: #fdf2f2; border-color: #f0caca; color: #a33030; }
  .box.alerta { background: #fdf8ec; border-color: #ecdcae; color: #8a6d1a; }
  .erro-txt { color: #a33030; font-weight: 700; }
  .buraco { background: #fdf2f2; }
  .sub { opacity: 0.75; font-size: 10px; }
  footer { margin-top: 28px; border-top: 1px solid #E5E0D6; padding-top: 10px; color: #78736A; font-size: 10px; line-height: 1.5; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  @page { margin: 14mm; size: A4; }
</style></head><body>
<header>
  <h1>Mapa Fiscal</h1>
  <div class="empresa">${esc(empresa)}</div>
  <div class="head-meta">CNPJ ${esc(mainCnpj || '')} · Período: ${esc(periodo)} · Gerado em ${hoje}</div>
</header>

${htmlResumo}
${htmlComparativoMensal}
${htmlSeriesPorMes}
${htmlRanking}
${htmlNcm}
${htmlSazonalidade}
${htmlDevolucoes}
${htmlMudancas}
${htmlNomeDuplicado}

<footer>
  <strong>Sobre este relatório.</strong> Faturamento, ticket médio e ranking consideram apenas notas de saída válidas (com protocolo de autorização, descontando cancelamento). Devolvido usa CFOP de devolução de venda (não finNFe) sobre notas de entrada emitidas pela própria empresa. Curva ABC (A até 80% do faturamento acumulado, B até 95%, C o resto) é calculada sobre o catálogo inteiro. Documento gerado pelo Sequência Fiscal.
</footer>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (win) win.onload = () => setTimeout(() => win.print(), 400);
  };

  // (3) Nota de homologação (tpAmb=2) misturada no lote de produção — não tem
  // validade fiscal nenhuma e infla o faturamento auditado silenciosamente.
  const notasHomologacao = useMemo(() => {
    const vazio = { total: 0, amostra: [] as XmlData[] };
    if (!mainCnpj) return vazio;
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.tpNF !== '0' && xml.rawXml &&
      !!xml.protocolo && !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );
    if (saidas.length === 0) return vazio;
    const afetadas: XmlData[] = [];
    saidas.forEach(xml => {
      // tpAmb DENTRO de <ide> — o protNFe tem um tpAmb próprio que não é este
      if (getNotaExtract(xml)?.tpAmb === '2') afetadas.push(xml);
    });
    return { total: afetadas.length, amostra: afetadas.slice(0, 10) };
  }, [xmlList, filterMes]);

  // Responsável Técnico (<infRespTec>): identifica quem desenvolve/mantém o
  // sistema de automação do cliente — mais confiável que <verProc> (que em
  // vários sistemas só traz um número de versão, tipo "26.03.04", sem nome
  // nenhum). Não dá pra puxar a razão social só do CNPJ sem consulta externa,
  // mas o domínio do e-mail e o contato já dão uma noção de qual empresa é.
  const responsavelTecnico = useMemo(() => {
    const vazio = { cnpj: '', cnpjFormatado: '', contato: '', email: '', fone: '', foneFormatado: '', dominio: '' };
    if (!mainCnpj) return vazio;

    // Busca dentro do período/mês selecionado primeiro — o responsável técnico
    // pode ter mudado entre um mês e outro (troca de sistema), e mostrar o de
    // um mês diferente do que está sendo visto na tela seria enganoso. Só cai
    // pra "qualquer nota da empresa" se nenhuma do período tiver o campo
    // preenchido (nem toda nota traz <infRespTec>, varia por sistema).
    const buscarInfRespTec = (notas: XmlData[]) => {
      for (const nota of notas) {
        const ex = getNotaExtract(nota);
        if (ex && (ex.respTecCnpj || ex.respTecEmail)) {
          return { cnpj: ex.respTecCnpj, contato: ex.respTecContato, email: ex.respTecEmail, fone: ex.respTecFone };
        }
      }
      return null;
    };
    const daEmpresa = xmlList.filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj && xml.rawXml);
    const doPeriodo = daEmpresa.filter(xml => filterMes === 'Todos' || getMonthYear(xml.data) === filterMes);
    const encontrado = buscarInfRespTec(doPeriodo) || buscarInfRespTec(daEmpresa);
    if (!encontrado) return vazio;
    const { cnpj, contato, email, fone } = encontrado;
    const dominio = email.includes('@') ? email.split('@')[1] : '';

    const cnpjFormatado = cnpj.replace(/^([0-9A-Za-z]{2})([0-9A-Za-z]{3})([0-9A-Za-z]{3})([0-9A-Za-z]{4})(\d{2})$/, '$1.$2.$3/$4-$5') || cnpj;
    const foneFormatado = fone.length === 11
      ? fone.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')
      : fone.length === 10
        ? fone.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3')
        : fone;

    return { cnpj, cnpjFormatado, contato, email, fone, foneFormatado, dominio };
  }, [xmlList, filterMes, mainCnpj]);

  // Auditoria de meios de pagamento / TEF: verifica o bloco <pag> de cada nota
  // em busca de inconsistências que geram rejeição SEFAZ (falso TEF, cAut
  // genérico, CNPJ do cartão = emitente, card presente em pagamento não-cartão)
  // e mede o percentual de vendas em cartão feitas via POS manual (tpIntegra=2)
  // — o padrão de "sem TEF" que pode gerar multa, em qualquer UF.
  //
  // A obrigatoriedade de TEF só vale pra venda em cartão PRESENCIAL e à vista.
  // Por isso ficam de fora da contagem de risco (mas ainda visíveis, à parte):
  // - indPag=1 (pagamento a prazo/faturado — reconciliado depois via banco, sem
  //   TEF físico acionado na hora)
  // - indPres != 1/5 (venda não presencial: e-commerce, teleatendimento, etc.)
  // - UF do destinatário diferente da UF do emitente (venda interestadual)
  const auditoriaPagamento = useMemo(() => {
    const vazio = {
      problemas: [] as any[], totalCartao: 0, totalIntegrado: 0, totalNaoIntegrado: 0, totalFalsoTef: 0, totalCartaoNaoAplicavel: 0,
      notasNaoIntegradas: [] as { xml: XmlData; tPagNome: string }[], breakdownPorTipoPagamento: [] as { tPag: string; tPagNome: string; qtd: number; valor: number }[],
      notasComPagamentoDividido: 0, saidaNaoVendaQtd: 0, saidaNaoVendaValor: 0,
      cartaoIndPagSuspeito: 0, foraEscopoNaoPresencial: 0, foraEscopoInterestadual: 0,
      notasForaDoEscopo: [] as { xml: XmlData; motivo: string }[], totalNotasVendaLiquida: 0
    };
    if (!mainCnpj) return vazio;


    // Mesmo critério de "venda válida" do faturamentoTotal (exige protocolo de
    // autorização SEFAZ) — sem isso, o breakdown por forma de pagamento incluía
    // notas Sem Autorização/Contingência Não Regularizada que o Total de Saídas
    // Auditadas exclui, fazendo a soma do breakdown ultrapassar o total oficial.
    const saidas = xmlList.filter(xml =>
      xml.tipo === 'nfe' &&
      xml.emitCnpj === mainCnpj &&
      xml.tpNF !== '0' &&
      xml.rawXml &&
      !!xml.protocolo &&
      !(xml.chave && chavesCanceladas.has(xml.chave)) &&
      (filterMes === 'Todos' || getMonthYear(xml.data) === filterMes)
    );

    const tPagLabel: Record<string, string> = {
      '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito', '04': 'Cartão de Débito',
      '05': 'Crédito Loja', '10': 'Vale Alimentação', '11': 'Vale Refeição', '12': 'Vale Presente',
      '13': 'Vale Combustível', '14': 'Duplicata Mercantil', '15': 'Boleto Bancário', '16': 'Depósito Bancário',
      '17': 'PIX (Dinâmico)', '18': 'Transferência Bancária', '19': 'Programa de Fidelidade',
      '20': 'PIX (Estático)', '90': 'Sem Pagamento', '99': 'Outros'
    };
    const cAutGenerico = (v: string) => {
      const t = v.trim().toUpperCase();
      if (!t) return false;
      if (/^0+$/.test(t)) return true;
      if (/^(123456|111111|999999|000001)$/.test(t)) return true;
      if (t.includes('TESTE') || t.includes('TEST')) return true;
      return false;
    };
    // O grupo <card> (YA04) é descrito na NT2023.004 como "Grupo de Cartões, PIX,
    // Boletos e outros Pagamentos Eletrônicos" — não é exclusivo de cartão de
    // crédito/débito. Vale Alimentação/Refeição/Presente/Combustível (10-13) e
    // Crédito Loja (05) também são cartões passados na maquininha, e Boleto (15)
    // e PIX (17) estão citados explicitamente no texto oficial do campo.
    const tPagPodeTerCard = new Set(['03', '04', '05', '10', '11', '12', '13', '15', '17']);

    const problemas: {
      xml: XmlData; tPag: string; tPagNome: string; tpIntegra: string;
      cardCnpj: string; cardTBand: string; cardCAut: string; motivo: string;
    }[] = [];
    let totalCartao = 0, totalIntegrado = 0, totalNaoIntegrado = 0, totalFalsoTef = 0, totalCartaoNaoAplicavel = 0;
    // Quantidade e faturamento por forma de pagamento (tPag) — dá visão geral
    // mesmo quando não há nenhuma venda em cartão pra auditar.
    const porTipo: Record<string, { qtd: number; valor: number }> = {};
    // Notas com ao menos um pagamento em cartão via POS manual (dentro do escopo
    // de obrigatoriedade) — servem de amostra pesquisável pra baixar o XML como
    // prova rápida pro cliente.
    const notasNaoIntegradas: { xml: XmlData; tPagNome: string }[] = [];
    // Chave inclui a forma de pagamento — assim uma nota com pagamento dividido
    // em mais de um POS manual (ex: débito e crédito ambos manuais) aparece uma
    // vez por forma, em vez de esconder qual delas realmente ficou de fora.
    const chavesNaoIntegradasVistas = new Set<string>();
    // Nota com pagamento dividido (2+ detPag) conta uma vez em cada tipo que
    // usou — por isso a soma das "qtd" do breakdown pode passar do total de
    // notas válidas, sem ser erro.
    let notasComPagamentoDividido = 0;
    let saidaNaoVendaQtd = 0, saidaNaoVendaValor = 0;
    // Quebra do "fora do escopo" por motivo — sem isso o analista só via o total
    // combinado e não conseguia saber se a zeragem de "sujeita a TEF" era uma
    // exclusão legítima (e-commerce/entrega) ou um dado mal configurado no
    // sistema do cliente (ex: POS gravando indPres errado numa venda presencial).
    let foraEscopoNaoPresencial = 0, foraEscopoInterestadual = 0;
    // Amostra de cada pagamento em cartão fora do escopo de TEF, com o motivo
    // específico — sem isso o "X fora do escopo" era só um número sem como o
    // analista conferir quais notas são essas e por quê.
    const notasForaDoEscopo: { xml: XmlData; motivo: string }[] = [];
    const forasVistos = new Set<string>();
    // Cartão com indPag=1 (a prazo) é sempre suspeito: quem parcela no cartão é
    // o cliente com a operadora, o lojista recebe à vista da adquirente do
    // mesmo jeito — indPag=1 aqui geralmente indica PDV mal configurado.
    let cartaoIndPagSuspeito = 0;

    saidas.forEach(xml => {
      const ex = getNotaExtract(xml);
      if (!ex) return;
      if (ex.detPags.length > 1) notasComPagamentoDividido++;
      // Troco (vTroco) é o valor devolvido ao cliente no pagamento em dinheiro —
      // entra no vPag do detPag de Dinheiro mas NÃO faz parte do valor da venda
      // (vNF), senão a soma do breakdown por forma de pagamento ultrapassa o
      // Total de Saídas Auditadas sempre que há troco.
      let vTrocoRestante = ex.vTroco;
      const indPres = ex.indPres;
      const isPresencial = indPres === '' || indPres === '1' || indPres === '5';
      const ufEmit = ex.ufEmit;
      const ufDest = ex.ufDest;
      const isInterestadual = !!ufEmit && !!ufDest && ufEmit !== ufDest;
      // finNFe=1 é venda normal — o código 90 (Sem Pagamento) é reservado pra
      // Ajuste/Devolução (finNFe 2/3/4). Uma venda normal com valor real
      // declarada como "sem pagamento" é inconformidade fiscal, não um dado
      // ausente de verdade — o cliente pode estar escondendo receita ou o
      // sistema de automação não está gravando o meio de pagamento usado.
      //
      // Mas nem toda saída com finNFe=1 é venda: remessa, transferência,
      // devolução de compra e consignação também são finNFe=1 (só Ajuste/
      // Complementar/Devolução usam 2/3/4) e legitimamente não têm pagamento.
      // O CFOP predominante da nota (por valor, via cfopValores) decide se ela
      // é venda de verdade antes de acusar "Sem Pagamento" como inconformidade.
      const finNFe = ex.finNFe;
      const vNF = parseFloat(xml.valor || '0') || 0;
      const cfopMap: Record<string, number> = xml.cfopValores || {};
      const cfopPredominante = Object.entries(cfopMap).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const isSaidaVenda = !cfopPredominante || isCfopVenda(cfopPredominante);

      ex.detPags.forEach(detPag => {
        const tPag = detPag.tPag;
        const indPag = detPag.indPag || '0';
        const isAVista = indPag !== '1';
        const isCartao = tPag === '03' || tPag === '04';
        const card = detPag.temCard;
        const tpIntegra = detPag.tpIntegra;
        const cardCnpj = detPag.cardCnpj;
        const cardTBand = detPag.cardTBand;
        const cardCAut = detPag.cardCAut;
        // xPag é o campo de descrição livre que o próprio layout da NF-e prevê
        // pra quando o código de tPag não é um dos catalogados aqui — mostra
        // isso em vez de só o número cru quando não reconhecemos o código.
        const xPag = detPag.xPag;
        const tPagNome = tPagLabel[tPag] || (xPag ? `${xPag} (código ${tPag})` : `Código ${tPag} (não catalogado)`);
        const vPagBruto = detPag.vPag;
        // Desconta o troco (se houver) do pagamento em dinheiro desta nota — só
        // uma vez, mesmo que o troco seja maior que este detPag específico.
        let vPag = vPagBruto;
        if (tPag === '01' && vTrocoRestante > 0) {
          const desconto = Math.min(vPagBruto, vTrocoRestante);
          vPag = vPagBruto - desconto;
          vTrocoRestante -= desconto;
        }

        if (!porTipo[tPag]) porTipo[tPag] = { qtd: 0, valor: 0 };
        porTipo[tPag].qtd++;
        porTipo[tPag].valor += vPag;

        if (isCartao) {
          // indPag NÃO decide o escopo de TEF pra pagamento em cartão: quem
          // parcela é o cliente com a operadora, o lojista recebe à vista da
          // adquirente de qualquer forma — o swipe do cartão já prova por si só
          // que havia um terminal físico na hora da venda. TEF só fica de fora
          // pra venda não presencial ou interestadual.
          const sujeitoATef = isPresencial && !isInterestadual;
          if (!isAVista) cartaoIndPagSuspeito++;
          if (!sujeitoATef) {
            totalCartaoNaoAplicavel++;
            const motivos: string[] = [];
            if (!isPresencial) { foraEscopoNaoPresencial++; motivos.push(`não presencial (indPres=${indPres || '0'})`); }
            if (isInterestadual) { foraEscopoInterestadual++; motivos.push(`interestadual (${ufEmit} → ${ufDest})`); }
            const chaveOuId = xml.chave || `${xml.serie}-${xml.numero}`;
            const chaveMotivo = `${chaveOuId}|${motivos.join('+')}`;
            if (!forasVistos.has(chaveMotivo)) {
              forasVistos.add(chaveMotivo);
              notasForaDoEscopo.push({ xml, motivo: motivos.join(' e ') });
            }
          } else {
            totalCartao++;
            // tpIntegra=1 só conta como integração de verdade se veio com o
            // código de autorização (cAut) que o TEF real sempre devolve —
            // sem isso é "Falso TEF": a nota AFIRMA integração que os dados
            // não confirmam, e por isso não entra nem em integrado nem em
            // POS manual, fica numa contagem própria (mais grave que os dois).
            if (tpIntegra === '1' && !cardCAut) {
              totalFalsoTef++;
            } else if (tpIntegra === '1') {
              totalIntegrado++;
            } else if (tpIntegra === '2') {
              totalNaoIntegrado++;
              const chaveOuId = `${xml.chave || `${xml.serie}-${xml.numero}`}|${tPag}`;
              if (!chavesNaoIntegradasVistas.has(chaveOuId)) {
                chavesNaoIntegradasVistas.add(chaveOuId);
                notasNaoIntegradas.push({ xml, tPagNome });
              }
            }
          }

          if (tpIntegra === '1' && !cardCAut) {
            problemas.push({ xml, tPag, tPagNome, tpIntegra, cardCnpj, cardTBand, cardCAut, motivo: 'Falso TEF: marcado como integrado (tpIntegra=1) mas sem código de autorização' });
          }
          if (cardCAut && cAutGenerico(cardCAut)) {
            problemas.push({ xml, tPag, tPagNome, tpIntegra, cardCnpj, cardTBand, cardCAut, motivo: `Código de autorização genérico/suspeito: "${cardCAut}"` });
          }
          if (cardCnpj && cardCnpj.replace(/[.\-/\s]/g, '') === xml.emitCnpj) {
            problemas.push({ xml, tPag, tPagNome, tpIntegra, cardCnpj, cardTBand, cardCAut, motivo: 'CNPJ da adquirente igual ao CNPJ do emitente' });
          }
        } else if (tPag === '90' && finNFe === '1' && vNF > 0 && isSaidaVenda) {
          problemas.push({ xml, tPag, tPagNome, tpIntegra, cardCnpj, cardTBand, cardCAut, motivo: `Venda normal (finNFe=1) de ${formatarMoeda(vNF)} declarada como "Sem Pagamento" — código 90 é reservado pra Ajuste/Devolução` });
        } else if (tPag === '90' && finNFe === '1' && vNF > 0 && !isSaidaVenda) {
          // Remessa/transferência/devolução de compra/consignação: finNFe=1 mas
          // CFOP indica que não é venda — "Sem Pagamento" está correto aqui, não é alerta.
          saidaNaoVendaQtd++;
          saidaNaoVendaValor += vNF;
        } else if (card && !tPagPodeTerCard.has(tPag)) {
          problemas.push({ xml, tPag, tPagNome, tpIntegra, cardCnpj, cardTBand, cardCAut, motivo: `Bloco <card> presente em pagamento não-cartão (${tPagNome})` });
        }
      });

      // Troco (vTroco) só existe quando há pagamento em dinheiro de verdade —
      // se sobrou troco sem nenhum detPag de Dinheiro (tPag=01) pra absorvê-lo,
      // é inconsistência no próprio sistema de automação do cliente.
      if (vTrocoRestante > 0.005) {
        problemas.push({
          xml, tPag: '', tPagNome: 'Troco', tpIntegra: '', cardCnpj: '', cardTBand: '', cardCAut: '',
          motivo: `Troco de ${formatarMoeda(vTrocoRestante)} declarado sem pagamento em Dinheiro correspondente`
        });
      }
    });

    const breakdownPorTipoPagamento = Object.entries(porTipo)
      .map(([tPag, v]) => ({ tPag, tPagNome: tPagLabel[tPag] || tPag, qtd: v.qtd, valor: v.valor }))
      .sort((a, b) => b.valor - a.valor);

    return {
      problemas, totalCartao, totalIntegrado, totalNaoIntegrado, totalFalsoTef, totalCartaoNaoAplicavel, notasNaoIntegradas,
      breakdownPorTipoPagamento, notasComPagamentoDividido, saidaNaoVendaQtd, saidaNaoVendaValor,
      cartaoIndPagSuspeito, foraEscopoNaoPresencial, foraEscopoInterestadual,
      notasForaDoEscopo, totalNotasVendaLiquida: saidas.length
    };
  }, [xmlList, filterMes]);

  // Clique em "Perfil do Cliente": consulta a Receita (BrasilAPI) só do CNPJ da empresa e, SE ela for do
  // Simples, abre a janela perguntando "puro ou híbrido?" (única dúvida que nenhuma camada resolve). Para
  // qualquer outro regime gera direto — nada a confirmar.
  const abrirPerfilCliente = async () => {
    if (exportProgress) return;
    if (!mainCnpj) { exportarRelatorioAlertasHtml(); return; }
    const emCache = consultaClientesCnpj[mainCnpj];
    let dados: PerfilClienteReceitaDados | undefined = emCache && emCache.status === 'ok' ? emCache.dados : undefined;
    if (!dados) {
      setExportProgress({ atual: 0, total: 1, etapa: 'Consultando a Receita Federal (BrasilAPI)', titulo: 'Perfil do Cliente' });
      try {
        dados = await buscarDadosCnpj(mainCnpj, 8000);
        const novo = dados;
        setConsultaClientesCnpj(prev => ({ ...prev, [mainCnpj]: { status: 'ok', dados: novo } }));
      } catch { /* sem Receita: vale o CRT da nota */ }
      setExportProgress(null);
    }
    const crt = regimeTributario.crt;
    const simplesCrt = crt === '1' || crt === '2';
    // mesma regra do relatório: a Receita vale mais que o CRT quando discordam sobre "é Simples?"
    let ehSimples = simplesCrt;
    let receitaTxt = 'não consultada';
    if (dados) {
      if (dados.opcaoMei === true) { ehSimples = false; receitaTxt = 'MEI'; }
      else if (dados.opcaoSimples === true) { ehSimples = true; receitaTxt = 'Optante do Simples'; }
      else if (dados.opcaoSimples === false) { ehSimples = false; receitaTxt = 'Não optante do Simples'; }
      else if (dados.opcaoSimples === null) { ehSimples = false; receitaTxt = 'Sem opção pelo Simples'; }
      else receitaTxt = 'sem informação do Simples';
    }
    if (!ehSimples) { exportarRelatorioAlertasHtml(); return; }
    setModoSimplesEscolhido('duvida');
    setConfirmaSimples({ crtTxt: crt ? (crtLabel[crt] || `CRT ${crt}`) : 'sem CRT', receitaTxt, diverge: !!crt && !simplesCrt });
  };

  // Relatório de Alertas (IBS/CBS + TEF): HTML autocontido, baixável (não é
  // janela de impressão como o Laudo/Mapa Fiscal) — feito pra ser anexado e
  // mandado pra analista/superior. Cada assunto vira um "tópico" (severidade
  // crítico/atenção/ok, resumo de uma linha, e uma tabela quando fizer
  // sentido); um Sumário Executivo no topo lista todo tópico com link âncora,
  // pra nada ficar escondido atrás de um clique que ninguém dá. Tópico com
  // tabela ganha botão "Baixar Excel" — via SheetJS carregado por CDN dentro
  // do próprio HTML exportado, lendo os dados de um <script> com JSON embutido
  // (o relatório roda sozinho, sem depender do app aberto).
  // Perfil do Cliente (HTML completo e baixável) — nasceu como "Relatório de
  // Alertas" (só IBS/CBS + TEF) e cresceu pra reunir o retrato inteiro do
  // cliente num só documento: quem compra dele, o que ele vende, quando vende
  // mais, e os alertas de conformidade — tudo com tópicos que minimizam/
  // maximizam, pra não afogar quem só precisa de uma visão geral primeiro.
  const exportarRelatorioAlertasHtml = async (opcoes?: { modoSimples?: 'duvida' | 'puro' | 'hibrido' }) => {
    if (exportProgress) return; // já há uma exportação em andamento (esta ou outra)
    // Camada 2 da verificação de regime (a camada 1 é o CRT da nota): antes de
    // montar o relatório, consulta a Receita Federal (BrasilAPI) dos maiores
    // fornecedores e clientes que ainda não foram consultados nesta sessão —
    // uma de cada vez, com timeout e teto de tempo, e o que falhar vira "não
    // consultada" no relatório (nunca trava nem derruba a exportação).
    const alvosConsulta = Array.from(new Set([
      mainCnpj || '', // o regime da própria empresa também tem as duas camadas (CRT + Receita)
      ...perfilFornecedores.fornecedores.slice(0, 30).map(f => f.cnpj),
      ...perfilClientes.clientes.slice(0, 30).map(c => c.cnpj),
    ])).filter(c => !!c);
    const cacheRegime: Record<string, PerfilClienteReceitaDados> = {};
    (Object.entries(consultaClientesCnpj) as [string, { status: string; dados?: PerfilClienteReceitaDados }][]).forEach(([c, v]) => { if (v.status === 'ok' && v.dados) cacheRegime[c] = v.dados; });
    const formatCnpj = (c: string) =>
      c.replace(/^([0-9A-Za-z]{2})([0-9A-Za-z]{3})([0-9A-Za-z]{3})([0-9A-Za-z]{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    const faltamConsulta = alvosConsulta.filter(c => !cacheRegime[c]);
    if (faltamConsulta.length > 0) {
      const inicioConsulta = Date.now();
      let feitos = 0;
      for (const cnpj of faltamConsulta) {
        if (Date.now() - inicioConsulta > 90000) break;
        setExportProgress({ atual: feitos, total: faltamConsulta.length, etapa: 'Consultando a Receita Federal (BrasilAPI)', titulo: 'Perfil do Cliente' });
        try { cacheRegime[cnpj] = await buscarDadosCnpj(cnpj, 8000); } catch { /* fica "não consultada" */ }
        feitos++;
        await new Promise(r => setTimeout(r, 300));
      }
      setConsultaClientesCnpj(prev => {
        const novo = { ...prev };
        faltamConsulta.forEach(c => { if (cacheRegime[c]) novo[c] = { status: 'ok', dados: cacheRegime[c] }; });
        return novo;
      });
      setExportProgress(null);
    }
    type Area = 'perfil' | 'fornecedores' | 'ranking' | 'sazonalidade' | 'reforma';
    type Topico = {
      id: string; area: Area; titulo: string;
      // 'info': conteúdo de perfil/retrato, não é um "problema" nem um
      // "passou no teste" — crítico/atenção/ok continuam só pros alertas de
      // conformidade (IBS/CBS, TEF).
      nivel: 'critico' | 'atencao' | 'ok' | 'info';
      resumo: string;
      corpo: string;
      colunas?: string[];
      linhas?: (string | number)[][];
    };

    // Alguns emissores gravam o acento como entidade HTML literal dentro do XML ("REQUEIJ&Atilde;O");
    // decodifica antes de escapar, senão o relatório mostra o "&Atilde;" cru.
    const ENTIDADES: Record<string, string> = { Atilde: 'Ã', atilde: 'ã', Otilde: 'Õ', otilde: 'õ', Aacute: 'Á', aacute: 'á', Eacute: 'É', eacute: 'é', Iacute: 'Í', iacute: 'í', Oacute: 'Ó', oacute: 'ó', Uacute: 'Ú', uacute: 'ú', Acirc: 'Â', acirc: 'â', Ecirc: 'Ê', ecirc: 'ê', Ocirc: 'Ô', ocirc: 'ô', Agrave: 'À', agrave: 'à', Ccedil: 'Ç', ccedil: 'ç', Uuml: 'Ü', uuml: 'ü', quot: '"', apos: "'", nbsp: ' ' };
    const decodeEnt = (s: string) => s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&([A-Za-z]+);/g, (m, n) => ENTIDADES[n] ?? m);
    const esc = (s: unknown) => decodeEnt(String(s ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const empresa = analysis?.[0]?.razaoSocial || notasSaida[0]?.razaoSocial || '';
    const periodo = periodoParaNomeArquivo();
    const hoje = new Date().toLocaleDateString('pt-BR');
    const dataFmt = (d?: string) => d ? new Date(d).toLocaleDateString('pt-BR') : '—';

    const topicos: Topico[] = [];

    // ─── ÁREA: PERFIL DE CLIENTES ──────────────────────────────────────────
    if (perfilClientes.clientes.length > 0) {
      const top = perfilClientes.clientes.slice(0, 30);
      topicos.push({
        id: 'perfil-clientes-top', area: 'perfil', titulo: 'Principais Clientes (NF-e)',
        nivel: 'info',
        resumo: `${perfilClientes.clientes.length} cliente(s) identificados via NF-e, ${formatarMoeda(perfilClientes.totalConsiderado)} em vendas no período`,
        corpo: `Agrega as vendas por NF-e (mod 55) pelo CNPJ do destinatário — NFC-e fica de fora porque o consumidor final quase nunca tem CNPJ identificável, não há "cliente" pra perfilar. Considera só item em CFOP de venda, líquido de devolução/transferência/remessa/bonificação.${perfilClientes.clientes.length > 30 ? ` Mostrando os 30 maiores de ${perfilClientes.clientes.length}.` : ''}`,
        colunas: ['Cliente', 'CNPJ', 'Notas', 'Total Comprado (R$)', 'Ticket Médio (R$)', 'Última Compra'],
        linhas: top.map(c => [c.nome, c.cnpj, c.quantidadeNotas, c.totalComprado, c.ticketMedio, dataFmt(c.ultimaCompra)]),
      });
    }

    // ─── ÁREA: PERFIL DE FORNECEDORES ───────────────────────────────────────
    if (perfilFornecedores.fornecedores.length > 0) {
      const top = perfilFornecedores.fornecedores.slice(0, 30);
      topicos.push({
        id: 'perfil-fornecedores-top', area: 'fornecedores', titulo: 'Principais Fornecedores (NF-e de Entrada)',
        nivel: 'info',
        resumo: `${perfilFornecedores.fornecedores.length} fornecedor(es) identificados via NF-e, ${formatarMoeda(perfilFornecedores.totalConsiderado)} em compras no período`,
        corpo: `Agrega as compras recebidas (NF-e onde a empresa auditada é o destinatário) pelo CNPJ do emitente. "ICMS Destacado" soma o vICMS item a item — base do crédito a avaliar (não o crédito efetivo, que depende do regime da própria empresa auditada). "Regime" é o CRT declarado pelo próprio fornecedor na nota mais recente (1/2 = Simples Nacional, 3 = Regime Normal, 4 = MEI) — importa diretamente pro crédito de IBS/CBS aproveitável na Reforma Tributária.${perfilFornecedores.fornecedores.length > 30 ? ` Mostrando os 30 maiores de ${perfilFornecedores.fornecedores.length}.` : ''}`,
        colunas: ['Fornecedor', 'CNPJ', 'Notas', 'Total Comprado (R$)', 'ICMS Destacado (R$)', 'Regime Declarado', 'Última Compra'],
        linhas: top.map(f => [f.nome, f.cnpj, f.quantidadeNotas, f.totalComprado, f.totalIcmsDestacado, f.crtDeclaradoLabel, dataFmt(f.ultimaCompra)]),
      });
    }

    // ─── ÁREA: RANKING DE PRODUTOS ─────────────────────────────────────────
    if (rankingProdutos.produtos.length > 0) {
      const top = rankingProdutos.produtos.slice(0, 30);
      topicos.push({
        id: 'ranking-produtos-top', area: 'ranking', titulo: 'Produtos Mais Vendidos',
        nivel: 'info',
        resumo: `${rankingProdutos.produtos.length} produto(s) distintos, ${formatarMoeda(rankingProdutos.faturamentoConsiderado)} em vendas consideradas`,
        corpo: `Soma de vProd dos itens com CFOP de venda (não o valor da nota) — pode divergir um pouco do faturamento oficial quando há desconto/frete não rateado por item. Curva ABC clássica: A = até 80% do faturamento acumulado, B = até 95%, C = o resto.${rankingProdutos.produtos.length > 30 ? ` Mostrando os 30 maiores de ${rankingProdutos.produtos.length}.` : ''}`,
        colunas: ['Produto', 'Valor (R$)', '% do Total', 'Curva ABC'],
        linhas: top.map(p => [p.xProd, p.valor, `${formatarPct(p.pct)}%`, p.classeAbc]),
      });
    }

    // ─── ÁREA: SAZONALIDADE ────────────────────────────────────────────────
    if (sazonalidade.porDiaSemana.some(d => d.quantidadeNotas > 0)) {
      const diaPico = sazonalidade.porDiaSemana.reduce((max, d) => d.faturamento > max.faturamento ? d : max, sazonalidade.porDiaSemana[0]);
      topicos.push({
        id: 'sazonalidade-dia', area: 'sazonalidade', titulo: 'Faturamento por Dia da Semana',
        nivel: 'info',
        resumo: `Pico em ${diaPico.dia} (${formatarPct(diaPico.pct)}% do faturamento considerado)`,
        corpo: 'Faturamento de venda (líquido de devolução/transferência/remessa/bonificação, rateado por CFOP dentro de cada nota) somado por dia da semana de emissão.',
        colunas: ['Dia', 'Faturamento (R$)', 'Notas', '% do Total'],
        linhas: sazonalidade.porDiaSemana.map(d => [d.dia, d.faturamento, d.quantidadeNotas, `${formatarPct(d.pct)}%`]),
      });
      const horaPico = sazonalidade.porHora.reduce((max, h) => h.faturamento > max.faturamento ? h : max, sazonalidade.porHora[0]);
      topicos.push({
        id: 'sazonalidade-hora', area: 'sazonalidade', titulo: 'Faturamento por Horário',
        nivel: 'info',
        resumo: `Pico às ${String(horaPico.hora).padStart(2, '0')}h (${formatarPct(horaPico.pct)}% do faturamento considerado)`,
        corpo: 'Mesmo critério de venda líquida acima, agora por hora de emissão (direto do dhEmi, sem conversão de fuso) — útil pra decisão de escala de equipe/produção.',
        colunas: ['Hora', 'Faturamento (R$)', 'Notas', '% do Total'],
        linhas: sazonalidade.porHora.filter(h => h.quantidadeNotas > 0).map(h => [`${String(h.hora).padStart(2, '0')}h`, h.faturamento, h.quantidadeNotas, `${formatarPct(h.pct)}%`]),
      });
    }

    const temReforma = !!mainCnpj && (faturamentoTotal > 0 || perfilFornecedores.fornecedores.length > 0);
    if (topicos.length === 0 && !temReforma) return;

    const dadosParaExcel: Record<string, { colunas: string[]; linhas: (string | number)[][] }> = {};
    topicos.forEach(t => { if (t.colunas && t.linhas) dadosParaExcel[t.id] = { colunas: t.colunas, linhas: t.linhas }; });

    // ─── REFORMA TRIBUTÁRIA: regime + crédito dos dois lados + simulação ─────
    // Importante pra postura consultiva: isto é SÓ a parte tributária (receita,
    // alíquota atual, alíquota da Reforma, crédito de compras, cenários de
    // repasse de preço) — não chega a "lucro líquido" porque custo e despesa
    // geral não vêm do XML fiscal, só da contabilidade do cliente.
    //
    // Limites estruturais que atravessam tudo abaixo:
    // (1) o <CRT> da nota só distingue Simples (1/2), Regime Normal (3) e MEI
    //     (4) — não diz se um Simples aderiu ao regime regular/híbrido (LC
    //     214/2025, art. 41) nem se "Regime Normal" é Presumido ou Real;
    // (2) o regime do DESTINATÁRIO (cliente) não vem em nenhum campo da nota;
    // (3) por isso o regime vem em DUAS CAMADAS — CRT da nota + consulta à
    //     Receita (BrasilAPI) — e ainda assim é só palpite editável; a Receita
    //     vale mais que o CRT quando divergem (cadastro atual × campo
    //     preenchido pelo emissor na data da nota);
    // (4) crédito exige as duas pontas: o vendedor precisa gerar E o comprador
    //     precisa poder usar (regime regular). Fornecedor Simples puro NÃO gera
    //     crédito zero: o comprador aproveita só a parcela de IBS/CBS contida
    //     no DAS (LC 214/2025, art. 47, §9º, II, e LC 123/2006, art. 23, §1º-A e §2º)
    //     — parâmetro "parcial". (Os arts. 155 e 156 da LC 214 NÃO tratam disso: um é
    //     sobre automóvel de pessoa com deficiência, o outro sobre P&D de ICT.)
    // (5) o app NÃO sabe se um optante do Simples escolheu o regime regular de IBS/CBS
    //     (híbrido, LC 214 art. 41 §3º): vira "a confirmar" e o relatório mostra os dois lados.
    const REGIME_OPCOES: { key: string; label: string; gera: boolean; usa: boolean; parcial: boolean; duvida?: boolean }[] = [
      // "a confirmar" se comporta como puro nas contas (hipótese conservadora) e liga a comparação puro × híbrido
      { key: 'simples_duvida', label: 'Simples Nacional (a confirmar)', gera: false, usa: false, parcial: true, duvida: true },
      { key: 'simples_puro', label: 'Simples Nacional (puro)', gera: false, usa: false, parcial: true },
      { key: 'simples_hibrido', label: 'Simples Nacional (híbrido/regular)', gera: true, usa: true, parcial: false },
      { key: 'mei', label: 'MEI', gera: false, usa: false, parcial: false },
      { key: 'presumido', label: 'Lucro Presumido', gera: true, usa: true, parcial: false },
      { key: 'real', label: 'Lucro Real', gera: true, usa: true, parcial: false },
      { key: 'desconhecido', label: 'Não identificado', gera: false, usa: false, parcial: false },
    ];
    const regimeKeyPorCrt = (crt: string): string => crt === '1' || crt === '2' ? 'simples_duvida' : crt === '4' ? 'mei' : crt === '3' ? 'presumido' : 'desconhecido';
    const ehKeySimples = (k: string) => k === 'simples_duvida' || k === 'simples_puro' || k === 'simples_hibrido';
    const labelRegime = (key: string) => REGIME_OPCOES.find(o => o.key === key)?.label || key;
    const opcoesSelectHtml = (defaultKey: string) => REGIME_OPCOES.map(o => `<option value="${o.key}"${o.key === defaultKey ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const numMesesRef = filterMes === 'Todos' ? Math.max(mesesDisponiveis.length, 1) : 1;
    const nl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const sugestaoRegimeBase = (cnpj: string, crt: string): { key: string; crtTxt: string; receitaTxt: string; divergencia: string } => {
      const keyCrt = regimeKeyPorCrt(crt);
      const crtTxt = crt ? (crtLabel[crt] || `CRT ${crt}`) : 'sem CRT';
      const d = cacheRegime[cnpj];
      if (d) {
        let keyApi: string | null = null;
        let txt = '';
        if (d.opcaoMei === true) { keyApi = 'mei'; txt = 'MEI'; }
        else if (d.opcaoSimples === true) { keyApi = 'simples_duvida'; txt = 'Optante do Simples'; }
        else if (d.opcaoSimples === false) { keyApi = 'presumido'; txt = 'Não optante do Simples'; }
        else if (d.opcaoSimples === null) {
          // Conferido na BrasilAPI com Nestlé e PepsiCo (Regime Normal, nunca no Simples):
          // vêm com null — a Receita só registra opção pelo Simples de quem já optou
          // alguma vez, então null = sem opção registrada, não "dado desconhecido".
          // Porte ME/EPP com null fica marcado pra confirmar (pode ser defasagem do cadastro).
          keyApi = 'presumido';
          txt = d.porte && d.porte !== 'DEMAIS' ? 'Sem opção pelo Simples (confirmar)' : 'Sem opção pelo Simples';
        }
        if (keyApi) {
          const simplesCrt = ehKeySimples(keyCrt) || keyCrt === 'mei';
          const simplesApi = ehKeySimples(keyApi) || keyApi === 'mei';
          const diverge = !!crt && simplesCrt !== simplesApi;
          return { key: keyApi, crtTxt, receitaTxt: txt, divergencia: diverge ? 'CRT da nota e Receita divergem — vale a Receita (cadastro atual)' : '' };
        }
        return { key: keyCrt, crtTxt, receitaTxt: 'sem informação do Simples', divergencia: '' };
      }
      return { key: keyCrt, crtTxt, receitaTxt: 'não consultada', divergencia: '' };
    };
    // Sinal de ICMS fora do DAS visto na nota. Só é alerta: o regime e o crédito seguem o padrão conservador.
    // "ICMS por fora" NÃO prova Simples híbrido — o híbrido é opção voluntária no Portal do Simples. O único caso
    // em que ICMS e IBS saem juntos do DAS é o excesso do sublimite de R$ 3,6 mi (LC 123, art. 13-A), e mesmo
    // ali a CBS tende a ficar no DAS.
    const SINAL_TXT: Record<string, string> = {
      crt2: 'CRT 2 na nota: Simples com excesso de sublimite. A partir de 2027 o IBS sai do DAS e a CBS tende a ficar — não é o regime híbrido. Confirme com o fornecedor.',
      cst: 'Destaca ICMS por CST apesar de ser do Simples: pode ser excesso de sublimite com CRT mal preenchido ou cadastro inconsistente. Não prova regime — confirme.',
    };
    const sugestaoRegime = (cnpj: string, crt: string, sinal = '') => ({ ...sugestaoRegimeBase(cnpj, crt), sinal });
    const celulaCamadas = (s: { crtTxt: string; receitaTxt: string; divergencia: string; sinal?: string }) =>
      `<div class="cam-l"><span class="cam-crt">CRT: ${esc(s.crtTxt)}</span> · <span class="cam-rf">Receita: ${esc(s.receitaTxt)}</span></div>${s.divergencia ? `<div class="cam-div">⚠ ${esc(s.divergencia)}</div>` : ''}${s.sinal ? `<div class="cam-div">⚠ ${esc(SINAL_TXT[s.sinal] || '')}</div>` : ''}`;

    const topF = perfilFornecedores.fornecedores.slice(0, 30);
    const topC = perfilClientes.clientes.slice(0, 30);
    const receitaMensal = faturamentoTotal / numMesesRef;
    const fatorComprasPct = mixAliquotas.entradas.total > 0 ? mixAliquotas.entradas.fator * 100 : 100;
    const fatorReceitaPct = mixAliquotas.saidas.total > 0 ? mixAliquotas.saidas.fator * 100 : 100;
    const consumidorValor = Math.max(faturamentoTotal - perfilClientes.totalConsiderado, 0);
    const consumidorPct = faturamentoTotal > 0 ? (consumidorValor / faturamentoTotal) * 100 : 0;
    const totalComprasTop = topF.reduce((s, f) => s + f.totalComprado, 0);
    const sugEmpresa = sugestaoRegime(mainCnpj || '', regimeTributario.crt);

    // tabelas minimalistas (estilo Coopera): sem fundo, hairlines, números à direita
    const tabelaApoio = (t: { colunas?: string[]; linhas?: (string | number)[][] }, limite = 300) => {
      if (!t.colunas || !t.linhas) return '';
      const colunas = t.colunas;
      const ehNum = colunas.map((_, i) => typeof t.linhas![0]?.[i] === 'number');
      const ehMoeda = colunas.map(c => c.includes('R$'));
      return `<div class="tw"><table class="t">
        <thead><tr>${colunas.map((c, i) => `<th class="${ehNum[i] ? 'r' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${t.linhas.slice(0, limite).map(l => `<tr>${l.map((v, i) => `<td class="${ehNum[i] ? 'num' : ''}">${esc(typeof v === 'number' && ehMoeda[i] ? formatarMoeda(v) : v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${t.linhas.length > limite ? `<div class="nota-peq">Mostrando ${limite} de ${t.linhas.length} linha(s) — baixe em Excel pra ver todas.</div>` : ''}</div>`;
    };
    const btnExcel = (id: string, titulo: string) => `<button type="button" class="btn suave" onclick="baixarExcelTopico('${id}','${esc(sanitizarNomeArquivo(titulo))}')">Baixar Excel</button>`;

    const secao = (id: string, titulo: string, meta: string, figRotulo: string, figId: string, figValor: string, corpo: string, aberta: boolean) => ({ id, titulo, html: `
      <details class="sec" id="${id}"${aberta ? ' open' : ''}>
        <summary>
          <span class="mk"></span><span class="idx"></span>
          <span class="sec-titulo"><span class="sec-t">${esc(titulo)}</span><span class="sec-m">${meta}</span></span>
          <span class="sec-fig"><span class="sec-fl">${esc(figRotulo)}</span><span class="sec-fv" id="${figId}">${figValor}</span></span>
        </summary>
        <div class="sec-corpo">${corpo}</div>
      </details>` });
    const subsecao = (titulo: string, contagem: string, corpo: string, aberta = false) => `
      <details class="sub"${aberta ? ' open' : ''}>
        <summary><span class="mk2"></span><span class="sub-t">${esc(titulo)}</span><span class="sub-c">${esc(contagem)}</span></summary>
        <div class="sub-corpo">${corpo}</div>
      </details>`;

    const secoes: { id: string; titulo: string; html: string }[] = [];

    if (temReforma) {
      // 1. Leituras-chave (montadas no navegador, recalculam com as premissas)
      secoes.push(secao('sec-leituras', 'Leituras-chave', 'O que chama atenção, em linguagem direta', 'Pontos', 'figLeituras', '—',
        `<div id="insights" class="insights"></div>`, true));

      // 2. Premissas e regime — o que o Sequência leu, o que é estimativa e a ÚNICA pergunta
      // que só o contador responde (como o Simples recolhe IBS/CBS). Os ids antigos continuam
      // existindo (selRegimeEmpresa oculto, alíquotas em "ajustes avançados") porque o
      // recalcReforma lê os mesmos campos.
      const baseEmpresa = ehKeySimples(sugEmpresa.key) ? 'simples' : sugEmpresa.key;
      const modoEmpresa = opcoes?.modoSimples && baseEmpresa === 'simples' ? opcoes.modoSimples : sugEmpresa.key === 'simples_puro' ? 'puro' : sugEmpresa.key === 'simples_hibrido' ? 'hibrido' : 'duvida';
      const modoConfirmado = !!opcoes?.modoSimples && baseEmpresa === 'simples' && opcoes.modoSimples !== 'duvida';
      const keyEmpresaEfetivo = baseEmpresa === 'simples' ? (modoEmpresa === 'puro' ? 'simples_puro' : modoEmpresa === 'hibrido' ? 'simples_hibrido' : 'simples_duvida') : sugEmpresa.key;
      const optBase = ([['simples', 'Simples Nacional'], ['mei', 'MEI'], ['presumido', 'Lucro Presumido'], ['real', 'Lucro Real'], ['desconhecido', 'Não identificado']] as [string, string][])
        .map(([k, l]) => `<option value="${k}"${k === baseEmpresa ? ' selected' : ''}>${esc(l)}</option>`).join('');
      const optModo = ([['duvida', 'Ainda não sei — mostrar as duas hipóteses'], ['puro', 'Dentro do DAS, como hoje (Simples puro)'], ['hibrido', 'Por fora do DAS, no regime regular (híbrido)']] as [string, string][])
        .map(([k, l]) => `<option value="${k}"${k === modoEmpresa ? ' selected' : ''}>${esc(l)}</option>`).join('');
      const linhaCobertura = (m: { total: number; coberturaPct: number }, semDados: string) => m.total > 0
        ? `Média do código cClassTrib de cada item, ponderada pelo valor · ${formatarPct(m.coberturaPct)}% do valor lido das notas${m.coberturaPct < 90 ? ' <b>(cobertura baixa: o resto entrou como alíquota cheia)</b>' : '; o resto entrou como alíquota cheia'}.`
        : semDados;
      secoes.push(secao('sec-premissas', 'Regime e premissas', 'O que lemos nas notas, o que é estimativa e a pergunta que precisa de você', 'Regime', 'figPremissas', esc(labelRegime(keyEmpresaEfetivo)),
        `<p class="nota">Nem todo número aqui precisa ser preenchido. O Sequência já leu o regime nas notas e na Receita, calculou as alíquotas pelo código de cada item e adotou estimativas de mercado. <b>A única pergunta que só você responde é o passo 2</b> — e, se não souber, as duas respostas aparecem lado a lado. Tudo recalcula as tabelas e leituras da página.</p>
        <div class="campos">
          <label><span class="rot">1 · Regime tributário da empresa</span>
            <select id="selRegimeBase" class="rf-in">${optBase}</select>
            <span class="aj">Notas (CRT): ${esc(sugEmpresa.crtTxt)} · Receita: ${esc(sugEmpresa.receitaTxt)}${sugEmpresa.divergencia ? ` — ⚠ ${esc(sugEmpresa.divergencia)}` : ''}. CRT 3 aparece como "Regime Normal": Presumido × Real não dá pra ver na nota.</span></label>
          <label id="boxModoSimples"><span class="rot">2 · Como a empresa recolhe — ou vai recolher — IBS e CBS?</span>
            <select id="selModoSimples" class="rf-in">${optModo}</select>
            <span class="aj">Só vale para o Simples. Nem a nota nem a Receita informam isso: a opção pelo regime regular é feita pelo próprio contribuinte no Portal do Simples Nacional, por semestre (confira a janela vigente), e o CRT continua 1 ou 2. Pergunta pronta ao cliente: "Você optou pelo regime regular de IBS e CBS, por fora do DAS?"${modoConfirmado ? ' <b>Resposta confirmada ao gerar este relatório.</b>' : ''}</span></label>
          <label><span class="rot">3 · Alíquota-padrão do IVA (IBS + CBS), %</span>
            <input type="text" id="simAliqReforma" class="rf-in" value="26,50" inputmode="decimal">
            <span class="aj">Alíquota cheia em regime pleno (a partir de 2033), antes de qualquer redução. Estimativa de referência: <button type="button" class="link" data-aliq="26,50">26,50%</button> (IBS 17,70 + CBS 8,80) ou <button type="button" class="link" data-aliq="27,97">27,97%</button> (IBS 18,68 + CBS 9,29). A definitiva depende de regulamentação.</span></label>
        </div>
        <select id="selRegimeEmpresa" hidden>${opcoesSelectHtml(keyEmpresaEfetivo)}</select>
        <div class="narr" id="empresaNarrativa"></div>

        <div id="boxComparacao" style="display:none">
          <div class="bl-t">Se for puro × se for híbrido</div>
          <div class="tw"><table class="t">
            <thead><tr><th></th><th class="r">Se for puro (IBS/CBS dentro do DAS)</th><th class="r">Se for híbrido (regime regular)</th></tr></thead>
            <tbody>
              <tr><td>Crédito de IBS/CBS das compras listadas</td><td class="num" id="cmpCredP">—</td><td class="num" id="cmpCredH">—</td></tr>
              <tr><td>Crédito entregue aos clientes com CNPJ</td><td class="num" id="cmpCliP">—</td><td class="num" id="cmpCliH">—</td></tr>
              <tr><td>IBS/CBS sobre as vendas do período</td><td class="num">dentro do DAS</td><td class="num" id="cmpDebH">—</td></tr>
              <tr><td>IBS/CBS líquido (vendas − crédito de compras)</td><td class="num">depende do DAS</td><td class="num" id="cmpLiqH">—</td></tr>
            </tbody>
          </table></div>
          <div class="nota-peq" id="cmpFecho"></div>
        </div>

        <div class="bl-t">O que o Sequência leu nas notas</div>
        <div class="tw"><table class="t">
          <thead><tr><th></th><th class="r">Alíquota efetiva</th><th class="r">Parte da alíquota cheia</th><th>Como foi calculado</th></tr></thead>
          <tbody>
            <tr><td><b>Vendas</b></td><td class="num" id="aliqVendaEf">—</td><td class="num" id="aliqVendaFat">—</td><td class="t-txt">${linhaCobertura(mixAliquotas.saidas, 'Sem NF-e de saída lida: assumido alíquota cheia.')}<span id="aliqVendaAj"></span></td></tr>
            <tr><td><b>Compras</b></td><td class="num" id="aliqCompraEf">—</td><td class="num" id="aliqCompraFat">—</td><td class="t-txt">${linhaCobertura(mixAliquotas.entradas, 'Sem NF-e de entrada lida: assumido alíquota cheia.')}<span id="aliqCompraAj"></span></td></tr>
          </tbody>
        </table></div>
        <div class="nota-peq">Calculado pelo Sequência — não precisa preencher. "100% da cheia" quer dizer que nenhum item tem alíquota zero ou reduzida; "82% da cheia" quer dizer que, em média, o valor paga 82% da alíquota-padrão (o resto é zero ou reduzido). A alíquota efetiva é a alíquota-padrão × essa parte, e é ela que entra no crédito e no débito.</div>

        <details class="como" id="boxAvancado"><summary>Ajustes avançados — estimativas que você pode refinar</summary>
          <div class="campos">
            <label><span class="rot">Crédito que fornecedor do Simples repassa (% da compra)</span>
              <input type="text" id="inpParcial" class="rf-in" value="3,40" inputmode="decimal">
              <span class="aj">Hipótese, não dado das notas. O fornecedor do Simples que não optou pelo regime regular só repassa o IBS/CBS que paga dentro do DAS (LC 214, art. 47, §9º, II; LC 123, art. 23, §1º-A), e a alíquota precisa vir informada na nota (LC 123, art. 23, §2º). Depende da faixa de faturamento dele. Referência de regime pleno (2033), comércio e indústria, faturamento anual até <button type="button" class="link" data-parcial="2,00">R$ 180 mil: 2,0%</button> · <button type="button" class="link" data-parcial="2,50">R$ 360 mil: 2,5%</button> · <button type="button" class="link" data-parcial="3,40">R$ 720 mil: 3,4%</button> · <button type="button" class="link" data-parcial="4,40">R$ 1,8 mi: 4,4%</button> · <button type="button" class="link" data-parcial="5,40">R$ 3,6 mi: 5,4%</button>. Serviços chegam a 3%–10%. Em 2027–2028 o crédito é bem menor (cerca de 0,6% a 1,8%) e em 2026 o Simples ainda não gera crédito. <span id="sensParcial"></span></span></label>
            <label><span class="rot">Ajustar manualmente — alíquota sobre as vendas (% da cheia)</span>
              <input type="text" id="simFatorReceita" class="rf-in" value="${nl(fatorReceitaPct)}" data-calc="${fatorReceitaPct.toFixed(4)}" inputmode="decimal">
              <span class="aj">Use só se o Sequência leu pouco das notas (cobertura baixa). O valor calculado é ${nl(fatorReceitaPct)}%; <button type="button" class="link" data-fator="simFatorReceita">voltar ao calculado</button>.</span></label>
            <label><span class="rot">Ajustar manualmente — alíquota sobre as compras (% da cheia)</span>
              <input type="text" id="inpFatorCompras" class="rf-in" value="${nl(fatorComprasPct)}" data-calc="${fatorComprasPct.toFixed(4)}" inputmode="decimal">
              <span class="aj">O valor calculado é ${nl(fatorComprasPct)}%; <button type="button" class="link" data-fator="inpFatorCompras">voltar ao calculado</button>. A média das compras vale igual para todos os fornecedores.</span></label>
          </div>
        </details>

        <details class="como"><summary>Como o regime é verificado — e o que nenhuma camada enxerga</summary>
          <div class="nota">Camada 1: o CRT da nota (1 e 2 = Simples Nacional, 3 = Regime Normal, 4 = MEI). Camada 2: a consulta à Receita Federal (BrasilAPI), que diz se a empresa é optante do Simples ou MEI hoje — quando as duas divergem, vale a Receita. Nenhuma das duas enxerga se um Simples optou pelo regime regular de IBS/CBS (híbrido; LC 214/2025, art. 41, §3º): essa opção é feita no Portal do Simples e o CRT da nota continua 1 ou 2. O mesmo vale para "Regime Normal" ser Presumido ou Real, e para o regime de quem compra da empresa, que não vem na nota. Por isso o que está pré-preenchido é palpite, não confirmação. A presença do grupo IBS/CBS na nota também não distingue os dois casos. O XML mostra o regime declarado pelo emitente na data da nota: não prova ICMS recolhido fora do DAS nem opção pelo regime híbrido — a falta de ICMS na nota ou no PGDAS-D pode vir de substituição tributária, isenção, serviço ou segregação de receita. Há um único sinal direto: CRT 2 (Simples com excesso de sublimite de R$ 3,6 milhões), em que ICMS, ISS e IBS saem do DAS e a CBS tende a ficar — por isso o crédito do comprador poderia ser cheio só para o IBS. Isso não é o híbrido, que é opção voluntária, semestral, feita no Portal do Simples.</div>
        </details>`, true));

      // 3. Cadeia: impacto por tipo de relação (a tabela-resumo)
      secoes.push(secao('sec-cadeia', 'Cadeia de valor — quem compra e de quem se compra', 'O que muda, na Reforma, em cada tipo de relação comercial', 'Crédito em jogo', 'figCadeia', '—',
        `<p class="nota">Cada linha agrupa as relações da empresa pelo regime do outro lado. "Crédito" é o IBS/CBS que volta (compras) ou que é entregue (vendas). Troque o regime de qualquer fornecedor ou cliente nas tabelas abaixo e esta tabela acompanha.</p>
        <div class="tw"><table class="t">
          <thead><tr><th>Relação</th><th class="r">Volume (R$)</th><th class="r">% do lado</th><th class="r">Crédito (R$)</th><th>O que muda</th><th>O que fazer</th></tr></thead>
          <tbody id="cadeiaCorpo"></tbody>
        </table></div>`, true));
    }

    // 4. Fornecedores
    if (topF.length > 0) {
      const sug = topF.map(f => ({ f, s: sugestaoRegime(f.cnpj, f.crtDeclarado, f.sinalIcmsFora) }));
      dadosParaExcel['reforma-fornecedores'] = {
        colunas: ['Fornecedor', 'CNPJ', 'CRT declarado', 'Receita (BrasilAPI)', 'Total Comprado (R$)', 'Regime sugerido'],
        linhas: sug.map(({ f, s }) => [f.nome, f.cnpj, s.crtTxt, s.receitaTxt, f.totalComprado, labelRegime(s.key)]),
      };
      secoes.push(secao('sec-fornecedores', 'Fornecedores — regime e crédito', `${topF.length === perfilFornecedores.fornecedores.length ? `${topF.length} fornecedor(es)` : `${topF.length} maiores de ${perfilFornecedores.fornecedores.length} fornecedores`} · ${esc(formatarMoeda(totalComprasTop))} em compras`, 'Crédito perdido', 'figForn', '—',
        `<p class="nota">Comprar de fornecedor em Regime Normal devolve o IBS/CBS como crédito; comprar de fornecedor do Simples que não optou pelo regime regular devolve só a parcela do DAS. A lista mostra quanto crédito cada fornecedor gera e onde vale renegociar. Só as NF-e de entrada anexadas entram — se faltou nota de compra, o número real é maior.</p>
        <div class="tw"><table class="t">
          <thead><tr><th>Fornecedor</th><th>Regime (verificação em 2 camadas)</th><th class="r">Compras (R$)</th><th class="r">Crédito estimado (R$)</th><th>Impacto e ação</th></tr></thead>
          <tbody>
            ${sug.map(({ f, s }, i) => `<tr class="rf-linha${i >= 10 ? ' extra' : ''}">
              <td><div class="ent-n">${esc(f.nome)}</div><div class="ent-s">${esc(formatCnpj(f.cnpj))} · última compra ${esc(dataFmt(f.ultimaCompra))}</div></td>
              <td class="cam-cell" data-cnpj="${esc(f.cnpj)}" data-crt="${esc(f.crtDeclarado)}"><select class="rf-in sel-regime-fornecedor" data-total="${f.totalComprado}" data-sinal="${esc(f.sinalIcmsFora)}">${opcoesSelectHtml(s.key)}</select>${celulaCamadas(s)}</td>
              <td class="num">${formatarMoeda(f.totalComprado)}</td>
              <td class="num cred-cell">—</td>
              <td class="imp-cell">—</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        <div class="acoes">
          ${sug.length > 10 ? `<button type="button" class="btn btn-mais" data-n="${sug.length}">Mostrar todos os ${sug.length}</button>` : ''}
          <button type="button" class="btn suave btn-consulta-rf" data-alvo="sel-regime-fornecedor">Atualizar consulta à Receita Federal</button>
          ${btnExcel('reforma-fornecedores', 'Fornecedores e regime')}
          <span class="nota-peq" id="consultaStatus-sel-regime-fornecedor"></span>
        </div>
        <div class="nota-peq">Total das compras listadas <b id="fornTotalCompras">—</b> · crédito estimado <b id="fornCredito">—</b> · crédito que deixa de existir pelo regime dos fornecedores <b id="fornCreditoPerdido">—</b> (<span id="fornPctPerdido">—</span>% do crédito cheio possível).</div>`, false));
    }

    // 5. Clientes
    if (temReforma) {
      const sugC = topC.map(c => ({ c, s: sugestaoRegime(c.cnpj, '') }));
      const totalVendasTopC = topC.reduce((s, c) => s + c.totalComprado, 0);
      if (topC.length > 0) {
        dadosParaExcel['reforma-clientes'] = {
          colunas: ['Cliente', 'CNPJ', 'Receita (BrasilAPI)', 'Vendas (R$)', 'Regime sugerido'],
          linhas: sugC.map(({ c, s }) => [c.nome, c.cnpj, s.receitaTxt, c.totalComprado, labelRegime(s.key)]),
        };
      }
      secoes.push(secao('sec-clientes', 'Clientes — quem compra de você', topC.length > 0 ? `${topC.length === perfilClientes.clientes.length ? `${topC.length} cliente(s)` : `${topC.length} maiores de ${perfilClientes.clientes.length} clientes`} com CNPJ · ${esc(formatarMoeda(totalVendasTopC))} em vendas` : 'Nenhum comprador com CNPJ nas NF-e do período', 'Vantagem a ganhar', 'figCli', '—',
        `<p class="nota">Crédito exige as duas pontas: o cliente só aproveita o IBS/CBS se ele próprio estiver no regime regular (Presumido, Real ou Simples híbrido). Cliente Simples puro ou MEI não usa crédito, então vender com ou sem crédito dá no mesmo; já quem revende ou industrializa em Regime Normal compara fornecedores pelo preço líquido do crédito.</p>
        <div class="tw"><table class="t">
          <thead><tr><th>Cliente</th><th>Regime (verificação em 2 camadas)</th><th class="r">Vendas (R$)</th><th class="r">Crédito que recebe (R$)</th><th>Impacto e ação</th></tr></thead>
          <tbody>
            <tr class="rf-cons"><td><div class="ent-n">Consumidor final</div><div class="ent-s">NFC-e e vendas sem CNPJ de comprador</div></td><td>—</td><td class="num">${formatarMoeda(consumidorValor)}</td><td class="num">—</td>
              <td class="imp-cell"><span class="tag tag-info">Sem crédito</span> <span class="imp-t">${formatarPct(consumidorPct)}% do faturamento. O consumidor não aproveita crédito: com o imposto por fora o preço final sobe, e o repasse depende de quanto ele aceita (veja o simulador).</span></td></tr>
            ${sugC.map(({ c, s }, i) => `<tr class="rf-linha${i >= 10 ? ' extra' : ''}">
              <td><div class="ent-n">${esc(c.nome)}</div><div class="ent-s">${esc(formatCnpj(c.cnpj))} · última compra ${esc(dataFmt(c.ultimaCompra))}</div></td>
              <td class="cam-cell" data-cnpj="${esc(c.cnpj)}" data-crt=""><select class="rf-in sel-regime-cliente" data-total="${c.totalComprado}">${opcoesSelectHtml(s.key)}</select>${celulaCamadas(s)}</td>
              <td class="num">${formatarMoeda(c.totalComprado)}</td>
              <td class="num cli-cred">—</td>
              <td class="imp-cell">—</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        <div class="acoes">
          ${sugC.length > 10 ? `<button type="button" class="btn btn-mais" data-n="${sugC.length}">Mostrar todos os ${sugC.length}</button>` : ''}
          ${topC.length > 0 ? `<button type="button" class="btn suave btn-consulta-rf" data-alvo="sel-regime-cliente">Atualizar consulta à Receita Federal</button>${btnExcel('reforma-clientes', 'Clientes e regime')}` : ''}
          <span class="nota-peq" id="consultaStatus-sel-regime-cliente"></span>
        </div>
        ${topC.length > 0 ? `<div class="nota-peq">Vendas a quem aproveita crédito <b id="cliVendasAprov">—</b> · a quem não aproveita <b id="cliVendasNao">—</b> · regime não identificado <b id="cliVendasDesc">—</b>. Crédito entregue hoje <b id="cliCredito">—</b>; com crédito cheio seria <b id="cliCreditoPleno">—</b> — a diferença (<b id="cliCreditoDif">—</b>) é a vantagem que um concorrente em Regime Normal leva sobre a empresa, a preço igual.</div>` : `<div class="nota">Nenhuma NF-e de venda do período identifica um comprador com CNPJ — a venda é a consumidor final, onde crédito não se aplica. Se a empresa também vende a revendedores ou outras empresas, anexe essas NF-e pra este quadro mostrar quem aproveita o crédito.</div>`}`, false));
    }

    // 6. Mix de alíquotas
    if (mixAliquotas.saidas.total > 0 || mixAliquotas.entradas.total > 0) {
      const nomeLado = { saidas: 'Vendas', entradas: 'Compras' } as const;
      const linhasMix: (string | number)[][] = [];
      (['saidas', 'entradas'] as const).forEach(l => {
        const m = mixAliquotas[l];
        m.porCodigo.slice(0, 8).forEach(c => {
          linhasMix.push([nomeLado[l], c.code === 'sem-grupo' ? 'Sem o grupo IBS/CBS' : `${c.code} — ${c.nome}`, c.efeito, c.valor, `${formatarPct(m.total > 0 ? (c.valor / m.total) * 100 : 0)}%`]);
        });
        if (m.porCodigo.length > 8) {
          const resto = m.porCodigo.slice(8).reduce((s, c) => s + c.valor, 0);
          linhasMix.push([nomeLado[l], `Outros ${m.porCodigo.length - 8} código(s)`, 'Variado', resto, `${formatarPct(m.total > 0 ? (resto / m.total) * 100 : 0)}%`]);
        }
      });
      const mixT = { colunas: ['Lado', 'Código / situação', 'Efeito na alíquota', 'Valor (R$)', '% do lado'], linhas: linhasMix };
      dadosParaExcel['reforma-mix'] = mixT;
      const totSaidasMix = mixAliquotas.saidas.total;
      const prodT = {
        colunas: ['Produto', 'Código cClassTrib usado', 'Efeito na alíquota', 'Valor vendido (R$)', '% das vendas'],
        linhas: mixAliquotas.saidas.topProdutos.map(p => [
          p.xProd,
          p.code === 'sem-grupo' ? 'Sem o grupo IBS/CBS' : `${p.code}${p.nome ? ` — ${p.nome}` : ''}${p.nCodigos > 1 ? ` (+${p.nCodigos - 1} outro(s) código(s))` : ''}`,
          p.efeito, p.valor, `${formatarPct(totSaidasMix > 0 ? (p.valor / totSaidasMix) * 100 : 0)}%`,
        ]) as (string | number)[][],
      };
      dadosParaExcel['reforma-produtos-class'] = prodT;
      const nProdMulti = mixAliquotas.saidas.topProdutos.filter(p => p.nCodigos > 1).length;
      secoes.push(secao('sec-mix', 'Mix de alíquotas (cClassTrib)', 'Quanto das vendas e compras paga alíquota cheia, reduzida ou zero', 'Alíquota média das vendas', 'figMix', mixAliquotas.saidas.total > 0 ? `${formatarPct(mixAliquotas.saidas.fator * 100)}% da cheia` : '—',
        `<p class="nota">Lido direto do código cClassTrib de cada item, comparado com a tabela oficial — o app não interpreta nome de produto nem NCM. Alíquota zero e reduzida aparecem quando o emissor já classifica o item (ex.: Anexo I da LC 214/2025, cesta básica, onde está o pão francês). Item sem o grupo IBS/CBS é assumido em alíquota cheia, por isso a cobertura importa: vendas com o grupo em ${formatarPct(mixAliquotas.saidas.coberturaPct)}% do valor, compras em ${formatarPct(mixAliquotas.entradas.coberturaPct)}%.</p>
        ${subsecao('Por código de classificação', `${mixAliquotas.saidas.porCodigo.length + mixAliquotas.entradas.porCodigo.length} linha(s)`, `${tabelaApoio(mixT)}<div class="acoes">${btnExcel('reforma-mix', 'Mix de aliquotas')}</div>`, true)}
        ${prodT.linhas.length > 0 ? subsecao('Principais produtos vendidos e o código usado', `${prodT.linhas.length} produto(s)`, `<p class="nota">Cada linha mostra o código que o sistema emissor da empresa aplica ao produto (o dominante por valor). Vale conferir se o enquadramento — zero, reduzido ou integral — corresponde ao produto: classificar a mais significa imposto pago a mais; classificar a menos expõe a empresa a autuação.${nProdMulti > 0 ? ` <b>${nProdMulti} produto(s) desta lista saem com mais de um código</b> — sinal de cadastro inconsistente.` : ''}</p>${tabelaApoio(prodT)}<div class="acoes">${btnExcel('reforma-produtos-class', 'Produtos e classificacao')}</div>`, false) : ''}`, false));
    }

    // 7. Simulador de preço
    if (temReforma && faturamentoTotal > 0) {
      const totalIbsCbsTeste = auditoriaClassTrib.totalIBS + auditoriaClassTrib.totalCBS;
      const baseComGrupo = auditoriaClassTrib.codigosUsados.reduce((s, c) => s + c.valor, 0);
      const pctTesteReal = baseComGrupo > 0 ? (totalIbsCbsTeste / baseComGrupo) * 100 : 0;
      secoes.push(secao('sec-simulador', 'Simulador — impacto no preço', `Receita de ${esc(formatarMoeda(receitaMensal))} por mês${numMesesRef > 1 ? ` (média de ${numMesesRef} meses)` : ''}, já com o crédito de compras`, 'Reprecificação p/ manter a margem', 'figSim', '—',
        `<p class="nota">Quanto o preço precisa subir pra manter a margem de hoje, e o que sobra em cada cenário de repasse. "Margem disponível" = receita − débito de IBS/CBS + crédito de compras: é o que cobre custo, despesa e lucro — não é o lucro líquido, que também depende de custo e despesa (fora do XML fiscal). O crédito vem da tabela de fornecedores; o custo de compra é suposto constante (o repasse de preço dos fornecedores não está modelado).${pctTesteReal > 0 ? ` Só como contexto: o sistema do cliente já destaca ${formatarPct(pctTesteReal)}% de IBS+CBS nas notas — é a alíquota do período de teste (2026), não a final; não use na simulação.` : ''}</p>
        <div class="aviso" id="simAviso"></div>
        <div class="campos">
          <label><span class="rot">Receita bruta (R$/mês)</span>
            <input type="text" id="simReceita" class="rf-in" value="${nl(receitaMensal)}" inputmode="decimal"></label>
          <label><span class="rot">Alíquota atual sobre a receita (%)</span>
            <input type="text" id="simAliqAtual" class="rf-in" value="0,00" inputmode="decimal">
            <span class="aj">carga efetiva de hoje (DAS, Presumido ou Real) — o XML não calcula; regime declarado: ${esc(regimeTributario.label || 'não identificado')}</span></label>
          <label><span class="rot">Crédito de IBS/CBS sobre compras (R$/mês)</span>
            <input type="text" id="simCredito" class="rf-in-manual" value="0,00" inputmode="decimal">
            <span class="aj">automático pela tabela de fornecedores — digite pra sobrescrever <button type="button" class="link" id="btnCreditoAuto">voltar ao automático</button></span></label>
        </div>
        <div class="destaque" id="simResumo"></div>
        <div class="tw"><table class="t">
          <thead><tr><th>Cenário de repasse ao preço</th><th class="r">Receita necessária</th><th class="r">Débito IBS/CBS</th><th class="r">Crédito de compras</th><th class="r">Margem disponível</th><th class="r">Diferença vs. hoje</th></tr></thead>
          <tbody id="simCorpo"></tbody>
        </table></div>`, false));
    }

    // 8. Prontidão para a Reforma — a "reforma estrutural" da apresentação (obtenção e
    // emissão de NFs, controle de informações, contabilidade, contratos), lida dos
    // sinais que as auditorias do analista já produzem. O que o XML não enxerga entra
    // como "perguntar ao cliente" em vez de ser chutado.
    if (temReforma) {
      type Prontidao = { ind: string; st: 'ok' | 'atencao' | 'info'; dado: string; porque: string };
      const itensPr: Prontidao[] = [];
      const faltantesLiq = (analysis || []).reduce((s, x) => s + x.faltantes.length, 0);
      itensPr.push({
        ind: 'Sequência das notas emitidas',
        st: faltantesLiq === 0 ? 'ok' : 'atencao',
        dado: faltantesLiq === 0 ? 'Sequência completa: nenhum número de nota ficou sem registro.' : `${faltantesLiq.toLocaleString('pt-BR')} número(s) de nota sem registro no período (nem como inutilizado) — vale conferir.`,
        porque: 'Com cruzamento automático das notas e split payment, número que falta vira diferença de débito difícil de explicar.',
      });
      const nAutoriz = notasAnomalias.semAutorizacaoNaoContingencia.length;
      const nPrazo = notasAnomalias.foraDoPrazo.length;
      const nMalf = notasAnomalias.malformadas.length;
      const nDup = notasAnomalias.numeroDuplicado.length;
      const nHomolog = notasHomologacao.total;
      const nProblemas = nAutoriz + nPrazo + nMalf + nDup + nHomolog;
      itensPr.push({
        ind: 'Notas fora do padrão',
        st: nProblemas === 0 ? 'ok' : 'atencao',
        dado: nProblemas === 0 ? 'Nenhuma nota sem autorização, fora do prazo, malformada, duplicada ou de homologação.' : [
          nAutoriz ? `${nAutoriz} sem autorização` : '', nPrazo ? `${nPrazo} autorizada(s) fora do prazo` : '', nMalf ? `${nMalf} malformada(s)` : '',
          nDup ? `${nDup} número(s) duplicado(s)` : '', nHomolog ? `${nHomolog} de homologação (teste)` : '',
        ].filter(Boolean).join(' · '),
        porque: 'Assertividade na emissão: nota fora do padrão não gera crédito confiável pro comprador e pode ser questionada na fiscalização.',
      });
      if (mixAliquotas.saidas.total > 0) {
        const meses = mixAliquotas.saidas.porMes;
        const ultimo = meses[meses.length - 1];
        const ehSimplesEmp = regimeTributario.isSimples || regimeTributario.isMei;
        itensPr.push({
          ind: 'Grupo IBS/CBS na nota (sistema emissor adaptado)',
          st: ehSimplesEmp ? 'info' : (ultimo && ultimo.pct >= 99 ? 'ok' : 'atencao'),
          dado: `${meses.map(m => `${m.mes}: ${formatarPct(m.pct)}%`).join(' · ')} do valor das vendas com o grupo preenchido.`,
          porque: ehSimplesEmp ? 'Simples Nacional só passa a ser obrigado em 01/01/2027 (Ato Conjunto RFB/CGIBS nº 4/2026).' : 'Obrigatório nas NF-e desde 03/08/2026 (Ato Conjunto RFB/CGIBS nº 4/2026) — mês anterior a isso sem o grupo é esperado.',
        });
      }
      if (auditoriaClassTrib.totalItens > 0) {
        const nErros = auditoriaClassTrib.problemas.length;
        itensPr.push({
          ind: 'Classificação tributária (cClassTrib)',
          st: nErros > 0 || auditoriaClassTrib.cclassTribUnicoSuspeito ? 'atencao' : 'ok',
          dado: nErros > 0 ? `${nErros} inconsistência(s) em ${auditoriaClassTrib.totalItens} itens conferidos contra a tabela oficial.` : auditoriaClassTrib.cclassTribUnicoSuspeito ? `Um único código em todo o período, apesar de ${auditoriaClassTrib.ncmsDistintos} NCMs distintos no cadastro.` : `${auditoriaClassTrib.totalItens} itens conferidos, sem inconsistência estrutural.`,
          porque: 'Classificar errado muda o imposto: item de alíquota zero saindo como integral gera imposto pago a mais; o contrário gera risco de autuação.',
        });
      }
      if (auditoriaPagamento.totalCartao > 0) {
        const pctInt = (auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100;
        itensPr.push({
          ind: 'Meios de pagamento (rastreabilidade)',
          st: pctInt >= 95 && auditoriaPagamento.totalFalsoTef === 0 ? 'ok' : 'atencao',
          dado: `${formatarPct(pctInt)}% das vendas em cartão integradas ao TEF · ${auditoriaPagamento.totalNaoIntegrado} em POS manual · ${auditoriaPagamento.totalFalsoTef} falso TEF.`,
          porque: 'O split payment separa o imposto na liquidação do pagamento: venda sem rastro de pagamento fica sem como provar o débito recolhido.',
        });
      }
      itensPr.push({
        ind: 'Notas de compra (o crédito depende de ter a nota)',
        st: 'info',
        dado: `${perfilFornecedores.fornecedores.length} fornecedor(es) nas NF-e de entrada; compras identificadas equivalem a ${formatarPct(faturamentoTotal > 0 ? (perfilFornecedores.totalConsiderado / faturamentoTotal) * 100 : 0)}% da receita do período.`,
        porque: 'Compra sem nota não gera crédito. Se o custo real de mercadoria for maior que isso, falta nota de entrada — vale confirmar se todas as compras estão sendo lançadas com nota.',
      });
      itensPr.push({
        ind: 'Controle financeiro, ERP, contabilidade e contratos',
        st: 'info',
        dado: 'Não aparecem nas notas fiscais — vale levantar com a empresa.',
        porque: 'São pontos estruturais da preparação: controle financeiro profissional, ERP, contabilidade fechada em dia e contratos com cláusula de revisão de preços.',
      });
      const nAtencaoPr = itensPr.filter(i => i.st === 'atencao').length;
      const tagPr = { ok: '<span class="tag tag-ok">Em dia</span>', atencao: '<span class="tag tag-media">Atenção</span>', info: '<span class="tag tag-info">Verificar</span>' };
      secoes.push(secao('sec-prontidao', 'Prontidão para a Reforma', 'Como a empresa está preparada para emitir, receber e controlar as notas', 'Pontos de atenção', 'figProntidao', String(nAtencaoPr),
        `<p class="nota">A Reforma não é só sobre alíquota: ela cobra assertividade na emissão e na obtenção das notas, rastro do pagamento e controle. Estes sinais saem das próprias notas do período — sequência, autorização, grupo IBS/CBS, classificação e meios de pagamento — lidos como o preparo da empresa para a Reforma.</p>
        <div class="tw"><table class="t">
          <thead><tr><th>Indicador</th><th>Situação</th><th>O que o dado mostra</th><th>Por que importa na Reforma</th></tr></thead>
          <tbody>${itensPr.map(i => `<tr><td><b>${esc(i.ind)}</b></td><td>${tagPr[i.st]}</td><td class="t-txt">${esc(i.dado)}</td><td class="t-txt">${esc(i.porque)}</td></tr>`).join('')}</tbody>
        </table></div>`, false));

      // 9. Calendário da transição + roteiro da conversa (próximos passos)
      const calendario = {
        colunas: ['Ano', 'O que muda', 'Para a empresa'],
        linhas: [
          ['2026', 'Ano de teste: CBS 0,9% e IBS 0,1% destacados nas notas (compensáveis); grupo IBS/CBS passa a aparecer na NF-e.', 'Adaptar o sistema emissor e o cadastro de produtos; ainda sem custo efetivo.'],
          ['2027', 'PIS e COFINS dão lugar à CBS; entra o Imposto Seletivo; o Simples Nacional passa a destacar o grupo IBS/CBS.', 'Primeira reprecificação: imposto por fora e crédito amplo.'],
          ['2028', 'Sem mudança de alíquota.', 'Ano pra ajustar preços, contratos e fornecedores.'],
          ['2029 a 2032', 'IBS sobe 10%, 20%, 30% e 40% da alíquota final, enquanto ICMS e ISS caem na mesma proporção; benefícios fiscais são afetados.', 'Uma janela de reprecificação por ano.'],
          ['2033', 'Sistema consolidado: IBS e CBS plenos; ICMS, ISS, PIS e COFINS extintos.', 'Regime final — preços e margens já recalibrados.'],
        ] as (string | number)[][],
      };
      const passos: { prazo: 'alta' | 'media' | 'info'; rotulo: string; titulo: string; texto: string }[] = [
        { prazo: 'alta', rotulo: 'Curto prazo', titulo: 'Reprecificar', texto: 'Use o simulador por janela (2027 em diante) e revise contratos com cláusula de reajuste de preço. São 7 janelas de reajuste ao longo da transição: 2026, 2027 e 2029 a 2033.' },
        { prazo: 'alta', rotulo: 'Curto prazo', titulo: 'Fornecedores', texto: 'Renegociar regime e preço com quem mais custa crédito e confirmar o regime dos que não foram identificados — a lista está acima.' },
        { prazo: 'alta', rotulo: 'Curto prazo', titulo: 'Regime da empresa', texto: 'Comparar Simples, Simples híbrido, Presumido e Real com crédito amplo e imposto por fora — definir o regime adequado é uma das decisões centrais da transição.' },
        { prazo: 'media', rotulo: 'Médio prazo', titulo: 'Caixa', texto: 'O IBS/CBS vem por fora no preço de compra e só volta como crédito na apuração. Desenhar o ciclo recebimento × pagamento e o efeito do split payment antes de 2027.' },
        { prazo: 'media', rotulo: 'Médio prazo', titulo: 'Controles', texto: 'ERP e controle financeiro, 100% das compras com nota e contabilidade fechada em dia — o combate à sonegação tira a margem pra informalidade.' },
        { prazo: 'info', rotulo: 'Levantar', titulo: 'Fora das notas de mercadoria', texto: 'Aluguel, energia, telecom, frete, ativo imobilizado e empréstimos mudam com a base ampla: geram crédito (ou débito, pra quem aluga imóvel ou empresta dinheiro). Não aparecem nestas notas — vale levantar com a empresa.' },
      ];
      secoes.push(secao('sec-calendario', 'Calendário e próximos passos', 'Linha do tempo da transição e próximos passos sugeridos', 'Primeira janela', 'figCalendario', '2027',
        `${subsecao('Linha do tempo da transição (2026–2033)', '5 marcos', tabelaApoio(calendario), true)}
        ${subsecao('Próximos passos sugeridos', `${passos.length} frentes`, `<div class="insights">${passos.map(p => `<div class="ins"><div class="tg"><span class="tag tag-${p.prazo}">${esc(p.rotulo)}</span></div><div class="tx"><b>${esc(p.titulo)}.</b> ${esc(p.texto)}</div></div>`).join('')}</div>`, true)}`, false));
    }

    // 10. Dados de apoio (perfil bruto: quem compra, de quem compra, produtos, sazonalidade)
    const ordemApoio: Area[] = ['perfil', 'fornecedores', 'ranking', 'sazonalidade'];
    const apoioSubs = topicos.filter(t => ordemApoio.includes(t.area)).sort((a, b) => ordemApoio.indexOf(a.area) - ordemApoio.indexOf(b.area));
    if (apoioSubs.length > 0) {
      secoes.push(secao('sec-apoio', 'Dados de apoio', 'Perfil bruto extraído dos XMLs — principais clientes e fornecedores, produtos e sazonalidade', 'Tabelas', 'figApoio', String(apoioSubs.length),
        apoioSubs.map(t => subsecao(t.titulo, t.resumo, `<p class="nota">${t.corpo}</p>${tabelaApoio(t)}${t.colunas && t.linhas && t.linhas.length > 0 ? `<div class="acoes">${btnExcel(t.id, t.titulo)}</div>` : ''}`)).join(''), false));
    }

    const totalAtencao = topicos.filter(t => t.nivel === 'atencao').length;
    const nomeEmpresaGrande = empresa.length > 26;
    const periodoLegivel = filterMes !== 'Todos'
      ? filterMes
      : mesesDisponiveis.length > 1
        ? `${mesesDisponiveis.slice(0, -1).join(', ')} e ${mesesDisponiveis[mesesDisponiveis.length - 1]}`
        : (mesesDisponiveis[0] || periodo);
    const rotuloNav: Record<string, string> = {
      'sec-leituras': 'Leituras', 'sec-premissas': 'Regime', 'sec-cadeia': 'Cadeia', 'sec-fornecedores': 'Fornecedores',
      'sec-clientes': 'Clientes', 'sec-mix': 'Mix', 'sec-simulador': 'Simulador', 'sec-prontidao': 'Prontidão',
      'sec-calendario': 'Calendário', 'sec-apoio': 'Apoio',
    };

    const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perfil do Cliente — ${esc(empresa)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>
<style>
  /* Linguagem visual do relatório Coopera / Contador de Padarias: ink quente, dourado,
     Newsreader nos números e títulos, hairlines no lugar de caixas, zero radius. */
  :root { --ink:#17150F; --gold:#C9A227; --gold-t:#9A7B12; --bg:#FCFBF8; --g1:#5E594F; --g2:#78736A; --g3:#A29C92; --l1:#E5E0D6; --l2:#EFEBE3; }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; scroll-padding-top:84px; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font-family:'IBM Plex Sans',sans-serif; }
  .top { background:var(--ink); padding:20px 40px; display:flex; align-items:center; justify-content:space-between; gap:24px; position:sticky; top:0; z-index:20; }
  .top img { width:150px; display:block; }
  .top nav { display:flex; gap:22px; flex-wrap:wrap; justify-content:flex-end; }
  .top nav a { font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:#A8A29A; text-decoration:none; }
  .top nav a:hover { color:var(--gold); }
  .wrap { max-width:1180px; margin:0 auto; padding:48px 40px 80px; counter-reset:sec; }
  .h1a, .h1b { font-family:Newsreader,serif; font-size:44px; line-height:1.1; font-weight:400; letter-spacing:-.01em; }
  .h1b { font-style:italic; color:var(--gold-t); }
  .h1b.menor { font-size:34px; }
  .regua { width:60px; height:3px; background:var(--gold); margin:20px 0; }
  .lede { font-size:16px; line-height:1.65; color:var(--g1); max-width:720px; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--l1); border-bottom:1px solid var(--l1); margin-top:36px; }
  .kpi { padding:22px 24px; border-left:1px solid var(--l1); }
  .kpi:first-child { padding-left:0; border-left:0; }
  .kpi:last-child { padding-right:0; }
  .k-r { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--g2); }
  .k-v { font-family:Newsreader,serif; font-size:24px; font-weight:500; margin-top:8px; }
  .k-s { font-size:11.5px; color:var(--g2); margin-top:4px; }
  .kpi.dest .k-r, .kpi.dest .k-v { color:var(--gold-t); }
  .barra { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:36px 0 18px; border-bottom:1px solid var(--l1); }
  .barra .info { flex:1; min-width:200px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--g3); }
  .btn { padding:11px 18px; font-family:inherit; font-size:13px; letter-spacing:.04em; color:var(--ink); background:transparent; border:1px solid var(--ink); border-radius:0; cursor:pointer; }
  .btn.suave { color:var(--g1); border-color:var(--l1); }
  .btn:hover { background:var(--ink); border-color:var(--ink); color:var(--bg); }
  .btn:disabled { opacity:.5; cursor:wait; }
  .link { font:inherit; font-size:11.5px; color:var(--gold-t); background:none; border:0; padding:0; text-decoration:underline; cursor:pointer; }

  details.sec { border-top:1px solid var(--l1); }
  details.sec:last-of-type { border-bottom:1px solid var(--l1); }
  details.sec > summary, details.sub > summary { list-style:none; cursor:pointer; }
  details > summary::-webkit-details-marker { display:none; }
  details.sec > summary { display:flex; align-items:center; gap:18px; padding:16px 0; }
  .mk { width:26px; flex:0 0 auto; font-size:16px; line-height:1; color:var(--gold); text-align:center; font-weight:500; }
  .mk::before { content:'+'; }
  details[open] > summary > .mk::before { content:'−'; }
  .idx { width:32px; flex:0 0 auto; font-family:Newsreader,serif; font-size:15px; color:var(--g3); }
  details.sec .idx::before { counter-increment:sec; content:counter(sec); }
  .sec-titulo { flex:1 1 0; min-width:0; }
  .sec-t { display:block; font-family:Newsreader,serif; font-size:19px; font-weight:500; line-height:1.25; }
  .sec-m { display:block; font-size:11.5px; color:var(--g2); margin-top:3px; }
  .sec-fig { flex:0 0 auto; text-align:right; white-space:nowrap; }
  .sec-fl { display:block; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--g2); }
  .sec-fv { display:block; font-family:Newsreader,serif; font-size:21px; font-weight:500; color:var(--gold-t); margin-top:3px; }
  .sec-corpo { padding:4px 0 30px 76px; }

  details.sub { margin-bottom:26px; }
  details.sub > summary { display:flex; align-items:baseline; gap:10px; padding-bottom:8px; border-bottom:1px solid var(--ink); }
  .mk2 { font-size:12px; line-height:1; color:var(--gold); width:12px; flex:0 0 auto; }
  .mk2::before { content:'+'; }
  details[open] > summary > .mk2::before { content:'−'; }
  .sub-t { font-size:13.5px; font-weight:600; flex:1 1 0; }
  .sub-c { font-size:11px; color:var(--g3); text-align:right; max-width:55%; }
  .sub-corpo { padding-top:14px; }

  .nota { font-size:13.5px; line-height:1.75; color:var(--g1); max-width:780px; margin:0 0 18px; }
  .nota-peq { font-size:12px; line-height:1.6; color:var(--g2); margin:10px 0; max-width:820px; }
  .nota-peq b { color:var(--ink); font-weight:600; }
  .tw { overflow-x:auto; }
  table.t { width:100%; border-collapse:collapse; font-size:12.5px; font-variant-numeric:tabular-nums; }
  .t th { padding:0 16px 8px 0; font-weight:500; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--g2); white-space:nowrap; border-bottom:1px solid var(--ink); text-align:left; vertical-align:bottom; }
  .t td { padding:9px 14px 9px 0; border-bottom:1px solid var(--l2); vertical-align:top; }
  .t td:first-child { min-width:150px; }
  .t select { width:100%; }
  .t th:last-child, .t td:last-child { padding-right:0; }
  .t th.r, .t td.num { text-align:right; white-space:nowrap; }
  .t td.t-txt, .t td.cam-cell, .t td.imp-cell { white-space:normal; }
  .t td.t-txt { font-size:12px; line-height:1.55; color:var(--g1); min-width:200px; }
  .ent-n { font-family:Newsreader,serif; font-size:14.5px; font-weight:500; line-height:1.3; }
  .ent-s { font-size:11px; color:var(--g2); margin-top:2px; }
  .cam-cell { min-width:185px; max-width:230px; font-size:11.5px; color:var(--g2); }
  .cam-l { margin-top:6px; }
  .cam-div { color:var(--gold-t); font-weight:600; margin-top:4px; }
  .imp-cell { min-width:230px; font-size:12px; line-height:1.55; color:var(--g1); }
  .imp-t { display:block; margin-top:5px; }
  tr.rf-cons td { background:transparent; }
  .sec-corpo:not(.mostra-tudo) tr.extra { display:none; }
  .acoes { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:16px 0 4px; }
  .tag { display:inline-block; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; padding:3px 8px; border:1px solid; white-space:nowrap; line-height:1.3; }
  .tag-alta { background:var(--ink); color:var(--bg); border-color:var(--ink); }
  .tag-media { color:var(--gold-t); border-color:var(--gold); }
  .tag-info { color:var(--g2); border-color:var(--l1); }
  .tag-ok { color:var(--ink); border-color:var(--ink); }

  .campos { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:22px 28px; margin:0 0 18px; }
  .campos label { display:flex; flex-direction:column; gap:7px; }
  .rot { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--g2); }
  .aj { font-size:11.5px; line-height:1.5; color:var(--g2); }
  .campos input, .campos select { width:100%; padding:11px 14px; font-family:inherit; font-size:14px; color:var(--ink); background:#fff; border:1px solid var(--l1); border-radius:0; outline:none; }
  .campos input:focus, .campos select:focus, .t select:focus { border-color:var(--gold-t); }
  .t select { font-family:inherit; font-size:12.5px; color:var(--ink); background:#fff; border:1px solid var(--l1); border-radius:0; padding:6px 8px; max-width:100%; outline:none; }
  .bl-t { font-size:13.5px; font-weight:600; color:var(--ink); padding:0 0 8px; border-bottom:1px solid var(--ink); margin:26px 0 12px; }
  .narr { border-left:3px solid var(--gold); padding:4px 0 4px 16px; font-size:13.5px; line-height:1.7; color:var(--g1); margin:6px 0 18px; max-width:780px; }
  .como summary { font-size:12px; letter-spacing:.04em; color:var(--gold-t); cursor:pointer; margin-bottom:10px; }
  .aviso { display:none; font-size:12.5px; line-height:1.6; color:var(--g1); border:1px solid var(--gold); padding:10px 14px; margin:0 0 18px; max-width:780px; }
  .destaque { font-family:Newsreader,serif; font-size:21px; line-height:1.4; margin:4px 0 22px; max-width:780px; }
  .destaque b { color:var(--gold-t); font-weight:500; }
  .destaque small { display:block; font-family:'IBM Plex Sans',sans-serif; font-size:12px; color:var(--g2); margin-top:4px; }
  .neg { color:#8C2F25; }
  .insights { max-width:900px; }
  .ins { display:flex; gap:18px; padding:14px 0; border-top:1px solid var(--l2); }
  .ins:first-child { border-top:0; padding-top:4px; }
  .ins .tg { width:120px; flex:0 0 auto; padding-top:2px; }
  .ins .tx { font-size:14px; line-height:1.65; color:var(--g1); }
  .ins .tx b { color:var(--ink); font-weight:600; }

  .natureza { background:var(--ink); color:var(--bg); padding:24px 30px; margin-top:48px; }
  .natureza .n-r { font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#A8A29A; }
  .natureza .n-t { font-size:13.5px; line-height:1.7; color:#CFC9BE; margin-top:8px; }
  .rodape { font-size:11px; letter-spacing:.06em; color:var(--g3); margin-top:40px; }

  @media (max-width:860px) {
    .top { padding:16px 20px; } .top nav { display:none; }
    .wrap { padding:32px 20px 60px; }
    .h1a, .h1b { font-size:32px; } .h1b.menor { font-size:26px; }
    .kpis { grid-template-columns:1fr 1fr; } .kpi, .kpi:first-child, .kpi:last-child { padding:18px 16px; border-left:0; border-bottom:1px solid var(--l1); }
    .sec-corpo { padding-left:0; } .sec-fig { display:none; } .idx { width:20px; }
    .ins { flex-direction:column; gap:6px; } .ins .tg { width:auto; }
  }
  @media print {
    .top { position:static; } .top nav, .btn, .acoes, .barra .btn { display:none !important; }
    details.sec, details.sub { display:block; } details > .sec-corpo, details > .sub-corpo { display:block !important; }
    .sec-corpo:not(.mostra-tudo) tr.extra { display:table-row; }
  }
</style>
</head><body>
  <div class="top">
    <img src="${LOGO_CONTADOR_PADARIAS_B64}" alt="Contador de Padarias">
    <nav>${secoes.map(s => `<a href="#${s.id}" data-sec="${s.id}">${esc(rotuloNav[s.id] || s.titulo)}</a>`).join('')}</nav>
  </div>
  <div class="wrap">
    <div class="h1a">Perfil e Reforma Tributária</div>
    <div class="h1b${nomeEmpresaGrande ? ' menor' : ''}">${esc(empresa)}</div>
    <div class="regua"></div>
    <div class="lede">Retrato da empresa a partir das notas fiscais de ${esc(periodoLegivel)}: quem compra dela, de quem ela compra e quanto crédito de IBS/CBS circula nessa cadeia — e o que isso muda em margem e caixa com a Reforma Tributária. A Reforma não é sobre pagamento de tributos — é sobre margem e caixa.</div>
    ${temReforma ? `<div class="kpis">
      <div class="kpi"><div class="k-r">Faturamento do período</div><div class="k-v">${esc(formatarMoeda(faturamentoTotal))}</div><div class="k-s">${esc(formatarMoeda(receitaMensal))} por mês</div></div>
      <div class="kpi"><div class="k-r">Venda a consumidor final</div><div class="k-v">${esc(formatarPct(consumidorPct))}%</div><div class="k-s">${esc(formatarMoeda(consumidorValor))} sem CNPJ de comprador</div></div>
      <div class="kpi"><div class="k-r">Compras identificadas</div><div class="k-v">${esc(formatarMoeda(perfilFornecedores.totalConsiderado))}</div><div class="k-s">${perfilFornecedores.fornecedores.length} fornecedor(es) nas NF-e de entrada</div></div>
      <div class="kpi dest"><div class="k-r">Crédito de IBS/CBS estimado</div><div class="k-v" id="kpiCredito">—</div><div class="k-s" id="kpiCreditoSub">sobre as compras listadas, no período</div></div>
    </div>` : ''}
    <div class="barra">
      <span class="info">${secoes.length} seção(ões) · ${perfilFornecedores.fornecedores.length} fornecedor(es) · ${perfilClientes.clientes.length} cliente(s) com CNPJ · ${esc(periodoLegivel)}${totalAtencao > 0 ? ` · ${totalAtencao} pra olhar com atenção` : ''}</span>
      <button type="button" class="btn" id="btnExpandir">Expandir todas</button>
      <button type="button" class="btn suave" id="btnRecolher">Recolher todas</button>
    </div>
    ${secoes.map(s => s.html).join('')}
    <div class="natureza">
      <div class="n-r">Natureza do documento</div>
      <div class="n-t">Este perfil é um retrato calculado a partir dos XMLs carregados e serve de apoio à conversa consultiva — não é apuração fiscal nem auditoria oficial. O regime de cada empresa vem em duas camadas (CRT da nota e consulta à Receita Federal) e é sempre um palpite editável: nenhuma das duas enxerga o regime híbrido do Simples nem Presumido × Real, e o regime de quem compra da empresa não vem na nota. O mix de alíquotas é lido do código cClassTrib de cada item, sem interpretar nome de produto ou NCM; item sem o grupo IBS/CBS é assumido em alíquota cheia. As alíquotas, o crédito parcial do Simples puro (LC 214/2025, art. 47, §9º, II) e a carga atual são premissas ajustáveis. Custo e despesa geral não vêm do XML fiscal, por isso o simulador para na margem disponível.</div>
    </div>
    <div class="rodape">Gerado em ${hoje} · Sequência Fiscal — Contador de Padarias</div>
  </div>
  <script>
    var DADOS = ${JSON.stringify(dadosParaExcel, (_k, v) => typeof v === 'string' ? decodeEnt(v) : v)};
    var REGIME_INFO = ${JSON.stringify(Object.fromEntries(REGIME_OPCOES.map(o => [o.key, { label: o.label, gera: o.gera, usa: o.usa, parcial: o.parcial, duvida: !!o.duvida }])))};
    var RF_DATA = ${JSON.stringify({ numMeses: numMesesRef, faturamento: faturamentoTotal, consumidorValor, consumidorPct, fatorReceitaMix: mixAliquotas.saidas.total > 0 ? mixAliquotas.saidas.fator : 1, coberturaSaidas: mixAliquotas.saidas.coberturaPct, coberturaMeses: mixAliquotas.saidas.porMes, temSaidas: mixAliquotas.saidas.total > 0, empresaDiverge: sugEmpresa.divergencia ? { crt: sugEmpresa.crtTxt, receita: sugEmpresa.receitaTxt } : null, pesoIbs: 17.7 / 26.5, comprasTotal: perfilFornecedores.totalConsiderado, nFornecedoresTotal: perfilFornecedores.fornecedores.length, temEntradas: mixAliquotas.entradas.total > 0, fatorCompras: mixAliquotas.entradas.total > 0 ? mixAliquotas.entradas.fator : 1, produtosMultiCodigo: mixAliquotas.saidas.topProdutos.filter(p => p.nCodigos > 1).length })};
    function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    function fmtMoedaBr(v) { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    function fmtNumBr(v) { return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function fmtPctBr(v) { return v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
    function numDe(id, padrao) {
      var el = document.getElementById(id);
      if (!el) return padrao;
      var v = parseFloat(String(el.value).trim().replace(/\\./g, '').replace(',', '.'));
      return isNaN(v) ? padrao : v;
    }
    function infoDe(key) { return REGIME_INFO[key] || REGIME_INFO.desconhecido; }
    // os dois controles visíveis (regime + como recolhe IBS/CBS) alimentam o select oculto que o recálculo lê
    function sincronizaRegime() {
      var base = document.getElementById('selRegimeBase'), modo = document.getElementById('selModoSimples'), alvo = document.getElementById('selRegimeEmpresa');
      if (!base || !alvo) return;
      var ehSimples = base.value === 'simples';
      var box = document.getElementById('boxModoSimples');
      if (box) box.style.display = ehSimples ? '' : 'none';
      var mapa = { duvida: 'simples_duvida', puro: 'simples_puro', hibrido: 'simples_hibrido' };
      alvo.value = ehSimples ? (mapa[modo ? modo.value : 'duvida'] || 'simples_duvida') : base.value;
    }
    function setTxt(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
    function setHtml(id, h) { var el = document.getElementById(id); if (el) el.innerHTML = h; }
    function esc2(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function tag(cls, txt) { return '<span class="tag tag-' + cls + '">' + txt + '</span>'; }
    function prioDe(share) { return share >= 0.2 ? ['alta', 'Prioridade alta'] : share >= 0.05 ? ['media', 'Prioridade média'] : ['info', 'Prioridade baixa']; }

    function impForn(r, empresa, share) {
      if (!empresa.usa) return tag('info', 'Sem efeito') + '<span class="imp-t">A empresa não aproveita crédito: o regime dele não muda o custo.</span>';
      if (r.key === 'desconhecido') return tag('media', 'Confirmar') + '<span class="imp-t">Regime não identificado — confirme antes de contar com o crédito.</span>';
      if (r.info.gera) return tag('ok', 'Manter') + '<span class="imp-t">Crédito cheio: volta cerca de ' + fmtMoedaBr(r.cred) + '.</span>';
      if (r.info.duvida) {
        var extraSinal = r.sinal === 'crt2' ? ' Sinal na nota: CRT 2 (excesso de sublimite) — se o IBS sair do DAS, o crédito de IBS seria cheio (cerca de ' + fmtMoedaBr((r.cred + r.perdido) * RF_DATA.pesoIbs) + ') e o de CBS, parcial.' : (r.sinal === 'cst' ? ' Sinal na nota: destaca ICMS por CST apesar de ser do Simples — confira o cadastro.' : '');
        return tag('media', 'Confirmar') + '<span class="imp-t">Optante do Simples: se não aderiu ao regime regular, o crédito é parcial (cerca de ' + fmtMoedaBr(r.cred) + '); se aderiu, seria cheio (cerca de ' + fmtMoedaBr(r.cred + r.perdido) + '). Pergunte: "Você optou pelo regime regular de IBS/CBS?"' + extraSinal + '</span>';
      }
      var p = prioDe(share);
      if (r.info.parcial) return tag(p[0], p[1]) + '<span class="imp-t">Crédito só parcial: deixa de creditar cerca de ' + fmtMoedaBr(r.perdido) + '. Renegociar preço ou pedir adesão ao regime regular.</span>';
      return tag(p[0], p[1]) + '<span class="imp-t">Sem crédito (regra do MEI a confirmar): cerca de ' + fmtMoedaBr(r.perdido) + ' de IBS/CBS vira custo. Avaliar preço ou fornecedor em Regime Normal.</span>';
    }
    function impCli(r, empresa, share) {
      if (r.key === 'desconhecido') return tag('media', 'Confirmar') + '<span class="imp-t">Regime não identificado — consulte a Receita pra saber se ele aproveita crédito.</span>';
      if (r.info.duvida) return tag('media', 'Confirmar') + '<span class="imp-t">Cliente do Simples: se não optou pelo regime regular, não usa crédito e vender com ou sem crédito dá no mesmo; se optou, passaria a aproveitar cerca de ' + fmtMoedaBr(r.potencial) + ' de crédito entregue pela empresa.</span>';
      if (!r.info.usa) return tag('info', 'Sem efeito') + '<span class="imp-t">Não usa crédito de IBS/CBS (' + esc2(r.info.label) + '): vender com ou sem crédito dá no mesmo.</span>';
      if (empresa.gera) return tag('ok', 'Manter') + '<span class="imp-t">Aproveita e recebe crédito cheio (cerca de ' + fmtMoedaBr(r.cred) + '): no mesmo pé de um concorrente em Regime Normal.</span>';
      var p = prioDe(share);
      return tag(p[0], p[1]) + '<span class="imp-t">Aproveita crédito e recebe só ' + fmtMoedaBr(r.cred) + ': paga cerca de ' + fmtMoedaBr(r.gap) + ' a mais, líquido, que num concorrente em Regime Normal — risco de pedir desconto ou trocar de fornecedor.</span>';
    }
    function linhaCadeia(rel, vol, pct, cred, muda, fazer) {
      return '<tr><td><b>' + rel + '</b></td><td class="num">' + fmtMoedaBr(vol) + '</td><td class="num">' + fmtPctBr(pct) + '%</td><td class="num">' + cred + '</td><td class="t-txt">' + muda + '</td><td class="t-txt">' + fazer + '</td></tr>';
    }
    var CENARIOS = [
      { label: '100% — repassa o necessário por completo', assertividade: 1 },
      { label: '80% — repassa parte do necessário', assertividade: 0.8 },
      { label: '50% — repassa só metade do necessário', assertividade: 0.5 },
      { label: '0% — mantém o preço atual (não repassa nada)', assertividade: 0 },
    ];

    // Recalcula tudo a partir do estado atual da tela: regime da empresa →
    // crédito de fornecedores → crédito entregue a clientes → cadeia, leituras e simulador.
    function recalcReforma() {
      sincronizaRegime();
      var selEmp = document.getElementById('selRegimeEmpresa');
      var empresa = infoDe(selEmp ? selEmp.value : 'desconhecido');
      var aliqRef = numDe('simAliqReforma', 26.5) / 100;
      var parcial = numDe('inpParcial', 0) / 100;
      var aCompra = aliqRef * numDe('inpFatorCompras', 100) / 100;
      var aVenda = aliqRef * numDe('simFatorReceita', 100) / 100;

      if (selEmp) {
        var comoComprador = empresa.usa ? 'aproveita crédito de IBS/CBS das compras (quando o fornecedor gera)' : 'NÃO aproveita crédito de fornecedor (fora do regime regular de IBS/CBS)';
        var comoVendedor = empresa.gera ? 'passa crédito cheio aos clientes que conseguem usar' : (empresa.parcial ? 'passa só crédito parcial (a parcela de IBS/CBS contida no DAS — LC 214, art. 47, §9º, II)' : 'não passa crédito aos clientes');
        var preambulo = empresa.duvida ? 'Sem saber se a empresa optou pelo regime regular de IBS/CBS, as tabelas abaixo partem da hipótese conservadora (Simples puro) e o quadro "Se for puro × se for híbrido" mostra o que muda. ' : '';
        var rotuloReg = empresa.duvida ? 'Simples Nacional, hipótese: IBS/CBS dentro do DAS' : empresa.label;
        setTxt('empresaNarrativa', preambulo + 'Nesse regime (' + rotuloReg + '), como compradora a empresa ' + comoComprador + '; como vendedora, ' + comoVendedor + '.');
        setTxt('figPremissas', empresa.label);
      }

      // alíquotas efetivas lidas das notas (somente leitura; os campos de ajuste ficam em "ajustes avançados")
      var fvPct = numDe('simFatorReceita', 100), fcPct = numDe('inpFatorCompras', 100);
      setTxt('aliqVendaEf', fmtNumBr(aliqRef * fvPct) + '%');
      setTxt('aliqVendaFat', fmtNumBr(fvPct) + '%');
      setTxt('aliqCompraEf', fmtNumBr(aliqRef * fcPct) + '%');
      setTxt('aliqCompraFat', fmtNumBr(fcPct) + '%');
      function marcaAjuste(id, spanId, valor) {
        var inp = document.getElementById(id);
        var calc = inp ? parseFloat(inp.getAttribute('data-calc')) : NaN;
        setHtml(spanId, (!isNaN(calc) && Math.abs(valor - calc) > 0.005) ? ' <b>Ajustado manualmente</b> (calculado: ' + fmtNumBr(calc) + '%).' : '');
      }
      marcaAjuste('simFatorReceita', 'aliqVendaAj', fvPct);
      marcaAjuste('inpFatorCompras', 'aliqCompraAj', fcPct);

      // fornecedores
      var rowsF = qsa('.sel-regime-fornecedor').map(function (sel) {
        var tr = sel.closest('tr');
        var total = parseFloat(sel.getAttribute('data-total')) || 0;
        var info = infoDe(sel.value);
        var cred = empresa.usa ? total * (info.gera ? aCompra : (info.parcial ? parcial : 0)) : 0;
        var pleno = empresa.usa ? total * aCompra : 0;
        return { tr: tr, nome: tr.querySelector('.ent-n').textContent, total: total, key: sel.value, info: info, cred: cred, perdido: pleno - cred, sinal: sel.getAttribute('data-sinal') || '' };
      });
      var totCompras = 0, credF = 0, perdF = 0;
      rowsF.forEach(function (r) { totCompras += r.total; credF += r.cred; perdF += r.perdido; });
      var bF = { pleno: { n: 0, v: 0, c: 0, p: 0 }, parcial: { n: 0, v: 0, c: 0, p: 0 }, sem: { n: 0, v: 0, c: 0, p: 0 }, desc: { n: 0, v: 0, c: 0, p: 0 } };
      rowsF.forEach(function (r) {
        r.tr.querySelector('.cred-cell').textContent = fmtMoedaBr(r.cred);
        r.tr.querySelector('.imp-cell').innerHTML = impForn(r, empresa, perdF > 0 ? r.perdido / perdF : 0);
        var b = r.key === 'desconhecido' ? bF.desc : (r.info.gera ? bF.pleno : (r.info.parcial ? bF.parcial : bF.sem));
        b.n++; b.v += r.total; b.c += r.cred; b.p += r.perdido;
      });
      setTxt('fornTotalCompras', fmtMoedaBr(totCompras));
      setTxt('fornCredito', fmtMoedaBr(credF));
      setTxt('fornCreditoPerdido', fmtMoedaBr(perdF));
      setTxt('fornPctPerdido', fmtPctBr((credF + perdF) > 0 ? (perdF / (credF + perdF)) * 100 : 0));
      setTxt('kpiCredito', fmtMoedaBr(credF));
      setTxt('figForn', fmtMoedaBr(perdF));

      // clientes
      var rowsC = qsa('.sel-regime-cliente').map(function (sel) {
        var tr = sel.closest('tr');
        var total = parseFloat(sel.getAttribute('data-total')) || 0;
        var info = infoDe(sel.value);
        var usa = sel.value !== 'desconhecido' && info.usa;
        var cred = usa ? total * (empresa.gera ? aVenda : (empresa.parcial ? parcial : 0)) : 0;
        var pleno = usa ? total * aVenda : 0;
        var potencial = info.duvida ? total * (empresa.gera ? aVenda : (empresa.parcial ? parcial : 0)) : 0;
        return { tr: tr, nome: tr.querySelector('.ent-n').textContent, total: total, key: sel.value, info: info, usa: usa, cred: cred, gap: pleno - cred, potencial: potencial };
      });
      var gapTotal = 0, credCli = 0, credCliPleno = 0;
      var bC = { aprov: { n: 0, v: 0, c: 0, g: 0 }, nao: { n: 0, v: 0, c: 0, g: 0 }, desc: { n: 0, v: 0, c: 0, g: 0 } };
      rowsC.forEach(function (r) { gapTotal += r.gap; credCli += r.cred; credCliPleno += r.cred + r.gap; });
      rowsC.forEach(function (r) {
        r.tr.querySelector('.cli-cred').textContent = fmtMoedaBr(r.cred);
        r.tr.querySelector('.imp-cell').innerHTML = impCli(r, empresa, gapTotal > 0 ? r.gap / gapTotal : 0);
        var b = r.key === 'desconhecido' ? bC.desc : (r.usa ? bC.aprov : bC.nao);
        b.n++; b.v += r.total; b.c += r.cred; b.g += r.gap;
      });
      setTxt('cliVendasAprov', fmtMoedaBr(bC.aprov.v));
      setTxt('cliVendasNao', fmtMoedaBr(bC.nao.v));
      setTxt('cliVendasDesc', fmtMoedaBr(bC.desc.v));
      setTxt('cliCredito', fmtMoedaBr(credCli));
      setTxt('cliCreditoPleno', fmtMoedaBr(credCliPleno));
      setTxt('cliCreditoDif', fmtMoedaBr(gapTotal));
      setTxt('figCli', rowsC.length ? fmtMoedaBr(gapTotal) : '—');
      setTxt('figCadeia', fmtMoedaBr(perdF + gapTotal));

      // sensibilidade da hipótese de crédito parcial do fornecedor do Simples
      var baseParcial = 0;
      rowsF.forEach(function (r) { if (r.info.parcial) baseParcial += r.total; });
      setTxt('sensParcial', baseParcial > 0 ? 'Cada ponto percentual aqui muda o crédito de compras em ' + fmtMoedaBr(baseParcial / 100) + ' (compras listadas de fornecedor do Simples, se a empresa aproveita crédito).' : '');

      // comparação puro × híbrido: só aparece quando a opção do Simples está em aberto
      function credComprasSe(emp) { var s = 0; rowsF.forEach(function (r) { if (emp.usa) s += r.total * (r.info.gera ? aCompra : (r.info.parcial ? parcial : 0)); }); return s; }
      function credClientesSe(emp) { var s = 0; rowsC.forEach(function (r) { if (r.usa) s += r.total * (emp.gera ? aVenda : (emp.parcial ? parcial : 0)); }); return s; }
      var empP = infoDe('simples_puro'), empH = infoDe('simples_hibrido');
      var credH = credComprasSe(empH);
      var debH = (RF_DATA.faturamento || 0) * aVenda;
      var boxCmp = document.getElementById('boxComparacao');
      if (boxCmp) {
        boxCmp.style.display = empresa.duvida ? '' : 'none';
        if (!empresa.duvida) setTxt('kpiCreditoSub', 'sobre as compras listadas, no período');
        setTxt('cmpCredP', fmtMoedaBr(credComprasSe(empP)));
        setTxt('cmpCredH', fmtMoedaBr(credH));
        setTxt('cmpCliP', fmtMoedaBr(credClientesSe(empP)));
        setTxt('cmpCliH', fmtMoedaBr(credClientesSe(empH)));
        setTxt('cmpDebH', fmtMoedaBr(debH));
        setTxt('cmpLiqH', fmtMoedaBr(debH - credH));
        if (empresa.duvida) {
          setTxt('kpiCredito', 'a confirmar');
          setTxt('kpiCreditoSub', fmtMoedaBr(credComprasSe(empP)) + ' se Simples puro · ' + fmtMoedaBr(credH) + ' se regime regular');
        }
        setHtml('cmpFecho', 'No regime regular, o IBS/CBS líquido das vendas deste período seria de cerca de <b>' + fmtMoedaBr(debH - credH) + '</b> (' + fmtMoedaBr(debH) + ' de débito menos ' + fmtMoedaBr(credH) + ' de crédito de compras)' + (credH > debH ? ' — crédito maior que o débito vira saldo credor; confira se vendas e compras cobrem o mesmo período' : '') + '. Dentro do DAS o valor depende da apuração do cliente. <b>Para fechar:</b> confirme com o cliente se ele optou pelo regime regular e marque a resposta no passo 2 — as demais tabelas passam a seguir essa resposta.');
      }

      // cadeia (tabela-resumo por tipo de relação)
      var fat = RF_DATA.faturamento || 0;
      var linhas = [];
      if (RF_DATA.consumidorValor > 0) linhas.push(linhaCadeia('Venda a consumidor final', RF_DATA.consumidorValor, RF_DATA.consumidorPct, '—', 'Sem crédito: o consumidor não aproveita IBS/CBS. Com o imposto por fora o preço final sobe, e o repasse depende de quanto ele aceita.', 'Definir o repasse de preço — veja o simulador.'));
      if (bC.aprov.n > 0) linhas.push(linhaCadeia('Clientes que aproveitam crédito (' + bC.aprov.n + ')', bC.aprov.v, fat > 0 ? bC.aprov.v / fat * 100 : 0, fmtMoedaBr(bC.aprov.c),
        empresa.gera ? 'Recebem crédito cheio: sem desvantagem frente a concorrente em Regime Normal.' : 'Recebem só crédito parcial: pagam cerca de ' + fmtMoedaBr(bC.aprov.g) + ' a mais, líquido, que comprando de concorrente em Regime Normal.',
        empresa.gera ? 'Manter o regime e usar o crédito como argumento comercial.' : 'Avaliar adesão ao regime regular (híbrido) ou migração; preparar resposta caso peçam desconto.'));
      if (bC.nao.n > 0) linhas.push(linhaCadeia('Clientes que não aproveitam crédito (' + bC.nao.n + ')', bC.nao.v, fat > 0 ? bC.nao.v / fat * 100 : 0, '—', 'Não usam crédito de IBS/CBS: vender com ou sem crédito dá no mesmo.', 'Nada a fazer pelo crédito; o preço final sobe pelo imposto por fora.'));
      if (bC.desc.n > 0) linhas.push(linhaCadeia('Clientes sem regime identificado (' + bC.desc.n + ')', bC.desc.v, fat > 0 ? bC.desc.v / fat * 100 : 0, '—', 'Não dá pra saber se aproveitam crédito.', 'Consultar a Receita e confirmar o regime.'));
      if (bF.pleno.n > 0) linhas.push(linhaCadeia('Fornecedores com crédito cheio (' + bF.pleno.n + ')', bF.pleno.v, totCompras > 0 ? bF.pleno.v / totCompras * 100 : 0, fmtMoedaBr(bF.pleno.c),
        empresa.usa ? 'O IBS/CBS da compra volta integralmente como crédito.' : 'Geram crédito, mas a empresa não aproveita (' + esc2(empresa.label) + ').', empresa.usa ? 'Manter e priorizar nas compras.' : 'Avaliar migrar pro regime regular — o crédito já está disponível nesses fornecedores.'));
      if (bF.parcial.n > 0) linhas.push(linhaCadeia('Fornecedores do Simples (' + bF.parcial.n + ')', bF.parcial.v, totCompras > 0 ? bF.parcial.v / totCompras * 100 : 0, fmtMoedaBr(bF.parcial.c),
        empresa.usa ? 'Crédito só da parcela do DAS (estimado em ' + fmtPctBr(parcial * 100) + '% da compra): deixa de creditar cerca de ' + fmtMoedaBr(bF.parcial.p) + '.' : 'Sem efeito: a empresa não aproveita crédito.',
        empresa.usa ? 'Confirmar quem aderiu ao regime regular; para os demais, renegociar preço ou migrar compras para fornecedor em Regime Normal.' : '—'));
      if (bF.sem.n > 0) linhas.push(linhaCadeia('Fornecedores MEI (' + bF.sem.n + ')', bF.sem.v, totCompras > 0 ? bF.sem.v / totCompras * 100 : 0, fmtMoedaBr(bF.sem.c),
        empresa.usa ? 'Sem crédito (regra do MEI a confirmar): todo o IBS/CBS embutido vira custo, cerca de ' + fmtMoedaBr(bF.sem.p) + '.' : 'Sem efeito: a empresa não aproveita crédito.',
        empresa.usa ? 'Avaliar preço ou fornecedor alternativo em Regime Normal.' : '—'));
      if (bF.desc.n > 0) linhas.push(linhaCadeia('Fornecedores sem regime identificado (' + bF.desc.n + ')', bF.desc.v, totCompras > 0 ? bF.desc.v / totCompras * 100 : 0, '—', 'Não dá pra contar com o crédito sem saber o regime.', 'Consultar a Receita e confirmar com o fornecedor.'));
      setHtml('cadeiaCorpo', linhas.length ? linhas.join('') : '<tr><td colspan="6" class="t-txt">Sem relações identificadas nas notas carregadas.</td></tr>');

      // simulador
      var corpo = document.getElementById('simCorpo');
      var receita = 0, aliqAtual = 0, preco100 = 0, cred = 0;
      if (corpo) {
        receita = numDe('simReceita', 0);
        aliqAtual = numDe('simAliqAtual', 0) / 100;
        var campoCred = document.getElementById('simCredito');
        var credMensal = RF_DATA.numMeses > 0 ? credF / RF_DATA.numMeses : 0;
        if (campoCred && !campoCred.getAttribute('data-manual')) campoCred.value = fmtNumBr(credMensal);
        cred = campoCred ? numDe('simCredito', 0) : 0;
        var aviso = document.getElementById('simAviso');
        if (!empresa.usa) {
          cred = 0;
          if (aviso) { aviso.style.display = 'block'; aviso.textContent = 'Regime sem apuração regular de IBS/CBS (' + empresa.label + '): o tributo continua no DAS e não há crédito de compras — o crédito fica zerado aqui.' + (empresa.duvida ? ' Enquanto a opção pelo regime regular não for confirmada, vale a hipótese do Simples puro.' : '') + ' Para simular o Simples puro, informe em "Alíquota-padrão do IVA" a alíquota efetiva de IBS/CBS no DAS, não a do IVA cheio.'; }
        } else if (aviso) { aviso.style.display = 'none'; aviso.textContent = ''; }
        var aEff = aVenda < 1 ? aVenda : 0;
        var margemAtual = receita * (1 - aliqAtual);
        preco100 = (margemAtual - cred) / (1 - aEff);
        var saldoCredor = empresa.usa && aEff > 0 && cred > receita * aEff + 0.005;
        if (saldoCredor && aviso) {
          aviso.style.display = 'block';
          aviso.textContent = 'O crédito de compras (' + fmtMoedaBr(cred) + ' por mês) supera o débito de IBS/CBS sobre a receita (' + fmtMoedaBr(receita * aEff) + '): confira se receita e compras cobrem o mesmo período e a mesma empresa — notas de compra de um período maior que as de venda causam isso. Se for real, há saldo credor e nenhum aumento de preço a repassar.';
        }
        corpo.innerHTML = !(preco100 > 0) ? '<tr><td colspan="6" class="t-txt">Sem cenário calculável: o crédito de compras anula o débito (saldo credor).</td></tr>' : CENARIOS.map(function (c) {
          var preco = receita + c.assertividade * (preco100 - receita);
          var debito = preco * aEff;
          var margem = preco - debito + cred;
          var diff = margem - margemAtual;
          var sinal = diff >= 0 ? '+' : '';
          return '<tr><td>' + c.label + '</td>' +
            '<td class="num">' + fmtMoedaBr(preco) + '</td>' +
            '<td class="num">' + fmtMoedaBr(debito) + '</td>' +
            '<td class="num">' + fmtMoedaBr(cred) + '</td>' +
            '<td class="num">' + fmtMoedaBr(margem) + '</td>' +
            '<td class="num' + (diff < -0.005 ? ' neg' : '') + '">' + sinal + fmtMoedaBr(diff) + '</td></tr>';
        }).join('');
        var resumo = document.getElementById('simResumo');
        if (resumo && receita > 0 && !(preco100 > 0)) {
          resumo.innerHTML = 'Com esse crédito de compras não há aumento de preço a repassar.<small>Revise a receita, as compras ou o regime acima.</small>';
          setTxt('figSim', '—');
        } else if (resumo && receita > 0) {
          var subiu = preco100 - receita;
          var pctUp = (preco100 / receita - 1) * 100;
          // com a carga atual em 0% a conta compara contra "não pagar nada hoje" — número sem sentido,
          // então a manchete só aparece depois que a alíquota atual é informada
          resumo.innerHTML = aliqAtual === 0
            ? 'Informe a alíquota atual sobre a receita (DAS, Presumido ou Real) pra ver quanto o preço precisa subir.<small>Enquanto ela está em 0%, a tabela abaixo compara contra "não pagar imposto hoje" e não deve ser lida como resultado.</small>'
            : 'Para manter a margem de hoje, o preço médio precisa ' + (subiu >= 0 ? 'subir ' : 'cair ') + '<b>' + fmtPctBr(Math.abs(pctUp)) + '%</b> (' + fmtMoedaBr(Math.abs(subiu)) + ' por mês).';
          corpo.style.opacity = aliqAtual === 0 ? '0.4' : '1';
          setTxt('figSim', aliqAtual === 0 ? '—' : (subiu >= 0 ? '+' : '−') + fmtPctBr(Math.abs(pctUp)) + '%');
        }
      }

      // leituras-chave
      var it = [];
      function ins(cls, rotulo, texto) { it.push('<div class="ins"><div class="tg">' + tag(cls, rotulo) + '</div><div class="tx">' + texto + '</div></div>'); }
      if (RF_DATA.empresaDiverge) ins('alta', 'Regime da empresa', '<b>As notas e a Receita discordam sobre o regime da própria empresa.</b> As notas declaram "' + esc2(RF_DATA.empresaDiverge.crt) + '", mas a Receita Federal registra "' + esc2(RF_DATA.empresaDiverge.receita) + '". Antes de simular, confirme o regime real: ele muda alíquota, crédito e até a regularidade da emissão (o emissor pode estar com o CRT errado). Outras explicações possíveis: a empresa passou do sublimite do Simples (o correto seria CRT 2, com ICMS e IBS fora do DAS) ou foi excluída do Simples e o cadastro ainda não refletiu. Este relatório adotou a Receita como palpite — troque em "Regime e premissas" se for outro.');
      if (empresa.duvida) ins('alta', 'Confirmar', '<b>Falta confirmar como a empresa recolhe IBS e CBS.</b> Se estiver dentro do DAS (Simples puro), não aproveita crédito de compras. Se tiver optado pelo regime regular (híbrido), o crédito de compras seria de cerca de <b>' + fmtMoedaBr(credH) + '</b> no período e o IBS/CBS sobre as vendas, cerca de <b>' + fmtMoedaBr(debH) + '</b>. Pergunte ao cliente se fez a opção no Portal do Simples e marque a resposta em "Regime e premissas".');
      else if (!empresa.usa && empresa.label !== 'Não identificado') ins('alta', 'Prioridade', '<b>Regime da empresa.</b> Como ' + esc2(empresa.label) + ', a empresa não aproveita crédito de fornecedor. Vale simular a migração para o regime regular (Presumido, Real ou Simples híbrido): com crédito, o custo líquido das compras cai.');
      if (empresa.usa && rowsF.length) ins(perdF / Math.max(credF + perdF, 1) >= 0.2 ? 'media' : 'info', 'Crédito', '<b>Crédito de compras.</b> Cerca de <b>' + fmtMoedaBr(credF) + '</b> de IBS/CBS voltam como crédito sobre ' + fmtMoedaBr(totCompras) + ' em compras listadas. Deixa de aproveitar <b>' + fmtMoedaBr(perdF) + '</b> (' + fmtPctBr((credF + perdF) > 0 ? perdF / (credF + perdF) * 100 : 0) + '% do crédito cheio possível) por causa do regime de fornecedores.');
      if (empresa.usa && totCompras > 0 && RF_DATA.numMeses > 0) ins('media', 'Caixa', '<b>Capital de giro.</b> O IBS/CBS vem por fora no preço de compra (cerca de <b>' + fmtMoedaBr((totCompras / RF_DATA.numMeses) * aCompra) + ' por mês</b> nas compras listadas) e só volta como crédito na apuração. Com prazo de pagamento menor que o de recebimento, isso exige mais caixa — vale desenhar o ciclo recebimento × pagamento.');
      var topP = rowsF.filter(function (r) { return r.perdido > 0.005; }).sort(function (a, b) { return b.perdido - a.perdido; }).slice(0, 3);
      if (empresa.usa && topP.length) ins('alta', 'Renegociar', '<b>Fornecedores que mais custam crédito:</b> ' + topP.map(function (r) { return esc2(r.nome) + ' (' + fmtMoedaBr(r.perdido) + ')'; }).join(', ') + '. Candidatos a pedir adesão ao regime regular, desconto equivalente ao crédito perdido ou troca por fornecedor em Regime Normal.');
      var dvF = rowsF.filter(function (r) { return r.info.duvida && r.perdido > 0.005; }).sort(function (a, b) { return b.perdido - a.perdido; });
      if (empresa.usa && dvF.length) ins('media', 'Confirmar', '<b>' + dvF.length + ' fornecedor(es) do Simples sem confirmação do regime.</b> Se algum tiver optado pelo regime regular, o crédito sobe em até <b>' + fmtMoedaBr(dvF.reduce(function (s, r) { return s + r.perdido; }, 0)) + '</b>. Comece por: ' + dvF.slice(0, 3).map(function (r) { return esc2(r.nome) + ' (' + fmtMoedaBr(r.perdido) + ')'; }).join(', ') + '.');
      var sbF = rowsF.filter(function (r) { return r.sinal; });
      if (sbF.length && (empresa.usa || empresa.duvida)) ins('media', 'Alerta', '<b>' + sbF.length + ' fornecedor(es) com sinal de ICMS fora do DAS na nota</b> (CRT 2 ou ICMS destacado em emitente do Simples): ' + sbF.slice(0, 3).map(function (r) { return esc2(r.nome); }).join(', ') + '. No excesso do sublimite de R$ 3,6 milhões o IBS sai do DAS, mas a CBS tende a ficar — não é o regime híbrido, e o crédito poderia ser cheio só para o IBS. Confirme com o fornecedor antes de contar com isso.');
      if (gapTotal > 0.005 && !empresa.gera) ins('media', 'Risco comercial', '<b>Clientes que aproveitam crédito</b> recebem só ' + fmtMoedaBr(credCli) + ' dos ' + fmtMoedaBr(credCliPleno) + ' possíveis: pagam cerca de <b>' + fmtMoedaBr(gapTotal) + '</b> a mais, líquido, que comprando de concorrente em Regime Normal.');
      var nDesc = bF.desc.n + bC.desc.n;
      if (nDesc > 0) ins('media', 'Confirmar regime', '<b>' + nDesc + ' cadastro(s) sem regime identificado</b> (fornecedores e clientes). Use "Atualizar consulta à Receita Federal" nas tabelas ou confirme direto — enquanto isso, ficam fora do crédito.');
      var nDiv = qsa('.cam-div').length;
      if (nDiv > 0) ins('media', 'Divergência', '<b>' + nDiv + ' cadastro(s) em que o CRT da nota e a Receita divergem</b> (vale a Receita). Vale conferir se o fornecedor ou cliente mudou de regime.');
      if (RF_DATA.consumidorValor > 0) ins('info', 'Consumidor final', '<b>' + fmtPctBr(RF_DATA.consumidorPct) + '% das vendas</b> (' + fmtMoedaBr(RF_DATA.consumidorValor) + ') são a consumidor final: crédito não entra nessa venda — o que decide é quanto do imposto por fora o cliente aceita no preço (veja o simulador).');
      if (RF_DATA.temSaidas && RF_DATA.fatorReceitaMix < 0.995) ins('info', 'Alíquota reduzida', 'Em média a receita paga <b>' + fmtPctBr(RF_DATA.fatorReceitaMix * 100) + '% da alíquota cheia</b>: há itens com alíquota zero ou reduzida no cClassTrib das vendas.');
      if (RF_DATA.comprasTotal > 0 && rowsF.length >= 5) {
        var top5 = rowsF.slice().sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
        var somaTop5 = top5.reduce(function (s, r) { return s + r.total; }, 0);
        var pctTop5 = somaTop5 / RF_DATA.comprasTotal * 100;
        if (pctTop5 >= 40) ins(pctTop5 >= 60 ? 'media' : 'info', 'Concentração', '<b>Os 5 maiores fornecedores concentram ' + fmtPctBr(pctTop5) + '% das compras</b> (' + fmtMoedaBr(somaTop5) + ' de ' + fmtMoedaBr(RF_DATA.comprasTotal) + ', entre ' + RF_DATA.nFornecedoresTotal + ' fornecedores). Negociar regime, preço e prazo com eles move o crédito e o caixa mais do que qualquer outra frente: ' + top5.map(function (r) { return esc2(r.nome); }).join(', ') + '.');
      }
      if (RF_DATA.temEntradas && RF_DATA.fatorCompras < 0.99) ins('info', 'Compras', 'Em média as compras pagam <b>' + fmtPctBr(RF_DATA.fatorCompras * 100) + '% da alíquota cheia</b>: parte dos itens comprados já vem com alíquota zero ou reduzida. O crédito sobre esses itens é menor — e o cálculo acima já considera isso (campo de fator das compras em "Regime e premissas").');
      if (RF_DATA.produtosMultiCodigo > 0) ins('media', 'Classificação', '<b>' + RF_DATA.produtosMultiCodigo + ' dos maiores produtos vendidos saem com mais de um código cClassTrib</b> nas notas do período. O mesmo produto deveria ter um enquadramento único — veja a lista em "Mix de alíquotas".');
      if (RF_DATA.temSaidas && RF_DATA.coberturaSaidas < 90) {
        var mesesCob = RF_DATA.coberturaMeses || [];
        var ultimoCob = mesesCob.length ? mesesCob[mesesCob.length - 1] : null;
        ins('media', 'Cobertura', 'Só <b>' + fmtPctBr(RF_DATA.coberturaSaidas) + '%</b> do valor das vendas tem o grupo IBS/CBS preenchido' + (mesesCob.length > 1 ? ' (' + mesesCob.map(function (m) { return m.mes + ': ' + fmtPctBr(m.pct) + '%'; }).join(' · ') + ')' : '') + '; o resto foi assumido em alíquota cheia, então o mix é em parte suposição.' + (ultimoCob && ultimoCob.pct >= 99 ? ' O mês mais recente já está completo — a falta é de antes da obrigatoriedade (03/08/2026).' : ''));
      }
      setHtml('insights', it.length ? it.join('') : '<div class="nota">Sem pontos de atenção com as premissas atuais.</div>');
      setTxt('figLeituras', String(it.length));
    }

    // Segunda camada de verificação do regime: Receita Federal via BrasilAPI,
    // atualização por clique, uma consulta de cada vez, com timeout — a Receita
    // prevalece sobre o CRT quando divergem em "é Simples?".
    function chaveCrt(crt) { return crt === '1' || crt === '2' ? 'simples_duvida' : crt === '4' ? 'mei' : crt === '3' ? 'presumido' : 'desconhecido'; }
    function ehSimplesKey(k) { return k === 'simples_duvida' || k === 'simples_puro' || k === 'simples_hibrido' || k === 'mei'; }
    function mapeiaApi(d) {
      if (d.opcao_pelo_mei === true) return { key: 'mei', txt: 'MEI' };
      if (d.opcao_pelo_simples === true) return { key: 'simples_duvida', txt: 'Optante do Simples' };
      if (d.opcao_pelo_simples === false) return { key: 'presumido', txt: 'Não optante do Simples' };
      if (d.opcao_pelo_simples === null || d.opcao_pelo_simples === undefined) return { key: 'presumido', txt: d.porte && d.porte !== 'DEMAIS' ? 'Sem opção pelo Simples (confirmar)' : 'Sem opção pelo Simples' };
      return null;
    }
    function aplicaApi(sel, cel, crt, d) {
      var m = mapeiaApi(d);
      var spanRf = cel.querySelector('.cam-rf');
      if (!m) { if (spanRf) spanRf.textContent = 'Receita: sem informação do Simples'; return; }
      if (spanRf) spanRf.textContent = 'Receita: ' + m.txt;
      var diverge = !!crt && ehSimplesKey(chaveCrt(crt)) !== ehSimplesKey(m.key);
      var divEl = cel.querySelector('.cam-div');
      if (diverge && !divEl) { divEl = document.createElement('div'); divEl.className = 'cam-div'; cel.appendChild(divEl); }
      if (divEl) divEl.textContent = diverge ? '⚠ CRT da nota e Receita divergem — vale a Receita (cadastro atual)' : '';
      if (!sel.getAttribute('data-manual')) sel.value = m.key;
    }
    function consultarLote(classeSel, btn) {
      var sels = qsa('.' + classeSel);
      var statusEl = document.getElementById('consultaStatus-' + classeSel);
      var i = 0, ok = 0, falha = 0;
      btn.disabled = true;
      function proximo() {
        if (i >= sels.length) {
          btn.disabled = false;
          if (statusEl) statusEl.textContent = 'Concluído: ' + ok + ' consultado(s), ' + falha + ' falha(s).';
          recalcReforma();
          return;
        }
        var sel = sels[i++];
        var cel = sel.closest('tr').querySelector('.cam-cell');
        var cnpj = cel.getAttribute('data-cnpj');
        var crt = cel.getAttribute('data-crt');
        if (statusEl) statusEl.textContent = 'Consultando ' + i + ' de ' + sels.length + '...';
        var ctl = new AbortController();
        var t = setTimeout(function () { ctl.abort(); }, 10000);
        fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, { signal: ctl.signal })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (d) { clearTimeout(t); aplicaApi(sel, cel, crt, d); ok++; })
          .catch(function () { clearTimeout(t); falha++; })
          .then(function () { setTimeout(proximo, 350); });
      }
      proximo();
    }
    function abreSecao(id) { var d = document.getElementById(id); if (d && d.tagName === 'DETAILS') d.open = true; }
    (function () {
      qsa('.rf-in').forEach(function (el) {
        el.addEventListener('input', recalcReforma);
        el.addEventListener('change', recalcReforma);
      });
      qsa('.sel-regime-fornecedor, .sel-regime-cliente').forEach(function (el) {
        el.addEventListener('change', function () { el.setAttribute('data-manual', '1'); });
      });
      var campoCred = document.getElementById('simCredito');
      if (campoCred) campoCred.addEventListener('input', function () { campoCred.setAttribute('data-manual', '1'); recalcReforma(); });
      qsa('[data-aliq]').forEach(function (b) { b.addEventListener('click', function () { var c = document.getElementById('simAliqReforma'); if (c) { c.value = b.getAttribute('data-aliq'); recalcReforma(); } }); });
      qsa('[data-parcial]').forEach(function (b) { b.addEventListener('click', function () { var c = document.getElementById('inpParcial'); if (c) { c.value = b.getAttribute('data-parcial'); recalcReforma(); } }); });
      qsa('[data-fator]').forEach(function (b) { b.addEventListener('click', function () { var c = document.getElementById(b.getAttribute('data-fator')); if (c) { c.value = fmtNumBr(parseFloat(c.getAttribute('data-calc'))); recalcReforma(); } }); });
      var btnAuto = document.getElementById('btnCreditoAuto');
      if (btnAuto && campoCred) btnAuto.addEventListener('click', function () { campoCred.removeAttribute('data-manual'); recalcReforma(); });
      qsa('.btn-consulta-rf').forEach(function (btn) {
        btn.addEventListener('click', function () { consultarLote(btn.getAttribute('data-alvo'), btn); });
      });
      qsa('.btn-mais').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var corpo = btn.closest('.sec-corpo');
          var aberto = corpo.classList.toggle('mostra-tudo');
          btn.textContent = aberto ? 'Mostrar só os 10 maiores' : 'Mostrar todos os ' + btn.getAttribute('data-n');
        });
      });
      qsa('.top nav a').forEach(function (a) {
        a.addEventListener('click', function () { abreSecao(a.getAttribute('data-sec')); });
      });
      var bE = document.getElementById('btnExpandir'), bR = document.getElementById('btnRecolher');
      if (bE) bE.addEventListener('click', function () { qsa('details.sec').forEach(function (d) { d.open = true; }); });
      if (bR) bR.addEventListener('click', function () { qsa('details.sec').forEach(function (d) { d.open = false; }); });
      // ao imprimir ou salvar em PDF, tudo precisa estar aberto — senão sai só o cabeçalho das seções fechadas
      window.addEventListener('beforeprint', function () { qsa('details').forEach(function (d) { d.open = true; }); });
      recalcReforma();
    })();
    function baixarExcelTopico(id, nomeBase) {
      var t = DADOS[id];
      if (!t) return;
      var aoa = [t.colunas].concat(t.linhas);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Dados');
      XLSX.writeFile(wb, nomeBase + '.xlsx', { compression: true });
    }
  </script>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = nomeArquivoExport('perfil_do_cliente', 'html');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  };

  // All saída notes of the main company, plus inutilizações (XML-sourced or
  // manually confirmed), flagged with cancellation status — the searchable
  // pool for "pesquisar notas de saída".
  const notasSaida = useMemo(() => {
    if (!mainCnpj) return [];


    const notas = xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj)
      .map(xml => ({
        ...xml,
        isCancelada: !!(xml.chave && chavesCanceladas.has(xml.chave)),
        // Nota emitida pela própria empresa sob CFOP de entrada (devolução de venda,
        // baixa de estoque, etc.) — ocupa numeração real da série, mas não é venda.
        isEntradaPropria: xml.tpNF === '0',
      }));

    const inuts = inutilizacoes
      .filter(inut => inut.cnpj === mainCnpj)
      .map(inut => ({
        ...inut,
        numero: inut.nNFIni === inut.nNFFin ? String(inut.nNFIni) : `${inut.nNFIni} a ${inut.nNFFin}`,
        isCancelada: false,
        isEntradaPropria: false,
      }));

    return [...notas, ...inuts];
  }, [xmlList, inutilizacoes]);

  const modelosDisponiveis = useMemo(() => {
    return Array.from(new Set(notasSaida.map(n => n.modelo).filter((m): m is string => !!m))).sort();
  }, [notasSaida]);

  const cfopsDisponiveis = useMemo(() => {
    const cfopSet = new Set<string>();
    notasSaida.forEach(n => {
      if (n.cfopValores) Object.keys(n.cfopValores).forEach(c => cfopSet.add(c));
    });
    return Array.from(cfopSet).sort();
  }, [notasSaida]);

  const notasSaidaFiltradas = useMemo(() => {
    const query = notaSearchQuery.trim().toLowerCase();
    const temFiltroAtivo = query || filterNotaModelo !== 'Todos' || filterNotaSituacao !== 'Todas' || filterNotaCfop !== 'Todos';
    if (!temFiltroAtivo) return [];

    return notasSaida.filter(nota => {
      if (filterNotaModelo !== 'Todos' && nota.modelo !== filterNotaModelo) return false;
      if (filterNotaSituacao === 'Válidas' && (nota.isCancelada || nota.tipo === 'inutilizacao' || !nota.protocolo)) return false;
      if (filterNotaSituacao === 'Canceladas' && (!nota.isCancelada || nota.tipo === 'inutilizacao')) return false;
      if (filterNotaSituacao === 'Inutilizadas' && nota.tipo !== 'inutilizacao') return false;
      if (filterNotaSituacao === 'SemAutorizacao' && (nota.protocolo || nota.isCancelada || nota.tipo === 'inutilizacao')) return false;
      if (filterNotaSituacao === 'ForaDoPrazo' && !isForaDoPrazo(nota)) return false;
      if (filterNotaCfop !== 'Todos' && !(nota.cfopValores && filterNotaCfop in nota.cfopValores)) return false;
      if (!query) return true;

      const buscaItem = () => {
        if (!nota.rawXml || nota.tipo !== 'nfe') return false;
        const ex = getNotaExtract(nota);
        return ex?.dets.some(d => d.xProd.toLowerCase().includes(query)) ?? false;
      };
      const buscaNcm = () => {
        if (!nota.rawXml || nota.tipo !== 'nfe') return false;
        const ex = getNotaExtract(nota);
        return ex?.dets.some(d => d.ncm.toLowerCase().includes(query)) ?? false;
      };

      // Campo específico selecionado: busca só ali, pra não trazer resultado de
      // outro campo que por acaso tem o mesmo número/trecho (ex: valor == número da nota).
      if (notaSearchCampo === 'Numero') return (nota.numero || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Chave') return (nota.chave || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Cliente') return [nota.destNome, nota.destCnpj].some(c => c && c.toLowerCase().includes(query));
      if (notaSearchCampo === 'Data') return (nota.data || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Valor') return (nota.valor || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Item') return buscaItem();
      if (notaSearchCampo === 'Ncm') return buscaNcm();
      return false;
    });
  }, [notasSaida, notaSearchQuery, notaSearchCampo, filterNotaModelo, filterNotaSituacao, filterNotaCfop]);

  const periodoAnalise = useMemo(() => {
    const datas = xmlList
      .filter(xml => !mainCnpj || xml.emitCnpj === mainCnpj) // Only count client's sales/saídas
      .map(xml => xml.data ? xml.data.substring(0, 10) : '')
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    
    if (datas.length === 0) return { inicio: '', fim: '', totalDias: 0, diasDetalhados: [] };
    
    const formatarDataBR = (dateStr: string) => {
      const parts = dateStr.split('-');
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    };

    const getEpochDay = (dateStr: string) => {
      const parts = dateStr.split('-');
      const date = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
      return Math.floor(date.getTime() / (24 * 60 * 60 * 1000));
    };

    const fromEpochDay = (epochDay: number) => {
      const date = new Date(epochDay * 24 * 60 * 60 * 1000);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}/${month}/${year}`;
    };

    const uniqueDays: string[] = Array.from(new Set(datas));
    const epochDays = uniqueDays.map(getEpochDay).sort((a, b) => a - b);
    const groupedEpochs = agruparFaixas(epochDays);
    
    const diasDetalhados = groupedEpochs.map(faixa => {
      if (faixa.length === 1) {
        return fromEpochDay(faixa[0]);
      } else {
        return `${fromEpochDay(faixa[0])} a ${fromEpochDay(faixa[faixa.length - 1])}`;
      }
    });

    const notasPorDia: Record<string, number> = {};
    datas.forEach(d => { notasPorDia[d] = (notasPorDia[d] || 0) + 1; });
    const diasComContagem = Object.entries(notasPorDia)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([data, count]) => ({ data: formatarDataBR(data), count }));

    // Mesma faixa de dias consecutivos do diasDetalhados, mas somando as notas
    // de cada dia dentro da faixa — visão resumida (ex: "01 a 31") sem perder
    // a quantidade, só agregada por período em vez de dia a dia.
    const diasDetalhadosComContagem = groupedEpochs.map(faixa => {
      const label = faixa.length === 1
        ? fromEpochDay(faixa[0])
        : `${fromEpochDay(faixa[0])} a ${fromEpochDay(faixa[faixa.length - 1])}`;
      const totalFaixa = faixa.reduce((soma, epochDay) => {
        const dataIso = uniqueDays.find(d => getEpochDay(d) === epochDay);
        return soma + (dataIso ? (notasPorDia[dataIso] || 0) : 0);
      }, 0);
      return { label, totalNotas: totalFaixa, qtdDias: faixa.length };
    });

    return {
      inicio: formatarDataBR(datas[0]),
      fim: formatarDataBR(datas[datas.length - 1]),
      totalDias: uniqueDays.length,
      totalNotas: datas.length,
      diasDetalhados,
      diasComContagem,
      diasDetalhadosComContagem,
    };
  }, [xmlList, mainCnpj]);

  const mesesDisponiveis = useMemo(() => {
    const months = new Set<string>();
    xmlList.forEach(xml => {
      // Só conta o mês se a própria empresa auditada emitiu a nota — cobre
      // venda normal e devolução emitida por ela mesma (que ocupam numeração
      // própria), mas exclui meses onde só existem entradas de fornecedores
      // terceiros (essas notas têm data própria e aparecem em xmlList, mas
      // não formam série nenhuma na auditoria — sem isso, um mês assim
      // aparecia no filtro e dava resultado vazio/confuso ao selecionar).
      if (xml.emitCnpj !== mainCnpj) return;
      const my = getMonthYear(xml.data);
      if (my) months.add(my);
    });
    // Ordena por data real (ano + índice do mês), não por ordem alfabética do nome
    // do mês — senão "Abril" aparece antes de "Fevereiro" mesmo sendo mais recente.
    return Array.from(months).sort((a, b) => {
      const [nomeA, anoA] = a.split('/');
      const [nomeB, anoB] = b.split('/');
      const chaveA = `${anoA}${String(MESES.indexOf(nomeA)).padStart(2, '0')}`;
      const chaveB = `${anoB}${String(MESES.indexOf(nomeB)).padStart(2, '0')}`;
      return chaveA.localeCompare(chaveB);
    });
  }, [xmlList, mainCnpj]);

  // Auditoria de sequência da NFS-e — totalmente isolada do motor de NF-e/
  // NFC-e (runAnalysis/analysis/xmlList) de propósito: roda só em cima de
  // nfseList, então não tem como afetar a auditoria que já funciona hoje.
  // Agrupa por prestador (cnpj) + série e usa nDPS (nfseNumeroDPS) — não
  // nNFSe — porque nNFSe é atribuído pelo Ambiente Nacional e tem buracos
  // normais/esperados (números reservados que não viram nota), enquanto o
  // nDPS é controlado pelo próprio prestador, igual o nNF do NF-e.
  // Prestador principal da NFS-e — reaproveita o mainCnpj já identificado via
  // NF-e quando existe (é a mesma empresa auditada), senão calcula pelo
  // prestador mais frequente entre as próprias NFS-e (mesmo princípio do
  // mainCnpj de NF-e, mas em cima de emitCnpj/cnpj = prestador).
  const nfseMainCnpj = useMemo(() => {
    if (mainCnpj) return mainCnpj;
    const counts: Record<string, number> = {};
    nfseList.forEach(n => {
      if (n.tipo === 'nfse' && n.cnpj) counts[n.cnpj] = (counts[n.cnpj] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [mainCnpj, nfseList]);

  // Notas de serviço TOMADO pela empresa auditada (ela é o tomador, não o
  // prestador) — não fazem parte da sequência própria de emissão, igual as
  // notas de entrada de fornecedor no NF-e. Contadas aqui só pra avisar o
  // analista, não entram em nfseAnalysis.
  const nfseRecebidasInfo = useMemo(() => {
    if (!nfseMainCnpj) return null;
    const recebidas = nfseList.filter(n => n.tipo === 'nfse' && n.cnpj && n.cnpj !== nfseMainCnpj);
    if (recebidas.length === 0) return null;
    const nomes = Array.from(new Set(recebidas.map(n => n.razaoSocial).filter(Boolean))).slice(0, 3).join(', ');
    return { count: recebidas.length, nomes };
  }, [nfseList, nfseMainCnpj]);

  // Referências (chave e/ou nDFSe) de NFS-e canceladas via evento separado
  // (ver comentário em parseXML) — usado pra marcar a nota original como
  // cancelada sem contar o número dela como faltante na sequência.
  const nfseCanceladasRefs = useMemo(() => {
    const set = new Set<string>();
    nfseList.forEach(n => {
      if (n.tipo !== 'nfse_evento') return;
      if (n.chave) set.add(`chave:${n.chave}`);
      if (n.numero) set.add(`ndfse:${n.numero}`);
    });
    return set;
  }, [nfseList]);

  // Suspeita de nota cancelada e reemitida — muitos emissores próprios de
  // NFS-e não geram (ou não permitem baixar) o evento de cancelamento; o
  // XML da própria nota também não muda quando ela é cancelada (confirmado
  // com um caso real: baixar a mesma nota de novo trouxe o cStat idêntico).
  // Sem nenhum arquivo pra confirmar, a única pista que sobra é o padrão de
  // reemissão: duas notas na mesma série, mesmo tomador, mesmo valor, mesma
  // data e nDPS consecutivo. Isso NÃO confirma cancelamento — só levanta a
  // suspeita pro analista investigar manualmente (ex: no portal do prestador).
  const nfseSuspeitasCanceladas = useMemo(() => {
    const set = new Set<string>();
    if (!nfseMainCnpj) return set;
    const notas = nfseList.filter(n => n.tipo === 'nfse' && n.cnpj === nfseMainCnpj);
    for (let i = 0; i < notas.length; i++) {
      for (let j = i + 1; j < notas.length; j++) {
        const a = notas[i], b = notas[j];
        if (a.serie !== b.serie || !a.destCnpj || a.destCnpj !== b.destCnpj) continue;
        const va = parseFloat(a.valor || '0'), vb = parseFloat(b.valor || '0');
        if (Math.abs(va - vb) > 0.01) continue;
        const da = (a.data || '').slice(0, 10), db = (b.data || '').slice(0, 10);
        if (!da || da !== db) continue;
        const na = parseInt(a.nfseNumeroDPS || '', 10), nb = parseInt(b.nfseNumeroDPS || '', 10);
        if (isNaN(na) || isNaN(nb) || Math.abs(na - nb) !== 1) continue;
        if (a.chave) set.add(a.chave);
        if (b.chave) set.add(b.chave);
      }
    }
    return set;
  }, [nfseList, nfseMainCnpj]);

  const nfseAnalysis = useMemo(() => {
    if (nfseList.length === 0 || !nfseMainCnpj) return [];

    const grupos: Record<string, { cnpj: string; razaoSocial: string; serie: string; numeros: number[]; canceladosSet: Set<number>; suspeitasSet: Set<number> }> = {};
    nfseList.forEach(n => {
      if (n.tipo !== 'nfse' || n.cnpj !== nfseMainCnpj) return;
      const numDps = parseInt(n.nfseNumeroDPS || '', 10);
      if (!n.serie || isNaN(numDps)) return;
      const key = `${n.cnpj}_${n.serie}`;
      if (!grupos[key]) {
        grupos[key] = { cnpj: n.cnpj!, razaoSocial: n.razaoSocial || '', serie: n.serie, numeros: [], canceladosSet: new Set(), suspeitasSet: new Set() };
      }
      grupos[key].numeros.push(numDps);
      const isCancelada = (!!n.chave && nfseCanceladasRefs.has(`chave:${n.chave}`)) ||
                           (!!n.nfseNumeroDFSe && nfseCanceladasRefs.has(`ndfse:${n.nfseNumeroDFSe}`));
      if (isCancelada) grupos[key].canceladosSet.add(numDps);
      if (!isCancelada && n.chave && nfseSuspeitasCanceladas.has(n.chave)) grupos[key].suspeitasSet.add(numDps);
    });

    return Object.values(grupos).map(g => {
      const numerosSet = new Set(g.numeros);
      const numerosOrdenados = Array.from(numerosSet).sort((a, b) => a - b);
      const min = numerosOrdenados[0];
      const max = numerosOrdenados[numerosOrdenados.length - 1];
      const esperados = max - min + 1;
      const recebidos = numerosSet.size;
      const duplicados = g.numeros.length - numerosSet.size;
      const faltantes: number[] = [];
      for (let i = min; i <= max; i++) {
        if (!numerosSet.has(i)) {
          faltantes.push(i);
          if (faltantes.length > 10000) break;
        }
      }
      const cancelados = Array.from(g.canceladosSet).sort((a, b) => a - b);
      const suspeitasCanceladas = Array.from(g.suspeitasSet).sort((a, b) => a - b);
      return { cnpj: g.cnpj, razaoSocial: g.razaoSocial, serie: g.serie, min, max, esperados, recebidos, duplicados, faltantes, cancelados, suspeitasCanceladas };
    });
  }, [nfseList, nfseMainCnpj, nfseCanceladasRefs, nfseSuspeitasCanceladas]);

  useEffect(() => {
    if (analysis) {
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMes, inutilizacoes]);

  const exportFilteredXmls = async (partes?: number) => {
    let filteredXmls = xmlList;
    if (filterMes !== 'Todos') {
      filteredXmls = xmlList.filter(xml => getMonthYear(xml.data) === filterMes);
    }

    let filteredInuts = inutilizacoes;
    if (filterMes !== 'Todos') {
      filteredInuts = inutilizacoes.filter(inut => getMonthYear(inut.data) === filterMes);
    }

    type FileEntry = { name: string; content: string };
    const allFiles: FileEntry[] = [];

    filteredXmls.forEach(xml => {
      if (!xml.rawXml) return;
      const name = nomeBaseArquivo(xml.fileName || `${xml.chave || xml.numero}.xml`);
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      allFiles.push({ name: safeName, content: xml.rawXml });
    });

    filteredInuts.forEach(inut => {
      if (!inut.rawXml) return;
      const name = nomeBaseArquivo(inut.fileName || `inutilizacao_${inut.serie}_${inut.nNFIni}_${inut.nNFFin}.xml`);
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      allFiles.push({ name: `inutilizacoes/${safeName}`, content: inut.rawXml });
    });

    if (allFiles.length === 0) {
      alert("Nenhum XML de nota fiscal encontrado para exportar.");
      return;
    }

    try {
      const n = partes ?? exportPartes;
      const chunkSize = Math.ceil(allFiles.length / n);

      for (let i = 0; i < n; i++) {
        const chunk = allFiles.slice(i * chunkSize, (i + 1) * chunkSize);
        if (chunk.length === 0) continue;
        const zip = new JSZip();
        chunk.forEach(f => zip.file(f.name, f.content));
        const content = await zip.generateAsync({ type: 'blob' });
        const suffix = n > 1 ? `_parte${i + 1}de${n}` : '';
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = nomeArquivoExport(`xmls_filtrados${suffix}`, 'zip');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (i < n - 1) await new Promise(resolve => setTimeout(resolve, 400));
      }
    } catch (err) {
      console.error("Erro ao gerar arquivo ZIP:", err);
      alert("Erro ao exportar arquivos XML.");
    }
  };

  // Auditoria de XML: confronta os itens lidos direto do XML (fonte fiscal) contra
  // uma planilha detalhada exportada de outro sistema (ex: Questor), item a item,
  // pra flagrar NCM ou nome de produto que o outro sistema mostra diferente do XML.
  const normalizarTextoHeader = (v: string) =>
    v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const normalizarNcmAuditoria = (v: string) => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

  // Agrupa as chaves cruas "serie::numero" por série, pra não repetir "Série X Nº"
  // na frente de cada número — ex: "Série 100: 86175, 86183, 86200 +127".
  const formatarNotasAgrupadas = (chaves: string[], truncar = true) => {
    const porSerie = new Map<string, string[]>();
    chaves.forEach(chave => {
      const [serie, numero] = chave.split('::');
      if (!porSerie.has(serie)) porSerie.set(serie, []);
      porSerie.get(serie)!.push(numero);
    });
    return Array.from(porSerie.entries()).map(([serie, numeros]) => {
      const ordenados = numeros.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
      const visiveis = truncar && ordenados.length > 10 ? `${ordenados.slice(0, 10).join(', ')} +${ordenados.length - 10}` : ordenados.join(', ');
      return `Série ${serie}: ${visiveis}`;
    });
  };

  const agruparItensAuditoria = (linhas: { natureza: string; ncm: string; item: string; valor: number; notaRef?: string }[]) => {
    const grupos = new Map<string, { item: string; ncmsRaw: Set<string>; ncmsNorm: Set<string>; naturezas: Set<string>; notas: Set<string>; count: number; total: number }>();
    linhas.forEach(l => {
      const item = l.item.trim();
      if (!item) return;
      const key = item.toUpperCase();
      let g = grupos.get(key);
      if (!g) {
        g = { item, ncmsRaw: new Set(), ncmsNorm: new Set(), naturezas: new Set(), notas: new Set(), count: 0, total: 0 };
        grupos.set(key, g);
      }
      g.ncmsRaw.add(l.ncm);
      g.ncmsNorm.add(normalizarNcmAuditoria(l.ncm));
      g.naturezas.add((l.natureza || '').slice(0, 4));
      if (l.notaRef) g.notas.add(l.notaRef);
      g.count += 1;
      g.total += l.valor;
    });
    return grupos;
  };

  const runAuditoriaXml = async (file: File) => {
    setAuditoriaLoading(true);
    setAuditoriaErro(null);
    setAuditoriaResultado(null);
    setAuditoriaNomeArquivo(file.name);
    try {
      let notas = notasSaida.filter(n => n.tipo === 'nfe' && !n.isCancelada && !n.isEntradaPropria && n.protocolo && n.rawXml);
      if (filterMes !== 'Todos') {
        notas = notas.filter(n => getMonthYear(n.data) === filterMes);
      }
      if (notas.length === 0) {
        throw new Error('Nenhuma nota de saída válida encontrada no período selecionado.');
      }

      const linhasApp: { natureza: string; ncm: string; item: string; valor: number; notaRef: string }[] = [];
      notas.forEach(nota => {
        const doc = parser.parseFromString(nota.rawXml!, 'text/xml');
        const notaRef = `${nota.serie || '?'}::${nota.numero || '?'}`;
        Array.from(doc.getElementsByTagName('det')).forEach(det => {
          const get = (tag: string) => det.getElementsByTagName(tag)[0]?.textContent || '';
          linhasApp.push({
            natureza: get('CFOP'),
            ncm: get('NCM'),
            item: get('xProd'),
            valor: parseFloat(get('vProd')) || 0,
            notaRef,
          });
        });
      });

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }) as unknown[][];
      if (rows.length < 2) {
        throw new Error('A planilha anexada está vazia.');
      }

      // Encontra a coluna certa: exige igualdade exata primeiro (senão "Código Item"
      // "ganha" de "Item" por conter a mesma palavra), só cai pra substring se não achar.
      const acharColuna = (header: string[], chaves: string[]) => {
        for (const c of chaves) {
          const idx = header.findIndex(h => h === c);
          if (idx >= 0) return idx;
        }
        for (const c of chaves) {
          const idx = header.findIndex(h => h.includes(c));
          if (idx >= 0) return idx;
        }
        return -1;
      };

      // A linha de cabeçalho nem sempre é a primeira (algumas exportações têm uma
      // linha de título/branco antes) — varre as primeiras linhas até achar uma
      // que tenha as 3 colunas essenciais.
      let headerRowIdx = -1;
      let colNatureza = -1, colNcm = -1, colItem = -1, colValor = -1, colDocumento = -1, colSerie = -1;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const header = (rows[i] as unknown[]).map(h => normalizarTextoHeader(String(h ?? '')));
        const ncm = acharColuna(header, ['ncm']);
        const item = acharColuna(header, ['item', 'produto', 'descricao', 'mercadoria']);
        const valor = acharColuna(header, ['valor contabil', 'valor cont', 'valor']);
        if (ncm >= 0 && item >= 0 && valor >= 0) {
          headerRowIdx = i;
          colNcm = ncm;
          colItem = item;
          colValor = valor;
          colNatureza = acharColuna(header, ['natureza', 'cfop']);
          colDocumento = acharColuna(header, ['documento', 'numero da nota', 'nnf']);
          colSerie = acharColuna(header, ['serie']);
          break;
        }
      }
      if (headerRowIdx === -1) {
        throw new Error('Não encontrei as colunas de NCM, Item e Valor Contábil nessa planilha. Confira se é a exportação detalhada correta.');
      }

      const linhasPlanilha: { natureza: string; ncm: string; item: string; valor: number; notaRef?: string }[] = rows
        .slice(headerRowIdx + 1)
        .filter(r => r && r[colItem] != null && String(r[colItem]).trim() !== '')
        .map(r => {
          const documento = colDocumento >= 0 ? String(r[colDocumento] ?? '').trim() : '';
          const serie = colSerie >= 0 ? String(r[colSerie] ?? '').trim() : '';
          return {
            natureza: colNatureza >= 0 ? String(r[colNatureza] ?? '').trim() : '',
            ncm: String(r[colNcm] ?? '').trim(),
            item: String(r[colItem] ?? '').trim(),
            valor: parseFloat(String(r[colValor] ?? '0').replace(',', '.')) || 0,
            notaRef: documento ? `${serie || '?'}::${documento}` : undefined,
          };
        });

      if (linhasPlanilha.length === 0) {
        throw new Error('Não encontrei linhas de item válidas nessa planilha.');
      }

      const gruposApp = agruparItensAuditoria(linhasApp);
      const gruposPlanilha = agruparItensAuditoria(linhasPlanilha);

      const diferencas: DiferencaAuditoria[] = [];
      const usadosPlanilha = new Set<string>();

      gruposApp.forEach((grupoA, key) => {
        const grupoP = gruposPlanilha.get(key);
        if (!grupoP) return;
        usadosPlanilha.add(key);
        const ncmA = Array.from(grupoA.ncmsNorm).sort().join(',');
        const ncmP = Array.from(grupoP.ncmsNorm).sort().join(',');
        if (ncmA !== ncmP) {
          diferencas.push({
            tipo: 'NCM',
            itemSequencia: grupoA.item,
            itemPlanilha: grupoP.item,
            ncmSequencia: Array.from(grupoA.ncmsRaw).join(', '),
            ncmPlanilha: Array.from(grupoP.ncmsRaw).join(', '),
            notasSequencia: Array.from(grupoA.notas),
            notasPlanilha: Array.from(grupoP.notas),
            ocorrencias: grupoA.count,
            valor: grupoA.total,
          });
        }
      });

      const restantesApp = Array.from(gruposApp.entries()).filter(([key]) => !gruposPlanilha.has(key));
      const restantesPlanilha = Array.from(gruposPlanilha.entries()).filter(([key]) => !usadosPlanilha.has(key) && !gruposApp.has(key));
      const usadosPlanilha2 = new Set<string>();

      restantesApp.forEach(([, grupoA]) => {
        const idxMatch = restantesPlanilha.findIndex(([keyP, grupoP]) =>
          !usadosPlanilha2.has(keyP) &&
          grupoA.count === grupoP.count &&
          Math.abs(grupoA.total - grupoP.total) < 0.02 &&
          Array.from(grupoA.naturezas).some(n => grupoP.naturezas.has(n))
        );
        if (idxMatch >= 0) {
          const [keyP, grupoP] = restantesPlanilha[idxMatch];
          usadosPlanilha2.add(keyP);
          const ncmA = Array.from(grupoA.ncmsNorm).sort().join(',');
          const ncmP = Array.from(grupoP.ncmsNorm).sort().join(',');
          diferencas.push({
            tipo: ncmA !== ncmP ? 'Nome e NCM' : 'Nome',
            itemSequencia: grupoA.item,
            itemPlanilha: grupoP.item,
            ncmSequencia: Array.from(grupoA.ncmsRaw).join(', '),
            ncmPlanilha: Array.from(grupoP.ncmsRaw).join(', '),
            notasSequencia: Array.from(grupoA.notas),
            notasPlanilha: Array.from(grupoP.notas),
            ocorrencias: grupoA.count,
            valor: grupoA.total,
          });
        } else {
          diferencas.push({
            tipo: 'Sequência',
            itemSequencia: grupoA.item,
            itemPlanilha: '',
            ncmSequencia: Array.from(grupoA.ncmsRaw).join(', '),
            ncmPlanilha: '',
            notasSequencia: Array.from(grupoA.notas),
            notasPlanilha: [],
            ocorrencias: grupoA.count,
            valor: grupoA.total,
          });
        }
      });

      restantesPlanilha.forEach(([keyP, grupoP]) => {
        if (usadosPlanilha2.has(keyP)) return;
        diferencas.push({
          tipo: 'Planilha',
          itemSequencia: '',
          itemPlanilha: grupoP.item,
          ncmSequencia: '',
          ncmPlanilha: Array.from(grupoP.ncmsRaw).join(', '),
          notasSequencia: [],
          notasPlanilha: Array.from(grupoP.notas),
          ocorrencias: grupoP.count,
          valor: grupoP.total,
        });
      });

      // Cruza notas entre categorias: se a mesma nota (por outro item nela) já
      // aparece em outro tipo de divergência, destaca isso pro analista notar
      // que aquela nota tem mais de um ponto pra conferir.
      const notaParaTipos = new Map<string, Set<TipoDiferencaAuditoria>>();
      diferencas.forEach(d => {
        [...d.notasSequencia, ...d.notasPlanilha].forEach(n => {
          if (!notaParaTipos.has(n)) notaParaTipos.set(n, new Set());
          notaParaTipos.get(n)!.add(d.tipo);
        });
      });
      diferencas.forEach(d => {
        const outros = new Set<TipoDiferencaAuditoria>();
        [...d.notasSequencia, ...d.notasPlanilha].forEach(n => {
          notaParaTipos.get(n)?.forEach(t => { if (t !== d.tipo) outros.add(t); });
        });
        if (outros.size > 0) d.outrosTipos = Array.from(outros).join(', ');
      });

      diferencas.sort((a, b) => b.valor - a.valor);
      setAuditoriaResultado(diferencas);
    } catch (err) {
      setAuditoriaErro(err instanceof Error ? err.message : 'Erro ao processar a planilha.');
    } finally {
      setAuditoriaLoading(false);
    }
  };

  const exportarAuditoriaXml = () => {
    if (!auditoriaResultado || auditoriaResultado.length === 0) return;
    const header = ['Tipo', 'Item (Sequência Fiscal)', 'Item (Planilha)', 'NCM (Sequência Fiscal)', 'NCM (Planilha)', 'Notas (Sequência Fiscal)', 'Notas (Planilha)', 'Também aparece em', 'Ocorrências', 'Valor Total'];
    const linhaDe = (d: DiferencaAuditoria): (string | number)[] => [
      d.tipo, d.itemSequencia, d.itemPlanilha, d.ncmSequencia, d.ncmPlanilha,
      formatarNotasAgrupadas(d.notasSequencia, false).join('; '),
      formatarNotasAgrupadas(d.notasPlanilha, false).join('; '),
      d.outrosTipos || '',
      d.ocorrencias, d.valor,
    ];
    const wb = XLSX.utils.book_new();
    const adicionarAba = (nome: string, linhas: DiferencaAuditoria[]) => {
      if (linhas.length === 0) return;
      const aoa: (string | number)[][] = [header, ...linhas.map(linhaDe)];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 16 }, { wch: 32 }, { wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 30 }, { wch: 30 }, { wch: 18 }, { wch: 11 }, { wch: 13 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, nome.slice(0, 31));
    };

    adicionarAba('Todas', auditoriaResultado);
    (['NCM', 'Nome', 'Nome e NCM', 'Sequência', 'Planilha'] as TipoDiferencaAuditoria[]).forEach(t => {
      adicionarAba(t, auditoriaResultado.filter(d => d.tipo === t));
    });

    XLSX.writeFile(wb, nomeArquivoExport('auditoria_xml_divergencias', 'xlsx'), { compression: true });
  };

  // Simplified confronto: just Natureza/NCM/Item/Valor Contábil, plus the
  // Desconto-onward columns — each included only if some row actually has a value.
  const exportarPlanilhaDetalhadaSimples = async () => {
    let notas = notasSaida.filter(n => n.tipo === 'nfe' && !n.isCancelada && !n.isEntradaPropria && n.protocolo && n.rawXml);
    if (filterMes !== 'Todos') {
      notas = notas.filter(n => getMonthYear(n.data) === filterMes);
    }
    if (notas.length === 0) {
      alert('Nenhuma nota de saída válida encontrada para exportar.');
      return;
    }

    interface LinhaItem {
      natureza: string;
      ncm: string;
      item: string;
      valorContabil: number;
      desconto: number;
      despesas: number;
      frete: number;
      seguro: number;
    }

    const linhas: LinhaItem[] = [];
    const processarNota = (nota: XmlData) => {
      const doc = parser.parseFromString(nota.rawXml!, 'text/xml');
      Array.from(doc.getElementsByTagName('det')).forEach(det => {
        const get = (tag: string) => det.getElementsByTagName(tag)[0]?.textContent || '';
        const num = (tag: string) => parseFloat(get(tag)) || 0;
        linhas.push({
          natureza: get('CFOP'),
          ncm: get('NCM'),
          item: get('xProd'),
          valorContabil: num('vProd'),
          desconto: num('vDesc'),
          despesas: num('vOutro'),
          frete: num('vFrete'),
          seguro: num('vSeg'),
        });
      });
    };

    try {
      const titulo = 'Gerando Planilha Detalhada';
      const LOTE = 300;
      for (let i = 0; i < notas.length; i += LOTE) {
        notas.slice(i, i + LOTE).forEach(processarNota);
        setExportProgress({ atual: Math.min(i + LOTE, notas.length), total: notas.length, etapa: 'Lendo XMLs', titulo });
        await new Promise(r => setTimeout(r, 0));
      }

      if (linhas.length === 0) {
        alert('Nenhum item encontrado nos XMLs das notas válidas.');
        return;
      }

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Montando planilha', titulo });
      await new Promise(r => setTimeout(r, 0));

      const temDesconto = linhas.some(l => l.desconto > 0);
      const temDespesas = linhas.some(l => l.despesas > 0);
      const temFrete = linhas.some(l => l.frete > 0);
      const temSeguro = linhas.some(l => l.seguro > 0);

      const header = ['Natureza', 'NCM', 'Item', 'Valor Contábil'];
      if (temDesconto) header.push('Desconto');
      if (temDespesas) header.push('Despesas Acessórias');
      if (temFrete) header.push('Frete');
      if (temSeguro) header.push('Seguro');

      const aoa: (string | number)[][] = [header];
      linhas.forEach(l => {
        const row: (string | number)[] = [l.natureza, l.ncm, l.item, l.valorContabil];
        if (temDesconto) row.push(l.desconto);
        if (temDespesas) row.push(l.despesas);
        if (temFrete) row.push(l.frete);
        if (temSeguro) row.push(l.seguro);
        aoa.push(row);
      });

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 10 },
        { wch: 12 },
        { wch: 40 },
        { wch: 14 },
        ...header.slice(4).map(() => ({ wch: 14 }))
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Confronto Simples');

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Gerando arquivo', titulo });
      await new Promise(r => setTimeout(r, 0));

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = nomeArquivoExport('planilha_confronto_simples', 'xlsx');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error('Erro ao exportar planilha confronto simples:', err);
      alert('Não foi possível gerar a planilha. Isso costuma acontecer quando o período selecionado tem notas demais pro navegador processar de uma vez — tente filtrar por um mês específico e exportar de novo.');
    } finally {
      setExportProgress(null);
    }
  };

  // Mirrors Questor's "detalhada" export layout (46 columns, same order/formats).
  // Content comes from the XMLs (the fiscal source of truth), so item names/NCMs
  // follow the notes rather than Questor's internal cadastro. When a note's item
  // sum doesn't reconcile to its vNF (note-level acréscimo/rounding), a synthetic
  // "Produto Padrão" adjustment row is emitted — exactly like Questor does.
  const exportarPlanilhaDetalhadaCompleta = async () => {
    let notas = notasSaida.filter(n => n.tipo === 'nfe' && !n.isCancelada && !n.isEntradaPropria && n.protocolo && n.rawXml);
    if (filterMes !== 'Todos') {
      notas = notas.filter(n => getMonthYear(n.data) === filterMes);
    }
    if (notas.length === 0) {
      alert('Nenhuma nota de saída válida encontrada para exportar.');
      return;
    }

    const fmtCnpj = (v: string) =>
      /^\d{14}$/.test(v) ? `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}` : v;
    const fmtCpf = (v: string) =>
      /^\d{11}$/.test(v) ? `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}` : v;
    const fmtNcm = (v: string) =>
      /^\d{8}$/.test(v) ? `${v.slice(0,4)}.${v.slice(4,6)}.${v.slice(6)}` : v;
    const fmtData = (iso?: string) => {
      if (!iso) return '';
      const d = iso.substring(0, 10).split('-');
      return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : '';
    };

    const header = [
      'CNPJ (Matriz/Filial)', 'Nome Filial', 'Chave do Lançamento', 'Documento', 'Espécie', 'Série',
      'Data Entrada/Saída', 'Data Emissão', 'Natureza', 'Nome', 'CNPJ (Cliente/Fornecedor)',
      'NCM', 'Código Item', 'Item', 'Unidade', 'Quantidade', 'Valor Contábil',
      'CST ICMS', 'Base Cálculo ICMS', 'Alíquota ICMS', 'Valor ICMS', 'Isentas ICMS', 'Outras ICMS',
      'CST IPI', 'Base Cálculo IPI', 'Alíquota IPI', 'Valor IPI', 'Isentas IPI', 'Outras IPI',
      'CST ISS', 'Base Cálculo ISS', 'Alíquota ISS', 'Valor ISS', 'Isentas ISS', 'Outras ISS',
      'CST ST', 'Base Cálculo ST', 'Alíquota ST', 'Valor ST', 'Isentas ST', 'Outras ST',
      'Desconto', 'Despesas Acessórias', 'Frete', 'Seguro', 'Abatimento Não Tributado'
    ];
    const aoa: (string | number)[][] = [header];

    const processarNota = (nota: XmlData) => {
      const doc = parser.parseFromString(nota.rawXml!, 'text/xml');
      const emitCnpj = fmtCnpj(nota.emitCnpj || '');
      const nomeFilial = (nota.emitCnpj || '').slice(8, 12) === '0001' ? 'Matriz' : 'Filial';
      const especie = nota.modelo === '65' ? 'NFCE' : 'NFE';
      const dataFmt = fmtData(nota.data);
      const nomeCliente = nota.destNome || 'Diversos';
      const destDoc = nota.destCnpj
        ? fmtCnpj(nota.destCnpj)
        : (() => {
            const dest = doc.getElementsByTagName('dest')[0];
            const cpf = dest?.getElementsByTagName('CPF')[0]?.textContent || '';
            return cpf ? fmtCpf(cpf) : '000.000.000-00';
          })();
      const docNum = parseInt(nota.numero || '') || nota.numero || '';
      const serieNum = parseInt(nota.serie || '') || nota.serie || '';

      let somaItens = 0;
      let cfopPredominante = '';

      Array.from(doc.getElementsByTagName('det')).forEach(det => {
        const get = (tag: string) => det.getElementsByTagName(tag)[0]?.textContent || '';
        const num = (tag: string) => parseFloat(get(tag)) || 0;

        const vProd = num('vProd');
        const vDesc = num('vDesc');
        const vFreteI = num('vFrete');
        const vSegI = num('vSeg');
        const vOutroI = num('vOutro');
        somaItens += vProd - vDesc + vFreteI + vSegI + vOutroI;

        const cfop = get('CFOP');
        if (!cfopPredominante) cfopPredominante = cfop;

        // CST/CSOSN and ICMS values from whichever ICMSxx/ICMSSNxxx block is present
        const icms = det.getElementsByTagName('ICMS')[0];
        const cst = icms?.getElementsByTagName('CSOSN')[0]?.textContent
          || icms?.getElementsByTagName('CST')[0]?.textContent || '';
        const vBC = parseFloat(icms?.getElementsByTagName('vBC')[0]?.textContent || '0') || 0;
        const pICMS = parseFloat(icms?.getElementsByTagName('pICMS')[0]?.textContent || '0') || 0;
        const vICMS = parseFloat(icms?.getElementsByTagName('vICMS')[0]?.textContent || '0') || 0;
        const vBCST = parseFloat(icms?.getElementsByTagName('vBCST')[0]?.textContent || '0') || 0;
        const pICMSST = parseFloat(icms?.getElementsByTagName('pICMSST')[0]?.textContent || '0') || 0;
        const vICMSST = parseFloat(icms?.getElementsByTagName('vICMSST')[0]?.textContent || '0') || 0;

        // Livro-fiscal classification as observed in Questor's export:
        // CSOSN 102/103/300/400 → full item value in "Outras"; CST 40/41 → "Isentas";
        // CSOSN 500 / CST 60 (ST já retido) → all zeros.
        const isentas = (cst === '40' || cst === '41') ? vProd : 0;
        const outras = (cst === '102' || cst === '103' || cst === '300' || cst === '400' || cst === '90') ? vProd : 0;

        const ipi = det.getElementsByTagName('IPI')[0];
        const cstIpi = ipi?.getElementsByTagName('CST')[0]?.textContent || '';
        const vBCIpi = parseFloat(ipi?.getElementsByTagName('vBC')[0]?.textContent || '0') || 0;
        const pIpi = parseFloat(ipi?.getElementsByTagName('pIPI')[0]?.textContent || '0') || 0;
        const vIpi = parseFloat(ipi?.getElementsByTagName('vIPI')[0]?.textContent || '0') || 0;

        aoa.push([
          emitCnpj, nomeFilial, '', docNum, especie, serieNum,
          dataFmt, dataFmt, cfop, nomeCliente, destDoc,
          fmtNcm(get('NCM')), parseInt(get('cProd')) || get('cProd'), get('xProd'), get('uCom'), num('qCom'), vProd,
          parseInt(cst) || cst, vBC, pICMS, vICMS, isentas, outras,
          parseInt(cstIpi) || 0, vBCIpi, pIpi, vIpi, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, vBCST, pICMSST, vICMSST, 0, 0,
          vDesc, vOutroI, vFreteI, vSegI, 0
        ]);
      });

      // Note-level reconciliation: if the items don't sum to the note's vNF
      // (acréscimo/rounding recorded only in the totals block), emit the same
      // "Produto Padrão" adjustment row Questor generates.
      const vNF = parseFloat(nota.valor || '0') || 0;
      const ajuste = Math.round((vNF - somaItens) * 100) / 100;
      if (Math.abs(ajuste) >= 0.01) {
        aoa.push([
          emitCnpj, nomeFilial, '', docNum, especie, serieNum,
          dataFmt, dataFmt, cfopPredominante, nomeCliente, destDoc,
          '9999.99.99', 0, 'Produto Padrão', '', 0, ajuste,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0
        ]);
      }
    };

    try {
      const titulo = 'Gerando Planilha Detalhada';
      const LOTE = 300;
      for (let i = 0; i < notas.length; i += LOTE) {
        notas.slice(i, i + LOTE).forEach(processarNota);
        setExportProgress({ atual: Math.min(i + LOTE, notas.length), total: notas.length, etapa: 'Lendo XMLs', titulo });
        await new Promise(r => setTimeout(r, 0));
      }

      if (aoa.length === 1) {
        alert('Nenhum item encontrado nos XMLs das notas válidas.');
        return;
      }

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Montando planilha', titulo });
      await new Promise(r => setTimeout(r, 0));

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = header.map((h, i) => ({ wch: i === 13 ? 40 : Math.max(12, h.length + 2) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Detalhada');

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Gerando arquivo', titulo });
      await new Promise(r => setTimeout(r, 0));

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = nomeArquivoExport('planilha_detalhada', 'xlsx');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error('Erro ao exportar planilha detalhada:', err);
      alert('Não foi possível gerar a planilha detalhada. Isso costuma acontecer quando o período selecionado tem notas demais pro navegador processar de uma vez — tente filtrar por um mês específico e exportar de novo.');
    } finally {
      setExportProgress(null);
    }
  };

  // Full field-by-field XML → spreadsheet conversion (mirrors the layout of
  // dedicated "XML to Excel" conversion tools): one workbook, 12 sheets, each
  // sheet a flat 1:1 mapping of one block of the nfeProc schema. Unlike the
  // other exports (which filter to valid/auditable notes), this dumps every
  // note with a rawXml as-is — cancelled, sem autorização, contingência,
  // doesn't matter, since the point here is raw field visibility, not audit.
  const exportarPlanilhaCompletaXML = async () => {
    let notas = notasSaida.filter(n => n.tipo === 'nfe' && n.rawXml);
    if (filterMes !== 'Todos') {
      notas = notas.filter(n => getMonthYear(n.data) === filterMes);
    }
    if (notas.length === 0) {
      alert('Nenhuma nota com XML encontrada para exportar.');
      return;
    }

    // Scoped text/number lookup: search only within a given element's subtree,
    // never document-wide — required since tag names like vBC/CST repeat
    // across ICMS/IPI/PIS/COFINS/IBSCBS with different meanings per block.
    const t = (scope: Element | Document | null | undefined, tag: string): string =>
      scope?.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
    const n = (scope: Element | Document | null | undefined, tag: string): number =>
      parseFloat(t(scope, tag)) || 0;
    const first = (scope: Element | Document | null | undefined, tag: string): Element | undefined =>
      scope?.getElementsByTagName(tag)[0];

    const rowsIdent: (string | number)[][] = [[
      'Arquivo', 'Versão_XML', 'Chave_de_Acesso', 'cUF', 'cNF', 'natOp', 'indPag', 'mod', 'serie', 'nNF',
      'dhEmi', 'dhSaiEnt', 'hSaiEnt', 'tpNF', 'idDest', 'cMunFG', 'tpImp', 'tpEmis', 'cDV', 'tpAmb',
      'finNFe', 'indFinal', 'indPres', 'indIntermed', 'procEmi', 'verProc', 'dhCont', 'xJust',
      'NFREF_refNFe', 'REFNF_cUF', 'REFNF_AAMM', 'REFNF_CNPJ', 'REFNF_mod', 'REFNF_serie', 'REFNF_nNF',
      'REFNFP_cUF', 'REFNFP_AAMM', 'REFNFP_CNPJ', 'REFNFP_CPF', 'REFNFP_IE', 'REFNFP_mod', 'REFNFP_serie', 'REFNFP_nNF',
      'refCTe', 'REFECF_mod', 'REFECF_nECF', 'REFECF_nCOO'
    ]];
    const rowsEmit: (string | number)[][] = [[
      'Arquivo', 'nNF', 'CNPJ', 'CPF', 'xNome', 'xFant', 'enderEMIT_xLgr', 'enderEMIT_nro', 'enderEMIT_xCpl',
      'enderEMIT_xBairro', 'enderEMIT_cMun', 'enderEMIT_xMun', 'enderEMIT_UF', 'enderEMIT_CEP', 'enderEMIT_cPais',
      'enderEMIT_xPais', 'enderEMIT_fone', 'IE', 'IEST', 'IM', 'CNAE', 'CRT'
    ]];
    const rowsDest: (string | number)[][] = [[
      'Arquivo', 'nNF', 'CNPJ', 'CPF', 'idEstrangeiro', 'xNome', 'enderDEST_xLgr', 'enderDEST_nro', 'enderDEST_xCpl',
      'enderDEST_xBairro', 'enderDEST_cMun', 'enderDEST_xMun', 'enderDEST_UF', 'enderDEST_CEP', 'enderDEST_cPais',
      'enderDEST_xPais', 'enderDEST_fone', 'indIEDest', 'IE', 'ISUF', 'IM', 'email'
    ]];
    const rowsItens: (string | number)[][] = [[
      'Arquivo', 'nNF', 'NumItem', 'cProd', 'cEAN', 'cBarra', 'xProd', 'NCM', 'CEST', 'indEscala', 'CNPJFab',
      'cBenef', 'EXTIPI', 'CFOP', 'uCom', 'qCom', 'vUnCom', 'vProd', 'cEANTrib', 'cBarraTrib', 'uTrib', 'qTrib',
      'vUnTrib', 'vFrete', 'vSeg', 'vDesc', 'vOutro', 'indTot', 'indBemMovelUsado', 'xPed', 'nItemPed', 'nFCI',
      'INFPRODNFF_cProdFisco', 'INFPRODNFF_cOperNFF', 'INFPRODEMB_xEmb', 'INFPRODEMB_qVolEmb', 'INFPRODEMB_uEmb',
      'VEICPROD_tpOp', 'VEICPROD_chassi', 'VEICPROD_cCor', 'VEICPROD_xCor', 'VEICPROD_pot', 'VEICPROD_cilin',
      'VEICPROD_pesoL', 'VEICPROD_pesoB', 'VEICPROD_nSerie', 'VEICPROD_tpComb', 'VEICPROD_nMotor', 'VEICPROD_CMT',
      'VEICPROD_dist', 'VEICPROD_anoMod', 'VEICPROD_anoFab', 'VEICPROD_tpPint', 'VEICPROD_tpVeic', 'VEICPROD_espVeic',
      'VEICPROD_VIN', 'VEICPROD_condVeic', 'VEICPROD_cMod', 'VEICPROD_cCorDENATRAN', 'VEICPROD_lota', 'VEICPROD_tpRest',
      'MED_nLote', 'MED_qLote', 'MED_dFab', 'MED_dVal', 'MED_vPMC', 'MED_cProdANVISA', 'MED_xMotivoIsencao', 'nRECOPI',
      'IMPOSTO_vTotTrib', 'Tipo_ICMS', 'ICMS_orig', 'ICMS_CSOSN', 'ICMS_pCredSN', 'ICMS_vCredICMSSN', 'ICMS_CST',
      'ICMS_vBCSTRet', 'ICMS_vICMSSTRet', 'ICMS_vBCSTDest', 'ICMS_vICMSSTDest', 'ICMS_modBC', 'ICMS_modBCST',
      'ICMS_pRedBC', 'ICMS_cBenefRBC', 'ICMS_vBC', 'ICMS_pICMS', 'ICMS_vICMSOp', 'ICMS_pDif', 'ICMS_vICMSDif',
      'ICMS_vICMS', 'ICMS_vICMSDeson', 'ICMS_motDesICMS', 'ICMS_pMVAST', 'ICMS_pRedBCST', 'ICMS_vBCST',
      'ICMS_pICMSST', 'ICMS_vICMSST', 'ICMS_pBCOp', 'ICMS_UFST', 'ICMS_pFCP', 'ICMS_vFCP', 'ICMS_vBCFCP',
      'ICMS_pFCPST', 'ICMS_vFCPST', 'ICMS_vBCFCPST', 'ICMS_pFCPSTRet', 'ICMS_vFCPSTRet', 'ICMS_vBCFCPSTRet',
      'ICMS_pRedBCEfet', 'ICMS_vBCEfet', 'ICMS_pICMSEfet', 'ICMS_vICMSEfet', 'ICMS_pST', 'ICMS_qBCMono',
      'ICMS_adRemICMS', 'ICMS_vICMSMono', 'ICMS_qBCMonoReten', 'ICMS_adRemICMSReten', 'ICMS_vICMSMonoReten',
      'ICMS_pRedAdRem', 'ICMS_motRedAdRem', 'ICMS_vICMSSTDeson', 'ICMS_indDeduzDeson', 'ICMS_motDesICMSST',
      'ICMS_pFCPDif', 'ICMS_vFCPDif', 'ICMS_vFCPEfet', 'ICMS_vICMSMonoOp', 'ICMS_vICMSMonoDif', 'ICMS_qBCMonoDif',
      'ICMS_adRemICMSDif', 'ICMS_vICMSSubstituto', 'ICMS_qBCMonoRet', 'ICMS_adRemICMSRet', 'ICMS_vICMSMonoRet',
      'IPI_clEnq', 'IPI_CNPJProd', 'IPI_cSelo', 'IPI_qSelo', 'IPI_cEnq', 'IPITRIB_CST', 'IPITRIB_vBC', 'IPITRIB_pIPI',
      'IPITRIB_qUnid', 'IPITRIB_vUnid', 'IPITRIB_vIPI', 'IPINT_CST', 'II_vBC', 'II_vDespAdu', 'II_vII', 'II_vIOF',
      'ISSQN_vBC', 'ISSQN_vAliq', 'ISSQN_vISSQN', 'ISSQN_cMunFG', 'ISSQN_cListServ', 'ISSQN_vDeducao', 'ISSQN_vOutro',
      'ISSQN_vDescIncond', 'ISSQN_vDescCond', 'ISSQN_vISSRet', 'ISSQN_indISS', 'ISSQN_cServico', 'ISSQN_cMun',
      'ISSQN_cPais', 'ISSQN_nProcesso', 'ISSQN_indIncentivo', 'Tipo_PIS', 'PIS_CST', 'PIS_vBC', 'PIS_pPIS', 'PIS_vPIS',
      'PIS_qBCProd', 'PIS_vAliqProd', 'Tipo_COFINS', 'COFINS_CST', 'COFINS_vBC', 'COFINS_pCOFINS', 'COFINS_vCOFINS',
      'COFINS_qBCProd', 'COFINS_vAliqProd', 'ICMSUFDEST_vBCUFDest', 'ICMSUFDEST_vBCFCPUFDest', 'ICMSUFDEST_pFCPUFDest',
      'ICMSUFDEST_pICMSUFDest', 'ICMSUFDEST_pICMSInter', 'ICMSUFDEST_pICMSInterPart', 'ICMSUFDEST_vFCPUFDest',
      'ICMSUFDEST_vICMSUFDest', 'ICMSUFDEST_vICMSUFRemet', 'IS_CSTIS', 'IS_cClassTribIS', 'IS_vBCIS', 'IS_pIS',
      'IS_pISEspec', 'IS_uTrib', 'IS_qTrib', 'IS_vIS', 'IBSCBS_CST', 'IBSCBS_cClassTrib', 'IBSCBS_gIBSCBS_vBC',
      'IBSCBS_gIBSCBS_gIBSUF_pIBSUF', 'IBSCBS_gIBSCBS_gIBSUF_gDif_pDif', 'IBSCBS_gIBSCBS_gIBSUF_gDif_vDif',
      'IBSCBS_gIBSCBS_gIBSUF_gDevTrib_vDevTrib', 'IBSCBS_gIBSCBS_gIBSUF_gRed_pRedAliq', 'IBSCBS_gIBSCBS_gIBSUF_gRed_pAliqEfet',
      'IBSCBS_gIBSCBS_gIBSUF_vIBSUF', 'IBSCBS_gIBSCBS_gIBSMun_pIBSMun', 'IBSCBS_gIBSCBS_gIBSMun_gDif_pDif',
      'IBSCBS_gIBSCBS_gIBSMun_gDif_vDif', 'IBSCBS_gIBSCBS_gIBSMun_gDevTrib_vDevTrib', 'IBSCBS_gIBSCBS_gIBSMun_gRed_pRedAliq',
      'IBSCBS_gIBSCBS_gIBSMun_gRed_pAliqEfet', 'IBSCBS_gIBSCBS_gIBSMun_vIBSMun', 'IBSCBS_gIBSCBS_vIBS',
      'IBSCBS_gIBSCBS_gCBS_pCBS', 'IBSCBS_gIBSCBS_gCBS_gDif_pDif', 'IBSCBS_gIBSCBS_gCBS_gDif_vDif',
      'IBSCBS_gIBSCBS_gCBS_gDevTrib_vDevTrib', 'IBSCBS_gIBSCBS_gCBS_gRed_pRedAliq', 'IBSCBS_gIBSCBS_gCBS_gRed_pAliqEfet',
      'IBSCBS_gIBSCBS_gCBS_vCBS', 'IBSCBS_gIBSCBS_gTribRegular_CSTReg', 'IBSCBS_gIBSCBS_gTribRegular_cClassTribReg',
      'IBSCBS_gIBSCBS_gTribRegular_pAliqEfetRegIBSUF', 'IBSCBS_gIBSCBS_gTribRegular_vTribRegIBSUF',
      'IBSCBS_gIBSCBS_gTribRegular_pAliqEfetRegIBSMun', 'IBSCBS_gIBSCBS_gTribRegular_vTribRegIBSMun',
      'IBSCBS_gIBSCBS_gTribRegular_pAliqEfetRegCBS', 'IBSCBS_gIBSCBS_gTribRegular_vTribRegCBS',
      'IBSCBS_gIBSCBS_gIBSCredPres_cCredPres', 'IBSCBS_gIBSCBS_gIBSCredPres_pCredPres', 'IBSCBS_gIBSCBS_gIBSCredPres_vCredPres',
      'IBSCBS_gIBSCBS_gIBSCredPres_vCredPresCondSus', 'IBSCBS_gIBSCBS_gCBSCredPres_cCredPres', 'IBSCBS_gIBSCBS_gCBSCredPres_pCredPres',
      'IBSCBS_gIBSCBS_gCBSCredPres_vCredPres', 'IBSCBS_gIBSCBS_gCBSCredPres_vCredPresCondSus',
      'IBSCBS_gIBSCBS_gTribCompraGov_pAliqIBSUF', 'IBSCBS_gIBSCBS_gTribCompraGov_vTribIBSUF',
      'IBSCBS_gIBSCBS_gTribCompraGov_pAliqIBSMun', 'IBSCBS_gIBSCBS_gTribCompraGov_vTribIBSMun',
      'IBSCBS_gIBSCBS_gTribCompraGov_pAliqCBS', 'IBSCBS_gIBSCBS_gTribCompraGov_vTribCBS',
      'IBSCBS_gIBSCBSMono_gMonoPadrao_qBCMono', 'IBSCBS_gIBSCBSMono_gMonoPadrao_adRemIBS', 'IBSCBS_gIBSCBSMono_gMonoPadrao_adRemCBS',
      'IBSCBS_gIBSCBSMono_gMonoPadrao_vIBSMono', 'IBSCBS_gIBSCBSMono_gMonoPadrao_vCBSMono', 'IBSCBS_gIBSCBSMono_gMonoReten_qBCMonoReten',
      'IBSCBS_gIBSCBSMono_gMonoReten_adRemIBSReten', 'IBSCBS_gIBSCBSMono_gMonoReten_vIBSMonoReten',
      'IBSCBS_gIBSCBSMono_gMonoReten_adRemCBSReten', 'IBSCBS_gIBSCBSMono_gMonoReten_vCBSMonoReten',
      'IBSCBS_gIBSCBSMono_gMonoRet_qBCMonoRet', 'IBSCBS_gIBSCBSMono_gMonoRet_adRemIBSRet', 'IBSCBS_gIBSCBSMono_gMonoRet_vIBSMonoRet',
      'IBSCBS_gIBSCBSMono_gMonoRet_adRemCBSRet', 'IBSCBS_gIBSCBSMono_gMonoRet_vCBSMonoRet', 'IBSCBS_gIBSCBSMono_gMonoDif_pDifIBS',
      'IBSCBS_gIBSCBSMono_gMonoDif_vIBSMonoDif', 'IBSCBS_gIBSCBSMono_gMonoDif_pDifCBS', 'IBSCBS_gIBSCBSMono_gMonoDif_vCBSMonoDif',
      'IBSCBS_gIBSCBSMono_vTotIBSMonoItem', 'IBSCBS_gIBSCBSMono_vTotCBSMonoItem', 'IBSCBS_gTransfCred_vIBS',
      'IBSCBS_gTransfCred_vCBS', 'IBSCBS_gCredPresIBSZFM_tpCredPresIBSZFM', 'IBSCBS_gCredPresIBSZFM_vCredPresIBSZFM',
      'IMPOSTODEVOL_pDevol', 'IMPOSTODEVOL_vIPIDevol', 'infAdProd', 'OBSITEM_obsCont_xTexto', 'OBSITEM_obsCont_xCampo',
      'OBSITEM_obsFisco_xTexto', 'OBSITEM_obsFisco_xCampo', 'vItem', 'DFeReferenciado_chaveAcesso', 'DFeReferenciado_nItem'
    ]];
    const rowsTotal: (string | number)[][] = [[
      'Arquivo', 'nNF', 'ICMSTOT_vBC', 'ICMSTOT_vICMS', 'ICMSTOT_vICMSDeson', 'ICMSTOT_vFCPUFDest', 'ICMSTOT_vICMSUFDest',
      'ICMSTOT_vICMSUFRemet', 'ICMSTOT_vFCP', 'ICMSTOT_vBCST', 'ICMSTOT_vST', 'ICMSTOT_vFCPST', 'ICMSTOT_vFCPSTRet',
      'ICMSTOT_qBCMono', 'ICMSTOT_vICMSMono', 'ICMSTOT_qBCMonoReten', 'ICMSTOT_vICMSMonoReten', 'ICMSTOT_qBCMonoRet',
      'ICMSTOT_vICMSMonoRet', 'ICMSTOT_vProd', 'ICMSTOT_vFrete', 'ICMSTOT_vSeg', 'ICMSTOT_vDesc', 'ICMSTOT_vII',
      'ICMSTOT_vIPI', 'ICMSTOT_vIPIDevol', 'ICMSTOT_vPIS', 'ICMSTOT_vCOFINS', 'ICMSTOT_vOutro', 'ICMSTOT_vNF',
      'ICMSTOT_vTotTrib', 'ISSQNTOT_vServ', 'ISSQNTOT_vBC', 'ISSQNTOT_vISS', 'ISSQNTOT_vPIS', 'ISSQNTOT_vCOFINS',
      'ISSQNTOT_dCompet', 'ISSQNTOT_vDeducao', 'ISSQNTOT_vOutro', 'ISSQNTOT_vDescIncond', 'ISSQNTOT_vDescCond',
      'ISSQNTOT_vISSRet', 'ISSQNTOT_cRegTrib', 'RETTRIB_vRetPIS', 'RETTRIB_vRetCOFINS', 'RETTRIB_vRetCSLL',
      'RETTRIB_vBCIRRF', 'RETTRIB_vIRRF', 'RETTRIB_vBCRetPrev', 'RETTRIB_vRetPrev', 'ISTot_vIS', 'IBSCBSTot_vBCIBSCBS',
      'IBSCBSTot_gIBS_gIBSUF_vDif', 'IBSCBSTot_gIBS_gIBSUF_vDevTrib', 'IBSCBSTot_gIBS_gIBSUF_vIBSUF',
      'IBSCBSTot_gIBS_gIBSMun_vDif', 'IBSCBSTot_gIBS_gIBSMun_vDevTrib', 'IBSCBSTot_gIBS_gIBSMun_vIBSMun',
      'IBSCBSTot_gIBS_vIBS', 'IBSCBSTot_gIBS_vCredPres', 'IBSCBSTot_gIBS_vCredPresCondSus', 'IBSCBSTot_gCBS_vDif',
      'IBSCBSTot_gCBS_vDevTrib', 'IBSCBSTot_gCBS_vCBS', 'IBSCBSTot_gCBS_vCredPres', 'IBSCBSTot_gCBS_vCredPresCondSus',
      'IBSCBSTot_gMono_vIBSMono', 'IBSCBSTot_gMono_vCBSMono', 'IBSCBSTot_gMono_vIBSMonoReten', 'IBSCBSTot_gMono_vCBSMonoReten',
      'IBSCBSTot_gMono_vIBSMonoRet', 'IBSCBSTot_gMono_vCBSMonoRet', 'vNFTot'
    ]];
    const rowsTransp: (string | number)[][] = [[
      'Arquivo', 'nNF', 'modFrete', 'TRANSPORTA_CNPJ', 'TRANSPORTA_CPF', 'TRANSPORTA_xNome', 'TRANSPORTA_IE',
      'TRANSPORTA_xEnder', 'TRANSPORTA_xMun', 'TRANSPORTA_UF', 'RETTRANSP_vServ', 'RETTRANSP_vBCRet', 'RETTRANSP_pICMSRet',
      'RETTRANSP_vICMSRet', 'RETTRANSP_CFOP', 'RETTRANSP_cMunFG', 'VEICTRANSP_placa', 'VEICTRANSP_UF', 'VEICTRANSP_RNTC',
      'REBOQUE_placa', 'REBOQUE_UF', 'REBOQUE_RNTC', 'vagao', 'balsa', 'VOL_qVol', 'VOL_esp', 'VOL_marca', 'VOL_nVol',
      'VOL_pesoL', 'VOL_pesoB', 'VOL_nLacre'
    ]];
    const rowsPag: (string | number)[][] = [[
      'Arquivo', 'nNF', 'indPag', 'tPag', 'xPag', 'vPag', 'dPag', 'CNPJPag', 'UFPag', 'CARD_tpIntegra', 'CARD_CNPJ',
      'CARD_tBand', 'CARD_cAut', 'CARD_CNPJReceb', 'CARD_idTermPag', 'vTroco'
    ]];
    const rowsInfAdic: (string | number)[][] = [[
      'Arquivo', 'nNF', 'infAdFisco', 'infCpl', 'OBSCONT_xCampo', 'OBSCONT_xTexto', 'OBSFISCO_xCampo', 'OBSFISCO_xTexto',
      'PROCREF_nProc', 'PROCREF_indProc', 'PROCREF_tpAto'
    ]];
    const rowsRespTec: (string | number)[][] = [[
      'Arquivo', 'nNF', 'CNPJ', 'xContato', 'email', 'fone', 'idCSRT', 'hashCSRT'
    ]];
    const rowsSupl: (string | number)[][] = [['Arquivo', 'nNF', 'qrCode', 'urlChave']];
    const rowsAssin: (string | number)[][] = [['Arquivo', 'nNF', 'DigestValue', 'SignatureValue', 'X509Certificate']];
    const rowsProt: (string | number)[][] = [[
      'Arquivo', 'nNF', 'tpAmb', 'verAplic', 'chNFe', 'dhRecbto', 'nProt', 'digVal', 'cStat', 'xMotivo'
    ]];

    // Processa nota a nota numa função separada (em vez de um único forEach
    // síncrono) pra poder rodar em lotes com pausas — um dataset de milhares
    // de notas nesse loop de uma vez só travava a aba inteira (o navegador
    // chegava a marcar a página como "não responde"), e se o usuário fechasse
    // achando que travou, o download nunca saía.
    const processarNota = (nota: XmlData) => {
      const doc = parser.parseFromString(nota.rawXml!, 'text/xml');
      const arquivo = nota.fileName || `${nota.chave || nota.numero}.xml`;
      const nNF = nota.numero || '';
      const ide = first(doc, 'ide');
      const infNFe = doc.getElementsByTagName('infNFe')[0];
      const versao = infNFe?.getAttribute('versao') || '';
      const chave = t(doc, 'chNFe') || (infNFe?.getAttribute('Id') || '').replace('NFe', '');
      const nfRef = ide?.getElementsByTagName('NFref')[0];
      const refNF = nfRef?.getElementsByTagName('refNF')[0];
      const refNFP = nfRef?.getElementsByTagName('refNFP')[0];
      const refECF = nfRef?.getElementsByTagName('refECF')[0];

      rowsIdent.push([
        arquivo, versao, chave, t(ide, 'cUF'), t(ide, 'cNF'), t(ide, 'natOp'), t(ide, 'indPag'), t(ide, 'mod'),
        t(ide, 'serie'), t(ide, 'nNF'), t(ide, 'dhEmi'), t(ide, 'dhSaiEnt'), t(ide, 'hSaiEnt'), t(ide, 'tpNF'),
        t(ide, 'idDest'), t(ide, 'cMunFG'), t(ide, 'tpImp'), t(ide, 'tpEmis'), t(ide, 'cDV'), t(ide, 'tpAmb'),
        t(ide, 'finNFe'), t(ide, 'indFinal'), t(ide, 'indPres'), t(ide, 'indIntermed'), t(ide, 'procEmi'),
        t(ide, 'verProc'), t(ide, 'dhCont'), t(ide, 'xJust'),
        t(nfRef, 'refNFe'), t(refNF, 'cUF'), t(refNF, 'AAMM'), t(refNF, 'CNPJ'), t(refNF, 'mod'), t(refNF, 'serie'), t(refNF, 'nNF'),
        t(refNFP, 'cUF'), t(refNFP, 'AAMM'), t(refNFP, 'CNPJ'), t(refNFP, 'CPF'), t(refNFP, 'IE'), t(refNFP, 'mod'), t(refNFP, 'serie'), t(refNFP, 'nNF'),
        t(nfRef, 'refCTe'), t(refECF, 'mod'), t(refECF, 'nECF'), t(refECF, 'nCOO')
      ]);

      const emit = first(doc, 'emit');
      const enderEmit = emit?.getElementsByTagName('enderEmit')[0];
      rowsEmit.push([
        arquivo, nNF, t(emit, 'CNPJ'), t(emit, 'CPF'), t(emit, 'xNome'), t(emit, 'xFant'),
        t(enderEmit, 'xLgr'), t(enderEmit, 'nro'), t(enderEmit, 'xCpl'), t(enderEmit, 'xBairro'), t(enderEmit, 'cMun'),
        t(enderEmit, 'xMun'), t(enderEmit, 'UF'), t(enderEmit, 'CEP'), t(enderEmit, 'cPais'), t(enderEmit, 'xPais'),
        t(enderEmit, 'fone'), t(emit, 'IE'), t(emit, 'IEST'), t(emit, 'IM'), t(emit, 'CNAE'), t(emit, 'CRT')
      ]);

      const dest = first(doc, 'dest');
      if (dest) {
        const enderDest = dest.getElementsByTagName('enderDest')[0];
        rowsDest.push([
          arquivo, nNF, t(dest, 'CNPJ'), t(dest, 'CPF'), t(dest, 'idEstrangeiro'), t(dest, 'xNome'),
          t(enderDest, 'xLgr'), t(enderDest, 'nro'), t(enderDest, 'xCpl'), t(enderDest, 'xBairro'), t(enderDest, 'cMun'),
          t(enderDest, 'xMun'), t(enderDest, 'UF'), t(enderDest, 'CEP'), t(enderDest, 'cPais'), t(enderDest, 'xPais'),
          t(enderDest, 'fone'), t(dest, 'indIEDest'), t(dest, 'IE'), t(dest, 'ISUF'), t(dest, 'IM'), t(dest, 'email')
        ]);
      }

      Array.from(doc.getElementsByTagName('det')).forEach(det => {
        const prod = det.getElementsByTagName('prod')[0];
        const imposto = det.getElementsByTagName('imposto')[0];
        const infProdNFF = prod?.getElementsByTagName('NFFProd')[0];
        const infProdEmb = prod?.getElementsByTagName('gEmb')[0];
        const veicProd = prod?.getElementsByTagName('veicProd')[0];
        const med = prod?.getElementsByTagName('med')[0];
        const icms = imposto?.getElementsByTagName('ICMS')[0];
        const ipi = imposto?.getElementsByTagName('IPI')[0];
        const ipiTrib = ipi?.getElementsByTagName('IPITrib')[0];
        const ipiNT = ipi?.getElementsByTagName('IPINT')[0];
        const ii = imposto?.getElementsByTagName('II')[0];
        const issqn = imposto?.getElementsByTagName('ISSQN')[0];
        const pis = imposto?.getElementsByTagName('PIS')[0];
        const cofins = imposto?.getElementsByTagName('COFINS')[0];
        const icmsUFDest = imposto?.getElementsByTagName('ICMSUFDest')[0];
        const isBlock = imposto?.getElementsByTagName('IS')[0];
        const ibscbs = imposto?.getElementsByTagName('IBSCBS')[0];
        const gIbsCbs = ibscbs?.getElementsByTagName('gIBSCBS')[0];
        const gIbsUF = gIbsCbs?.getElementsByTagName('gIBSUF')[0];
        const gIbsMun = gIbsCbs?.getElementsByTagName('gIBSMun')[0];
        const gCBS = gIbsCbs?.getElementsByTagName('gCBS')[0];
        const gTribRegular = gIbsCbs?.getElementsByTagName('gTribRegular')[0];
        const gIBSCredPres = gIbsCbs?.getElementsByTagName('gIBSCredPres')[0];
        const gCBSCredPres = gIbsCbs?.getElementsByTagName('gCBSCredPres')[0];
        const gTribCompraGov = gIbsCbs?.getElementsByTagName('gTribCompraGov')[0];
        const gIbsCbsMono = ibscbs?.getElementsByTagName('gIBSCBSMono')[0];
        const gMonoPadrao = gIbsCbsMono?.getElementsByTagName('gMonoPadrao')[0];
        const gMonoReten = gIbsCbsMono?.getElementsByTagName('gMonoReten')[0];
        const gMonoRet = gIbsCbsMono?.getElementsByTagName('gMonoRet')[0];
        const gMonoDif = gIbsCbsMono?.getElementsByTagName('gMonoDif')[0];
        const gTransfCred = ibscbs?.getElementsByTagName('gTransfCred')[0];
        const gCredPresIBSZFM = ibscbs?.getElementsByTagName('gCredPresIBSZFM')[0];
        const impostoDevol = det.getElementsByTagName('impostoDevol')[0];
        const obsItem = det.getElementsByTagName('obsItem')[0];
        const obsCont = obsItem?.getElementsByTagName('obsCont')[0];
        const obsFisco = obsItem?.getElementsByTagName('obsFisco')[0];
        const dfeRef = det.getElementsByTagName('DFeReferenciado')[0];
        // Whichever ICMS/PIS/COFINS variant tag is populated (ICMS00, ICMS60, PISAliq, etc.) —
        // field names (CST/CSOSN/vBC/pICMS...) are consistent across variants of the same group.
        const icmsVariant = icms ? Array.from(icms.children).find(c => /^ICMS/.test(c.tagName)) : undefined;
        const icmsScope = icmsVariant || icms;
        const pisVariant = pis ? Array.from(pis.children).find(c => /^PIS/.test(c.tagName)) : undefined;
        const pisScope = pisVariant || pis;
        const cofinsVariant = cofins ? Array.from(cofins.children).find(c => /^COFINS/.test(c.tagName)) : undefined;
        const cofinsScope = cofinsVariant || cofins;
        const tipoIcms = icmsVariant?.tagName || '';
        const tipoPis = pisVariant?.tagName || '';
        const tipoCofins = cofinsVariant?.tagName || '';

        rowsItens.push([
          arquivo, nNF, t(det, 'nItem') || (det.getAttribute('nItem') || ''), t(prod, 'cProd'), t(prod, 'cEAN'),
          t(prod, 'cBarra'), t(prod, 'xProd'), t(prod, 'NCM'), t(prod, 'CEST'), t(prod, 'indEscala'), t(prod, 'CNPJFab'),
          t(prod, 'cBenef'), t(prod, 'EXTIPI'), t(prod, 'CFOP'), t(prod, 'uCom'), n(prod, 'qCom'), n(prod, 'vUnCom'),
          n(prod, 'vProd'), t(prod, 'cEANTrib'), t(prod, 'cBarraTrib'), t(prod, 'uTrib'), n(prod, 'qTrib'), n(prod, 'vUnTrib'),
          n(prod, 'vFrete'), n(prod, 'vSeg'), n(prod, 'vDesc'), n(prod, 'vOutro'), t(prod, 'indTot'), t(prod, 'indBemMovelUsado'),
          t(prod, 'xPed'), t(prod, 'nItemPed'), t(prod, 'nFCI'),
          t(infProdNFF, 'cProdFisco'), t(infProdNFF, 'cOperNFF'),
          t(infProdEmb, 'xEmb'), n(infProdEmb, 'qVolEmb'), t(infProdEmb, 'uEmb'),
          t(veicProd, 'tpOp'), t(veicProd, 'chassi'), t(veicProd, 'cCor'), t(veicProd, 'xCor'), t(veicProd, 'pot'),
          t(veicProd, 'cilin'), t(veicProd, 'pesoL'), t(veicProd, 'pesoB'), t(veicProd, 'nSerie'), t(veicProd, 'tpComb'),
          t(veicProd, 'nMotor'), t(veicProd, 'CMT'), t(veicProd, 'dist'), t(veicProd, 'anoMod'), t(veicProd, 'anoFab'),
          t(veicProd, 'tpPint'), t(veicProd, 'tpVeic'), t(veicProd, 'espVeic'), t(veicProd, 'VIN'), t(veicProd, 'condVeic'),
          t(veicProd, 'cMod'), t(veicProd, 'cCorDENATRAN'), t(veicProd, 'lota'), t(veicProd, 'tpRest'),
          t(med, 'nLote'), n(med, 'qLote'), t(med, 'dFab'), t(med, 'dVal'), n(med, 'vPMC'), t(med, 'cProdANVISA'), t(med, 'xMotivoIsencao'),
          t(prod, 'nRECOPI'),
          n(imposto, 'vTotTrib'), tipoIcms, t(icmsScope, 'orig'), t(icmsScope, 'CSOSN'), n(icmsScope, 'pCredSN'), n(icmsScope, 'vCredICMSSN'),
          t(icmsScope, 'CST'), n(icmsScope, 'vBCSTRet'), n(icmsScope, 'vICMSSTRet'), n(icmsScope, 'vBCSTDest'), n(icmsScope, 'vICMSSTDest'),
          t(icmsScope, 'modBC'), t(icmsScope, 'modBCST'), n(icmsScope, 'pRedBC'), t(icmsScope, 'cBenefRBC'), n(icmsScope, 'vBC'),
          n(icmsScope, 'pICMS'), n(icmsScope, 'vICMSOp'), n(icmsScope, 'pDif'), n(icmsScope, 'vICMSDif'), n(icmsScope, 'vICMS'),
          n(icmsScope, 'vICMSDeson'), t(icmsScope, 'motDesICMS'), n(icmsScope, 'pMVAST'), n(icmsScope, 'pRedBCST'), n(icmsScope, 'vBCST'),
          n(icmsScope, 'pICMSST'), n(icmsScope, 'vICMSST'), n(icmsScope, 'pBCOp'), t(icmsScope, 'UFST'), n(icmsScope, 'pFCP'),
          n(icmsScope, 'vFCP'), n(icmsScope, 'vBCFCP'), n(icmsScope, 'pFCPST'), n(icmsScope, 'vFCPST'), n(icmsScope, 'vBCFCPST'),
          n(icmsScope, 'pFCPSTRet'), n(icmsScope, 'vFCPSTRet'), n(icmsScope, 'vBCFCPSTRet'), n(icmsScope, 'pRedBCEfet'),
          n(icmsScope, 'vBCEfet'), n(icmsScope, 'pICMSEfet'), n(icmsScope, 'vICMSEfet'), n(icmsScope, 'pST'), n(icmsScope, 'qBCMono'),
          n(icmsScope, 'adRemICMS'), n(icmsScope, 'vICMSMono'), n(icmsScope, 'qBCMonoReten'), n(icmsScope, 'adRemICMSReten'),
          n(icmsScope, 'vICMSMonoReten'), n(icmsScope, 'pRedAdRem'), t(icmsScope, 'motRedAdRem'), n(icmsScope, 'vICMSSTDeson'),
          t(icmsScope, 'indDeduzDeson'), t(icmsScope, 'motDesICMSST'), n(icmsScope, 'pFCPDif'), n(icmsScope, 'vFCPDif'),
          n(icmsScope, 'vFCPEfet'), n(icmsScope, 'vICMSMonoOp'), n(icmsScope, 'vICMSMonoDif'), n(icmsScope, 'qBCMonoDif'),
          n(icmsScope, 'adRemICMSDif'), n(icmsScope, 'vICMSSubstituto'), n(icmsScope, 'qBCMonoRet'), n(icmsScope, 'adRemICMSRet'),
          n(icmsScope, 'vICMSMonoRet'),
          t(ipi, 'clEnq'), t(ipi, 'CNPJProd'), t(ipi, 'cSelo'), t(ipi, 'qSelo'), t(ipi, 'cEnq'),
          t(ipiTrib, 'CST'), n(ipiTrib, 'vBC'), n(ipiTrib, 'pIPI'), n(ipiTrib, 'qUnid'), n(ipiTrib, 'vUnid'), n(ipiTrib, 'vIPI'),
          t(ipiNT, 'CST'),
          n(ii, 'vBC'), n(ii, 'vDespAdu'), n(ii, 'vII'), n(ii, 'vIOF'),
          n(issqn, 'vBC'), n(issqn, 'vAliq'), n(issqn, 'vISSQN'), t(issqn, 'cMunFG'), t(issqn, 'cListServ'), n(issqn, 'vDeducao'),
          n(issqn, 'vOutro'), n(issqn, 'vDescIncond'), n(issqn, 'vDescCond'), n(issqn, 'vISSRet'), t(issqn, 'indISS'),
          t(issqn, 'cServico'), t(issqn, 'cMun'), t(issqn, 'cPais'), t(issqn, 'nProcesso'), t(issqn, 'indIncentivo'),
          tipoPis, t(pisScope, 'CST'), n(pisScope, 'vBC'), n(pisScope, 'pPIS'), n(pisScope, 'vPIS'), n(pisScope, 'qBCProd'), n(pisScope, 'vAliqProd'),
          tipoCofins, t(cofinsScope, 'CST'), n(cofinsScope, 'vBC'), n(cofinsScope, 'pCOFINS'), n(cofinsScope, 'vCOFINS'), n(cofinsScope, 'qBCProd'), n(cofinsScope, 'vAliqProd'),
          n(icmsUFDest, 'vBCUFDest'), n(icmsUFDest, 'vBCFCPUFDest'), n(icmsUFDest, 'pFCPUFDest'), n(icmsUFDest, 'pICMSUFDest'),
          n(icmsUFDest, 'pICMSInter'), n(icmsUFDest, 'pICMSInterPart'), n(icmsUFDest, 'vFCPUFDest'), n(icmsUFDest, 'vICMSUFDest'), n(icmsUFDest, 'vICMSUFRemet'),
          t(isBlock, 'CST'), t(isBlock, 'cClassTrib'), n(isBlock, 'vBC'), n(isBlock, 'pIS'), n(isBlock, 'pISEspec'), t(isBlock, 'uTrib'), n(isBlock, 'qTrib'), n(isBlock, 'vIS'),
          t(ibscbs, 'CST'), t(ibscbs, 'cClassTrib'), n(gIbsCbs, 'vBC'),
          n(gIbsUF, 'pIBSUF'), n(gIbsUF, 'pDif'), n(gIbsUF, 'vDif'), n(gIbsUF, 'vDevTrib'), n(gIbsUF, 'pRedAliq'), n(gIbsUF, 'pAliqEfet'), n(gIbsUF, 'vIBSUF'),
          n(gIbsMun, 'pIBSMun'), n(gIbsMun, 'pDif'), n(gIbsMun, 'vDif'), n(gIbsMun, 'vDevTrib'), n(gIbsMun, 'pRedAliq'), n(gIbsMun, 'pAliqEfet'), n(gIbsMun, 'vIBSMun'),
          n(gIbsCbs, 'vIBS'),
          n(gCBS, 'pCBS'), n(gCBS, 'pDif'), n(gCBS, 'vDif'), n(gCBS, 'vDevTrib'), n(gCBS, 'pRedAliq'), n(gCBS, 'pAliqEfet'), n(gCBS, 'vCBS'),
          t(gTribRegular, 'CSTReg'), t(gTribRegular, 'cClassTribReg'), n(gTribRegular, 'pAliqEfetRegIBSUF'), n(gTribRegular, 'vTribRegIBSUF'),
          n(gTribRegular, 'pAliqEfetRegIBSMun'), n(gTribRegular, 'vTribRegIBSMun'), n(gTribRegular, 'pAliqEfetRegCBS'), n(gTribRegular, 'vTribRegCBS'),
          t(gIBSCredPres, 'cCredPres'), n(gIBSCredPres, 'pCredPres'), n(gIBSCredPres, 'vCredPres'), n(gIBSCredPres, 'vCredPresCondSus'),
          t(gCBSCredPres, 'cCredPres'), n(gCBSCredPres, 'pCredPres'), n(gCBSCredPres, 'vCredPres'), n(gCBSCredPres, 'vCredPresCondSus'),
          n(gTribCompraGov, 'pAliqIBSUF'), n(gTribCompraGov, 'vTribIBSUF'), n(gTribCompraGov, 'pAliqIBSMun'), n(gTribCompraGov, 'vTribIBSMun'),
          n(gTribCompraGov, 'pAliqCBS'), n(gTribCompraGov, 'vTribCBS'),
          n(gMonoPadrao, 'qBCMono'), n(gMonoPadrao, 'adRemIBS'), n(gMonoPadrao, 'adRemCBS'), n(gMonoPadrao, 'vIBSMono'), n(gMonoPadrao, 'vCBSMono'),
          n(gMonoReten, 'qBCMonoReten'), n(gMonoReten, 'adRemIBSReten'), n(gMonoReten, 'vIBSMonoReten'), n(gMonoReten, 'adRemCBSReten'), n(gMonoReten, 'vCBSMonoReten'),
          n(gMonoRet, 'qBCMonoRet'), n(gMonoRet, 'adRemIBSRet'), n(gMonoRet, 'vIBSMonoRet'), n(gMonoRet, 'adRemCBSRet'), n(gMonoRet, 'vCBSMonoRet'),
          n(gMonoDif, 'pDifIBS'), n(gMonoDif, 'vIBSMonoDif'), n(gMonoDif, 'pDifCBS'), n(gMonoDif, 'vCBSMonoDif'),
          n(gIbsCbsMono, 'vTotIBSMonoItem'), n(gIbsCbsMono, 'vTotCBSMonoItem'),
          n(gTransfCred, 'vIBS'), n(gTransfCred, 'vCBS'), t(gCredPresIBSZFM, 'tpCredPresIBSZFM'), n(gCredPresIBSZFM, 'vCredPresIBSZFM'),
          n(impostoDevol, 'pDevol'), n(impostoDevol, 'vIPIDevol'),
          t(det, 'infAdProd'), t(obsCont, 'xTexto'), obsCont?.getAttribute('xCampo') || '', t(obsFisco, 'xTexto'), obsFisco?.getAttribute('xCampo') || '',
          n(det, 'vItem'), t(dfeRef, 'chNFe'), t(dfeRef, 'nItem')
        ]);
      });

      const total = first(doc, 'total');
      const icmsTot = total?.getElementsByTagName('ICMSTot')[0];
      const issqnTot = total?.getElementsByTagName('ISSQNtot')[0];
      const retTrib = total?.getElementsByTagName('retTrib')[0];
      const isTot = total?.getElementsByTagName('ISTot')[0];
      const ibscbsTot = total?.getElementsByTagName('IBSCBSTot')[0];
      const gIbsTot = ibscbsTot?.getElementsByTagName('gIBS')[0];
      const gIbsUFTot = gIbsTot?.getElementsByTagName('gIBSUF')[0];
      const gIbsMunTot = gIbsTot?.getElementsByTagName('gIBSMun')[0];
      const gCBSTot = ibscbsTot?.getElementsByTagName('gCBS')[0];
      const gMonoTot = ibscbsTot?.getElementsByTagName('gMono')[0];

      rowsTotal.push([
        arquivo, nNF, n(icmsTot, 'vBC'), n(icmsTot, 'vICMS'), n(icmsTot, 'vICMSDeson'), n(icmsTot, 'vFCPUFDest'),
        n(icmsTot, 'vICMSUFDest'), n(icmsTot, 'vICMSUFRemet'), n(icmsTot, 'vFCP'), n(icmsTot, 'vBCST'), n(icmsTot, 'vST'),
        n(icmsTot, 'vFCPST'), n(icmsTot, 'vFCPSTRet'), n(icmsTot, 'qBCMono'), n(icmsTot, 'vICMSMono'), n(icmsTot, 'qBCMonoReten'),
        n(icmsTot, 'vICMSMonoReten'), n(icmsTot, 'qBCMonoRet'), n(icmsTot, 'vICMSMonoRet'), n(icmsTot, 'vProd'), n(icmsTot, 'vFrete'),
        n(icmsTot, 'vSeg'), n(icmsTot, 'vDesc'), n(icmsTot, 'vII'), n(icmsTot, 'vIPI'), n(icmsTot, 'vIPIDevol'), n(icmsTot, 'vPIS'),
        n(icmsTot, 'vCOFINS'), n(icmsTot, 'vOutro'), n(icmsTot, 'vNF'), n(icmsTot, 'vTotTrib'),
        n(issqnTot, 'vServ'), n(issqnTot, 'vBC'), n(issqnTot, 'vISS'), n(issqnTot, 'vPIS'), n(issqnTot, 'vCOFINS'), t(issqnTot, 'dCompet'),
        n(issqnTot, 'vDeducao'), n(issqnTot, 'vOutro'), n(issqnTot, 'vDescIncond'), n(issqnTot, 'vDescCond'), n(issqnTot, 'vISSRet'), t(issqnTot, 'cRegTrib'),
        n(retTrib, 'vRetPIS'), n(retTrib, 'vRetCOFINS'), n(retTrib, 'vRetCSLL'), n(retTrib, 'vBCIRRF'), n(retTrib, 'vIRRF'),
        n(retTrib, 'vBCRetPrev'), n(retTrib, 'vRetPrev'),
        n(isTot, 'vIS'), n(ibscbsTot, 'vBCIBSCBS'),
        n(gIbsUFTot, 'vDif'), n(gIbsUFTot, 'vDevTrib'), n(gIbsUFTot, 'vIBSUF'),
        n(gIbsMunTot, 'vDif'), n(gIbsMunTot, 'vDevTrib'), n(gIbsMunTot, 'vIBSMun'),
        n(gIbsTot, 'vIBS'), n(gIbsTot, 'vCredPres'), n(gIbsTot, 'vCredPresCondSus'),
        n(gCBSTot, 'vDif'), n(gCBSTot, 'vDevTrib'), n(gCBSTot, 'vCBS'), n(gCBSTot, 'vCredPres'), n(gCBSTot, 'vCredPresCondSus'),
        n(gMonoTot, 'vIBSMono'), n(gMonoTot, 'vCBSMono'), n(gMonoTot, 'vIBSMonoReten'), n(gMonoTot, 'vCBSMonoReten'),
        n(gMonoTot, 'vIBSMonoRet'), n(gMonoTot, 'vCBSMonoRet'),
        n(total, 'vNF')
      ]);

      const transp = first(doc, 'transp');
      if (transp) {
        const transporta = transp.getElementsByTagName('transporta')[0];
        const retTransp = transp.getElementsByTagName('retTransp')[0];
        const veicTransp = transp.getElementsByTagName('veicTransp')[0];
        const reboque = transp.getElementsByTagName('reboque')[0];
        const vol = transp.getElementsByTagName('vol')[0];
        rowsTransp.push([
          arquivo, nNF, t(transp, 'modFrete'), t(transporta, 'CNPJ'), t(transporta, 'CPF'), t(transporta, 'xNome'),
          t(transporta, 'IE'), t(transporta, 'xEnder'), t(transporta, 'xMun'), t(transporta, 'UF'),
          n(retTransp, 'vServ'), n(retTransp, 'vBCRet'), n(retTransp, 'pICMSRet'), n(retTransp, 'vICMSRet'), t(retTransp, 'CFOP'), t(retTransp, 'cMunFG'),
          t(veicTransp, 'placa'), t(veicTransp, 'UF'), t(veicTransp, 'RNTC'),
          t(reboque, 'placa'), t(reboque, 'UF'), t(reboque, 'RNTC'),
          t(transp, 'vagao'), t(transp, 'balsa'),
          n(vol, 'qVol'), t(vol, 'esp'), t(vol, 'marca'), t(vol, 'nVol'), n(vol, 'pesoL'), n(vol, 'pesoB'), t(vol, 'nLacre')
        ]);
      }

      Array.from(doc.getElementsByTagName('detPag')).forEach(detPag => {
        const card = detPag.getElementsByTagName('card')[0];
        rowsPag.push([
          arquivo, nNF, t(ide, 'indPag'), t(detPag, 'tPag'), t(detPag, 'xPag'), n(detPag, 'vPag'), t(detPag, 'dPag'),
          t(detPag, 'CNPJPag'), t(detPag, 'UFPag'), t(card, 'tpIntegra'), t(card, 'CNPJ'), t(card, 'tBand'), t(card, 'cAut'),
          t(card, 'CNPJReceb'), t(card, 'idTermPag'), n(doc.getElementsByTagName('pag')[0], 'vTroco')
        ]);
      });

      const infAdic = first(doc, 'infAdic');
      if (infAdic) {
        const obsCont = infAdic.getElementsByTagName('obsCont')[0];
        const obsFisco = infAdic.getElementsByTagName('obsFisco')[0];
        const procRef = infAdic.getElementsByTagName('procRef')[0];
        rowsInfAdic.push([
          arquivo, nNF, t(infAdic, 'infAdFisco'), t(infAdic, 'infCpl'),
          obsCont?.getAttribute('xCampo') || '', t(obsCont, 'xTexto'),
          obsFisco?.getAttribute('xCampo') || '', t(obsFisco, 'xTexto'),
          t(procRef, 'nProc'), t(procRef, 'indProc'), t(procRef, 'tpAto')
        ]);
      }

      const respTec = first(doc, 'infRespTec');
      if (respTec) {
        rowsRespTec.push([
          arquivo, nNF, t(respTec, 'CNPJ'), t(respTec, 'xContato'), t(respTec, 'email'), t(respTec, 'fone'),
          t(respTec, 'idCSRT'), t(respTec, 'hashCSRT')
        ]);
      }

      const supl = first(doc, 'infNFeSupl');
      if (supl) {
        rowsSupl.push([arquivo, nNF, t(supl, 'qrCode'), t(supl, 'urlChave')]);
      }

      const signature = doc.getElementsByTagName('Signature')[0];
      if (signature) {
        rowsAssin.push([
          arquivo, nNF, t(signature, 'DigestValue'), t(signature, 'SignatureValue'), t(signature, 'X509Certificate')
        ]);
      }

      const protNFe = doc.getElementsByTagName('protNFe')[0];
      const infProt = protNFe?.getElementsByTagName('infProt')[0];
      if (infProt) {
        rowsProt.push([
          arquivo, nNF, t(infProt, 'tpAmb'), t(infProt, 'verAplic'), t(infProt, 'chNFe'), t(infProt, 'dhRecbto'),
          t(infProt, 'nProt'), t(infProt, 'digVal'), t(infProt, 'cStat'), t(infProt, 'xMotivo')
        ]);
      }
    };

    try {
      // Lotes de 300 notas com uma pausa (setTimeout 0) entre cada um — dá
      // tempo do navegador processar a fila de eventos (repintar a tela,
      // responder ao usuário) em vez de travar tudo num bloco só. O mesmo
      // padrão já usado na extração de RAR/ZIP aninhado deste app.
      const LOTE = 300;
      for (let i = 0; i < notas.length; i += LOTE) {
        notas.slice(i, i + LOTE).forEach(processarNota);
        setExportProgress({ atual: Math.min(i + LOTE, notas.length), total: notas.length, etapa: 'Lendo XMLs' });
        await new Promise(r => setTimeout(r, 0));
      }

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Montando planilha' });
      await new Promise(r => setTimeout(r, 0));

      const wb = XLSX.utils.book_new();
      const addSheet = (aoa: (string | number)[][], name: string) => {
        if (aoa.length <= 1) return;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = aoa[0].map(h => ({ wch: Math.min(30, Math.max(10, String(h).length + 2)) }));
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      addSheet(rowsIdent, 'Identificação NCFE');
      addSheet(rowsEmit, 'Emitente');
      addSheet(rowsDest, 'Destinatário');
      addSheet(rowsItens, 'Itens');
      addSheet(rowsTotal, 'Total');
      addSheet(rowsTransp, 'Transportadora');
      addSheet(rowsPag, 'Pagamento');
      addSheet(rowsInfAdic, 'Inf. Adicional');
      addSheet(rowsRespTec, 'Resp. Tecnico');
      addSheet(rowsSupl, 'Suplementares NF');
      addSheet(rowsAssin, 'Assinatura');
      addSheet(rowsProt, 'Protocolo');

      setExportProgress({ atual: notas.length, total: notas.length, etapa: 'Gerando arquivo' });
      await new Promise(r => setTimeout(r, 0));

      // Blob + link manual em vez de XLSX.writeFile: dá pra capturar erro
      // (ex: estouro de memória em planilha muito grande) e confirmar de
      // verdade que o arquivo foi montado antes de acionar o download.
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = nomeArquivoExport('planilha_completa_xml', 'xlsx');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error('Erro ao exportar planilha completa:', err);
      alert('Não foi possível gerar a planilha completa. Isso costuma acontecer quando o período selecionado tem notas demais pro navegador processar de uma vez — tente filtrar por um mês específico e exportar de novo.');
    } finally {
      setExportProgress(null);
    }
  };

  const [wasmBinary, setWasmBinary] = useState<ArrayBuffer | null>(null);
  const [extractionStatus, setExtractionStatus] = useState<string | null>(null);
  const [extractionErrors, setExtractionErrors] = useState<ExtractionErrorEntry[]>([]);

  const loadWasm = async () => {
    if (wasmBinary) return wasmBinary;
    const sources = [
      unrarWasmUrl,
      'https://unpkg.com/node-unrar-js@2.0.2/dist/js/unrar.wasm'
    ];
    
    for (const url of sources) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength < 10000) continue; // Muito pequeno para ser o WASM
        setWasmBinary(arrayBuffer);
        return arrayBuffer;
      } catch (err) {
        console.error(`Erro ao carregar motor RAR de ${url}:`, err);
      }
    }
    return null;
  };

  useEffect(() => {
    loadWasm();
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Helper to traverse file tree (DataTransferItem)
  const traverseFileTree = async (item: FileSystemEntry, path?: string): Promise<File[]> => {
    return new Promise((resolve) => {
      const files: File[] = [];
      if (item.isFile) {
        (item as FileSystemFileEntry).file((file) => {
          resolve([file]);
        });
      } else if (item.isDirectory) {
        const dirReader = (item as FileSystemDirectoryEntry).createReader();
        const readEntries = () => {
          dirReader.readEntries(async (entries) => {
            if (entries.length > 0) {
              for (const entry of entries) {
                const innerFiles = await traverseFileTree(entry, (path || '') + item.name + '/');
                files.push(...innerFiles);
              }
              readEntries();
            } else {
              resolve(files);
            }
          });
        };
        readEntries();
      } else {
        resolve([]);
      }
    });
  };

  // Descompacta e faz o parse de um ZIP de nível superior num Web Worker, pra não
  // travar a aba em lotes grandes — o próprio worker já filtra arquivo não-fiscal
  // grande e devolve RAR/tipo desconhecido (aninhado ou não) em pendingArchives,
  // que quem chamou processa com o processArchiveRecursively de sempre (sem
  // libarchive.js dentro do worker, que precisa de document/window).
  const runZipInWorker = (archiveData: ArrayBuffer, containerName: string): Promise<import('./fileWorker').WorkerResponse> => {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./fileWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        worker.terminate();
        resolve(e.data);
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ archiveData, containerName }, [archiveData]);
    });
  };

  const handleFiles = async (files: FileList | File[]) => {
    setIsProcessing(true);
    setIsConfirmed(false);
    
    const fileArray = Array.from(files);
    
    // Convert current sources back to a Map for easier updates
    const sourceMap = new Map<string, SourceMetadata>();
    attachedSources.forEach(s => sourceMap.set(s.name, s));

    const updatedProcessedNames = new Set(processedFileNames);

    let finalXmls: XmlData[] = [];
    let finalInuts: XmlData[] = [];
    let finalOthers: XmlData[] = [];
    let finalNfse: XmlData[] = [];
    const foundSpeds: SpedData[] = [];
    // Acumulador local (não o state React) — setExtractionErrors é assíncrono,
    // então ler o state extractionErrors mais adiante NESTA MESMA execução
    // pegaria o valor antigo (stale closure). Esse array local reflete tudo
    // que essa importação específica encontrou, na hora.
    const extractionErrorsLocal: ExtractionErrorEntry[] = [];
    const registrarExtractionError = (msg: string, download?: { data: Uint8Array; fileName: string }) => {
      let downloadUrl: string | undefined;
      if (download) {
        try {
          downloadUrl = URL.createObjectURL(new Blob([download.data], { type: 'application/octet-stream' }));
        } catch {}
      }
      const entry: ExtractionErrorEntry = { msg, downloadUrl, downloadName: download?.fileName };
      extractionErrorsLocal.push(entry);
      setExtractionErrors(prev => [...prev, entry]);
    };

        const checkMagicBytes = (buffer: ArrayBuffer | Uint8Array) => {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
      if (bytes.length >= 6 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1A && bytes[5] === 0x07) return 'rar';
      return 'unknown';
    };


    
    
    
    
    
    // Tanto o libarchive.js (window.Archive, um singleton global carregado uma
    // vez) quanto o node-unrar-js (módulo WASM único por aba, também um
    // singleton) NÃO suportam duas extrações de RAR acontecendo ao mesmo tempo
    // (intercaladas via await, quando dois arquivos de topo são processados
    // juntos via Promise.all mais abaixo). Confirmado com dados reais: rodar
    // dois RARs concorrentemente corrompe a extração de forma determinística
    // (sempre o mesmo "Archive header or data are damaged"); em sequência
    // nunca falha. Essa fila garante que só UMA extração de RAR/desconhecido
    // (libarchive OU node-unrar-js, o bloco inteiro) fica ativa no app inteiro
    // a qualquer momento — as outras esperam a vez em vez de rodar junto.
    let unrarFila: Promise<void> = Promise.resolve();
    const adquirirFilaUnrar = async (): Promise<() => void> => {
      let liberar!: () => void;
      const minhaVez = new Promise<void>(resolve => { liberar = resolve; });
      const esperar = unrarFila;
      unrarFila = minhaVez;
      await esperar;
      return liberar;
    };

    const processArchiveRecursively = async (archiveData: ArrayBuffer | Uint8Array, results: any, containerName: string, archivePath: string = '', jaTemFilaUnrar: boolean = false) => {
      const type = checkMagicBytes(archiveData);
      const currentPath = archivePath ? `${archivePath}/${containerName}` : containerName;
      
      if (type === 'rar') setExtractionStatus(`Extraindo RAR5: ${containerName}...`);

      const ensureSourceInMap = (name: string, isArchive: boolean) => {
        if (!sourceMap.has(name)) {
          sourceMap.set(name, {
            name: name,
            isZip: isArchive,
            totalXmls: 0,
            saidaCount: 0,
            entradaCount: 0
          });
        }
      };

      if (type === 'zip') {
        try {
          const zip = await JSZip.loadAsync(archiveData);
          let entradasProcessadas = 0;
          for (const name of Object.keys(zip.files)) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            const uniqueName = `${currentPath}::${name}`;
            const baseName = name.split('/').pop() || name;

            // Um ZIP aninhado com milhares de XML processa tudo em sequência
            // rápida demais pro coletor de lixo do navegador conseguir agir —
            // o lixo de arquivos já descartados fica acumulado esperando ser
            // varrido, em vez de ser liberado de verdade a tempo. Uma pausa
            // periódica (a cada 500 arquivos) dá esse respiro de verdade pro
            // navegador, sem precisar quebrar o ZIP em pedaços menores.
            entradasProcessadas++;
            if (entradasProcessadas % 500 === 0) {
              await new Promise(r => setTimeout(r, 0));
            }

            if (!name.toLowerCase().endsWith('.zip') && !name.toLowerCase().endsWith('.rar')) {
              if (updatedProcessedNames.has(uniqueName)) continue;
              if (isProvavelmenteNaoFiscal(baseName, (entry as any)._data?.uncompressedSize)) { results.localNonXmlCount++; continue; }
              try {
                const xmlText = await entry.async('text');
                if (xmlText.trimStart().startsWith('|0000|')) {
                  const sped = parseSped(xmlText, baseName);
                  if (sped) results.localSpeds.push(sped);
                  continue;
                }
                const looksLikeXml = xmlText.trim().startsWith('<');
                if (looksLikeXml || /^[0-9]{44}$/.test(baseName) || name.toLowerCase().endsWith('.xml')) {
                  const data = parseXML(xmlText, name);
                  if (data.tipo !== 'outro') {
                    updatedProcessedNames.add(uniqueName);
                    // Ensure the ZIP or the specific folder inside it is in the source map
                    const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                    ensureSourceInMap(displaySource, true);
                    
                    results.localTotalCount++;
                    data.sourceName = displaySource;
                    if (data.isCancelamento) results.localCancellations++;
                    if (data.tipo === 'inutilizacao') {
                      results.localInuts.push(data); results.localInutsCount++;
                    } else if (data.tipo === 'nfe' || data.tipo === 'evento') {
                      results.localXmls.push(data);
                      if (data.tipo === 'nfe') results.localValidNfCount++;
                    } else if (data.tipo === 'nfse' || data.tipo === 'nfse_evento') {
                      results.localNfse.push(data);
                    } else {
                      results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                    }
                  } else { results.localNonXmlCount++; }
                } else { results.localNonXmlCount++; }
              } catch (e) { results.localNonXmlCount++; }
            } else {
              const innerArchiveName = baseName;
              const innerArchiveData = await entry.async('uint8array');
              // Se esse arquivo aninhado não render nenhuma nota, avisa — sem
              // isso, uma falha silenciosa (ex: nota de saída perdida) some
              // sem deixar rastro, e o app só mostra o resultado incompleto
              // (ex: parece que a análise é de "várias empresas" porque só
              // sobrou entrada de fornecedores diferentes).
              const antesCount = results.localTotalCount;
              await processArchiveRecursively(innerArchiveData, results, innerArchiveName, currentPath);
              if (results.localTotalCount === antesCount) {
                registrarExtractionError(
                  `${currentPath}/${innerArchiveName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                  { data: innerArchiveData, fileName: innerArchiveName }
                );
              }
            }
          }
          return;
        } catch (e) {
          console.error('Erro ZIP:', e);
          registrarExtractionError(
            `${currentPath} — falha ao ler ZIP: ${e instanceof Error ? e.message : String(e)}`,
            { data: archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData), fileName: containerName }
          );
          return;
        }
      }

      if (type === 'rar' || type === 'unknown') {
        // Declarado aqui fora (em vez de dentro de cada try) pra ficar
        // acessível no catch final — se todas as tentativas de extração
        // falharem, dá pra oferecer o download do arquivo original exatamente
        // como foi enviado, sem precisar re-extrair nada.
        const uint8 = archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);
        // Segura a fila pelo bloco INTEIRO (libarchive.js + node-unrar-js) — se
        // já estamos numa chamada aninhada (jaTemFilaUnrar=true), a vez já foi
        // adquirida por quem chamou, então não adquire de novo (deadlock).
        const liberarFilaUnrar = jaTemFilaUnrar ? null : await adquirirFilaUnrar();
        try {
        try {
          if (typeof (window as any).Archive === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/libarchive.js/dist/libarchive.js';
            document.head.appendChild(script);
            await new Promise(r => script.onload = r);
            (window as any).Archive.init({ workerUrl: 'https://unpkg.com/libarchive.js/dist/worker-bundle.js' });
          }
          const archive = await Promise.race([
            (window as any).Archive.open(new Blob([uint8])),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
          ]) as any;
          const entries = await archive.getEntries();
          for (const entry of entries) {
            const name = entry.getPath();
            if (entry.isFolder()) continue;
            const baseName = name.split('/').pop() || name;
            const isArchiveEntry = name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar');
            // libarchive.js (carregado via CDN) não tem uma API de tamanho confirmada
            // aqui — (entry as any).size fica undefined se não existir, e nesse caso
            // isProvavelmenteNaoFiscal não aplica a proteção de "arquivo pequeno",
            // caindo pro comportamento só-por-extensão (mesmo risco de antes, restrito
            // a esse fallback específico de RAR).
            if (!isArchiveEntry && isProvavelmenteNaoFiscal(baseName, (entry as any).size)) { results.localNonXmlCount++; continue; }
            const fileData = await entry.extract();

            if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
              const antesCount = results.localTotalCount;
              const nestedBytes = new Uint8Array(await fileData.arrayBuffer());
              // true: já estamos dentro da vez desta extração na fila (ver
              // adquirirFilaUnrar acima) — evita tentar adquirir de novo (deadlock).
              await processArchiveRecursively(nestedBytes, results, baseName, currentPath, true);
              if (results.localTotalCount === antesCount) {
                registrarExtractionError(
                  `${currentPath}/${baseName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                  { data: nestedBytes, fileName: baseName }
                );
              }
            } else {
              const xmlText = await fileData.text();
              if (xmlText.trimStart().startsWith('|0000|')) {
                const sped = parseSped(xmlText, baseName);
                if (sped) results.localSpeds.push(sped);
                continue;
              }
              const looksLikeXml = xmlText.trim().startsWith('<');
              if (looksLikeXml || /^[0-9]{44}$/.test(baseName) || name.toLowerCase().endsWith('.xml')) {
                const data = parseXML(xmlText, name);
                if (data.tipo !== 'outro') {
                  const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                  ensureSourceInMap(displaySource, true);

                  results.localTotalCount++;
                  data.sourceName = displaySource;
                  if (data.isCancelamento) results.localCancellations++;
                  if (data.tipo === 'inutilizacao') {
                    results.localInuts.push(data); results.localInutsCount++;
                  } else if (data.tipo === 'nfe' || data.tipo === 'evento') {
                    results.localXmls.push(data);
                    if (data.tipo === 'nfe') results.localValidNfCount++;
                  } else if (data.tipo === 'nfse' || data.tipo === 'nfse_evento') {
                    results.localNfse.push(data);
                  } else {
                    results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                  }
                } else { results.localNonXmlCount++; }
              } else { results.localNonXmlCount++; }
            }
          }
          setExtractionStatus(null);
          return;
        } catch (libErr) { console.warn('LibArchive falhou, tentando node-unrar-js...', libErr); }

        try {
          const cleanBuffer = new ArrayBuffer(uint8.length + 1024*1024);
          new Uint8Array(cleanBuffer).set(uint8);
          let currentWasm = wasmBinary || await loadWasm();
          if (currentWasm) {
            // Pre-scan: list entries without decompressing, so the user sees the
            // real nesting/volume before we commit to extracting it (and so very
            // large nested archives get a heads-up instead of a silent freeze).
            // Protegido pela fila que já cobre o bloco inteiro (adquirida lá em
            // cima) — não precisa (nem deve) entrar na fila de novo aqui.
            const listExtractor = await createExtractorFromData({ data: new Uint8Array(cleanBuffer), wasmBinary: currentWasm });
            const headers = [...listExtractor.getFileList().fileHeaders].filter(h => !h.flags.directory);
            const nestedArchives = headers.filter(h => /\.(zip|rar)$/i.test(h.name));
            const totalUnpSize = headers.reduce((s, h) => s + h.unpSize, 0);
            if (nestedArchives.length > 0 || totalUnpSize > 20 * 1024 * 1024) {
              setExtractionStatus(`Extraindo ${containerName} (${headers.length} arquivo(s), ${(totalUnpSize / 1024 / 1024).toFixed(0)}MB, ${nestedArchives.length} aninhado(s))...`);
            }

            // RARs grandes/aninhados (ex: um RAR de NFC-e que aninha um ZIP com
            // milhares de XML) ficam bem na borda do limite de memória do WASM —
            // às vezes uma tentativa do zero passa, às vezes não, dependendo do
            // que mais o navegador tem em uso naquele instante (é uma corrida de
            // recursos, não um erro determinístico do arquivo em si). Por isso
            // tenta de novo antes de desistir. Cada tentativa roda contra um
            // acumulador PRÓPRIO (attemptResults) e só é fundida no `results` de
            // fora se terminar inteira sem erro — assim uma tentativa que falha
            // no meio não deixa nota duplicada nem nota "meio contada" pra trás.
            const MAX_TENTATIVAS_RAR = 3;
            let ultimoErroRar: unknown = null;
            for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_RAR; tentativa++) {
              const attemptResults = {
                localXmls: [] as XmlData[],
                localInuts: [] as XmlData[],
                localOthers: [] as XmlData[],
                localNfse: [] as XmlData[],
                localSpeds: [] as SpedData[],
                localTotalCount: 0,
                localCancellations: 0,
                localValidNfCount: 0,
                localInutsCount: 0,
                localNonXmlCount: 0,
              };
              try {
                const rodarTentativa = async () => {
                  const attemptBuffer = new ArrayBuffer(uint8.length + 1024*1024);
                  new Uint8Array(attemptBuffer).set(uint8);
                  const extractor = await createExtractorFromData({ data: new Uint8Array(attemptBuffer), wasmBinary: currentWasm });
                  const extracted = extractor.extract();
                  for (const file of extracted.files) {
                    if (!file.extraction || file.extraction.length === 0) continue;
                    const name = file.fileHeader.name;
                    const baseName = name.split('/').pop() || name;
                    if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
                      // Give the JS engine a chance to actually reclaim the previous
                      // archive's WASM/buffer memory before diving into the next
                      // nested one — without this, deeply nested RARs can pile up
                      // enough live memory at once to crash the tab.
                      await new Promise(r => setTimeout(r, 0));
                      const antesCount = attemptResults.localTotalCount;
                      // jaTemFilaUnrar=true: já estamos dentro da vez desta extração
                      // na fila (ver comFilaDeUnrar acima) — uma nova extração de RAR
                      // aninhada aqui dentro NÃO deve entrar na fila de novo (senão
                      // ficaria esperando a própria vez terminar, um deadlock).
                      await processArchiveRecursively(file.extraction, attemptResults, baseName, currentPath, true);
                      if (attemptResults.localTotalCount === antesCount) {
                        registrarExtractionError(
                          `${currentPath}/${baseName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                          { data: file.extraction as Uint8Array, fileName: baseName }
                        );
                      }
                    } else if (isProvavelmenteNaoFiscal(baseName, file.fileHeader.unpSize)) {
                      attemptResults.localNonXmlCount++;
                    } else {
                      const xmlText = new TextDecoder().decode(file.extraction);
                      if (xmlText.trimStart().startsWith('|0000|')) {
                        const sped = parseSped(xmlText, baseName);
                        if (sped) attemptResults.localSpeds.push(sped);
                        continue;
                      }
                      if (xmlText.trim().startsWith('<') || name.toLowerCase().endsWith('.xml')) {
                        const data = parseXML(xmlText, name);
                        if (data.tipo !== 'outro') {
                          const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                          ensureSourceInMap(displaySource, true);

                          attemptResults.localTotalCount++; data.sourceName = displaySource;
                          if (data.isCancelamento) attemptResults.localCancellations++;
                          if (data.tipo === 'inutilizacao') {
                            attemptResults.localInuts.push(data); attemptResults.localInutsCount++;
                          } else if (data.tipo === 'nfe' || data.tipo === 'evento') {
                            attemptResults.localXmls.push(data);
                            if (data.tipo === 'nfe') attemptResults.localValidNfCount++;
                          } else if (data.tipo === 'nfse' || data.tipo === 'nfse_evento') {
                            attemptResults.localNfse.push(data);
                          } else {
                            attemptResults.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                          }
                        } else { attemptResults.localNonXmlCount++; }
                      } else { attemptResults.localNonXmlCount++; }
                    }
                    // node-unrar-js (ExtractorData) guarda o conteúdo de CADA arquivo já
                    // extraído num mapa interno (`dataFiles`) que nunca é limpo sozinho —
                    // com um RAR de dezenas de milhares de XML, isso acumula tudo em
                    // memória até travar a aba, mesmo o generator entregando um arquivo
                    // por vez. Apaga a entrada assim que já processamos o conteúdo, pra
                    // esse arquivo virar lixo de verdade (GC libera de fato).
                    try {
                      const ex = extractor as any;
                      delete ex.dataFiles?.[ex.getExtractedFileName?.(name)];
                    } catch {}
                    file.extraction = undefined as any;
                  }
                };
                // Protegido pela fila que já cobre o bloco inteiro (adquirida lá
                // em cima) — não precisa (nem deve) entrar na fila de novo aqui.
                await rodarTentativa();
                // Essa tentativa terminou inteira sem erro — funde no acumulador
                // de fora e para de tentar de novo.
                results.localXmls.push(...attemptResults.localXmls);
                results.localInuts.push(...attemptResults.localInuts);
                results.localOthers.push(...attemptResults.localOthers);
                results.localNfse.push(...attemptResults.localNfse);
                results.localSpeds.push(...attemptResults.localSpeds);
                results.localTotalCount += attemptResults.localTotalCount;
                results.localCancellations += attemptResults.localCancellations;
                results.localValidNfCount += attemptResults.localValidNfCount;
                results.localInutsCount += attemptResults.localInutsCount;
                results.localNonXmlCount += attemptResults.localNonXmlCount;
                ultimoErroRar = null;
                break;
              } catch (attemptErr) {
                ultimoErroRar = attemptErr;
                if (tentativa < MAX_TENTATIVAS_RAR) {
                  console.warn(`Tentativa ${tentativa}/${MAX_TENTATIVAS_RAR} falhou extraindo ${containerName}, tentando de novo...`, attemptErr);
                  setExtractionStatus(`${containerName} deu erro na tentativa ${tentativa}, tentando de novo (${tentativa + 1}/${MAX_TENTATIVAS_RAR})...`);
                  await new Promise(r => setTimeout(r, 400 * tentativa));
                }
              }
            }
            if (ultimoErroRar) throw ultimoErroRar;
          }
        } catch (rarErr) {
          console.error('Erro RAR final:', rarErr);
          const msg = rarErr instanceof Error ? rarErr.message : String(rarErr);
          registrarExtractionError(
            `${currentPath} — parou no meio da extração (${msg}). Pode haver notas faltando desse arquivo — geralmente por RAR muito grande/aninhado consumindo toda a memória disponível.`,
            { data: uint8, fileName: containerName }
          );
        }
        setExtractionStatus(null);
        } finally {
          liberarFilaUnrar?.();
        }
      }
    };

    setProcessingProgress({ current: 0, total: fileArray.length });
    const BATCH_SIZE = 10; // Smaller batch for recursive work

    try {
      for (let i = 0; i < fileArray.length; i += BATCH_SIZE) {
        const batch = fileArray.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (file) => {
          const fileUniqueIdentifier = file.webkitRelativePath || file.name;
          if (updatedProcessedNames.has(fileUniqueIdentifier)) return null;

          let res = {
            localXmls: [] as XmlData[],
            localInuts: [] as XmlData[],
            localOthers: [] as XmlData[],
            localNfse: [] as XmlData[],
            localTotalCount: 0,
            localCancellations: 0,
            localValidNfCount: 0,
            localInutsCount: 0,
            localNonXmlCount: 0,
            localSpeds: [] as SpedData[]
          };

          const nameLower = file.name.toLowerCase();
          if (nameLower.endsWith('.xml')) {
            updatedProcessedNames.add(fileUniqueIdentifier);
            const indSource = "Arquivos Individuais";
            if (!sourceMap.has(indSource)) {
              sourceMap.set(indSource, {
                name: indSource,
                isZip: false,
                totalXmls: 0,
                saidaCount: 0,
                entradaCount: 0
              });
            }
            res.localTotalCount++;
            try {
              const text = await file.text();
              const data = parseXML(text, file.name);
              data.sourceName = "Arquivos Individuais";
              if (data.isCancelamento) res.localCancellations++;
              if (data.tipo === 'inutilizacao') {
                res.localInuts.push(data);
                res.localInutsCount++;
              } else if (data.tipo === 'nfe' || data.tipo === 'evento') {
                // Keep both NF-e notes and cancellation events in the same list so
                // faturamentoTotal can cross-reference them by chave
                res.localXmls.push(data);
                if (data.tipo === 'nfe') res.localValidNfCount++;
              } else if (data.tipo === 'nfse' || data.tipo === 'nfse_evento') {
                res.localNfse.push(data);
              } else {
                res.localOthers.push({ fileName: file.name, subTipo: data.subTipo, tipo: data.tipo } as any);
              }
            } catch (e) {
              console.error('Erro ao processar XML:', file.name, e);
            }
          } else if (nameLower.endsWith('.zip')) {
            const zipData = await file.arrayBuffer();
            const antesCount = res.localTotalCount;
            try {
              const workerResp = await runZipInWorker(zipData, file.name);
              res.localXmls.push(...workerResp.results.localXmls);
              res.localInuts.push(...workerResp.results.localInuts);
              res.localOthers.push(...workerResp.results.localOthers);
              res.localNfse.push(...workerResp.results.localNfse);
              res.localTotalCount += workerResp.results.localTotalCount;
              res.localCancellations += workerResp.results.localCancellations;
              res.localValidNfCount += workerResp.results.localValidNfCount;
              res.localInutsCount += workerResp.results.localInutsCount;
              res.localNonXmlCount += workerResp.results.localNonXmlCount;
              res.localSpeds.push(...workerResp.results.localSpeds);
              workerResp.sourceEntries.forEach(([entryName, meta]) => {
                if (!sourceMap.has(entryName)) sourceMap.set(entryName, meta);
              });
              workerResp.extractionErrors.forEach(msg => registrarExtractionError(msg));
              // RAR (ou tipo desconhecido) achado dentro do ZIP — o worker não tem
              // como abrir isso (libarchive.js precisa de document/window), então
              // processa aqui do jeito que já funciona hoje, sem mudar nada disso.
              for (const pending of workerResp.pendingArchives) {
                const antesPending = res.localTotalCount;
                await processArchiveRecursively(pending.data, res, pending.containerName, pending.archivePath);
                if (res.localTotalCount === antesPending) {
                  const currentPath = pending.archivePath ? `${pending.archivePath}/${pending.containerName}` : pending.containerName;
                  registrarExtractionError(
                    `${currentPath} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                    { data: pending.data instanceof Uint8Array ? pending.data : new Uint8Array(pending.data), fileName: pending.containerName }
                  );
                }
              }
              if (res.localTotalCount === antesCount) {
                registrarExtractionError(
                  `${file.name} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                  { data: new Uint8Array(zipData), fileName: file.name }
                );
              }
            } catch (err) {
              console.error('Erro no worker de ZIP:', err);
              registrarExtractionError(
                `${file.name} — falha ao processar ZIP: ${err instanceof Error ? err.message : String(err)}`,
                { data: new Uint8Array(zipData), fileName: file.name }
              );
            }
          } else if (nameLower.endsWith('.rar')) {
            const zipData = await file.arrayBuffer();
            const antesCount = res.localTotalCount;
            await processArchiveRecursively(zipData, res, file.name);
            if (res.localTotalCount === antesCount) {
              registrarExtractionError(
                `${file.name} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`,
                { data: new Uint8Array(zipData), fileName: file.name }
              );
            }
          } else if (nameLower.endsWith('.txt')) {
            const text = await file.text();
            if (text.trimStart().startsWith('|0000|')) {
              const sped = parseSped(text, file.name);
              if (sped) res.localSpeds.push(sped);
            } else {
              res.localNonXmlCount++;
            }
          } else {
            const sName = file.webkitRelativePath ? file.webkitRelativePath.split('/')[0] : file.name;
            if (!sourceMap.has(sName)) {
              sourceMap.set(sName, {
                name: sName,
                isZip: false,
                totalXmls: 0,
                saidaCount: 0,
                entradaCount: 0
              });
            }
            res.localNonXmlCount++;
          }
          return { name: file.name, res };
        }));

        // Se o analista baixou o arquivo original de um erro anterior, extraiu
        // na mão e reanexou aqui com o MESMO nome, esse reanexo pode ter
        // sucesso MESMO que o arquivo antigo quebrado (que continua na lista
        // de anexados, já que ele não é removido automaticamente) ainda
        // falhe de novo no MESMO lote — por isso essa decisão só é tomada
        // DEPOIS que todo o lote termina, olhando o resultado final por nome
        // (em vez de limpar/re-adicionar arquivo a arquivo, o que causaria
        // uma corrida onde o resultado final dependeria só da ordem de
        // conclusão de cada arquivo).
        const nomesComSucessoNesteLote = new Set(
          results.filter(r => r && r.res.localTotalCount > 0).map(r => r!.name)
        );
        if (nomesComSucessoNesteLote.size > 0) {
          setExtractionErrors(prev => prev.filter(e => !e.downloadName || !nomesComSucessoNesteLote.has(e.downloadName)));
        }

        results.forEach(r => {
          if (!r) return;
          const res = r.res;
          finalXmls.push(...res.localXmls);
          finalInuts.push(...res.localInuts);
          finalOthers.push(...res.localOthers);
          finalNfse.push(...res.localNfse);
          foundSpeds.push(...res.localSpeds);
          
          setStats(prev => ({
            ...prev,
            totalFiles: prev.totalFiles + 1,
            validNf: prev.validNf + res.localValidNfCount,
            inutilizations: prev.inutilizations + res.localInutsCount,
            cancellations: prev.cancellations + res.localCancellations,
            nonXmlCount: prev.nonXmlCount + res.localNonXmlCount,
            totalXmls: prev.totalXmls + res.localTotalCount
          }));
        });

        setProcessingProgress({
          current: Math.min(i + BATCH_SIZE, fileArray.length),
          total: fileArray.length
        });

        await new Promise(resolve => setTimeout(resolve, 0));
      }

      const mergedXmls = deduplicateXmls([...xmlList, ...finalXmls]);
      const mergedInuts = deduplicateInutilizacoes([...inutilizacoes, ...finalInuts]);
      const mergedOthers = deduplicateOthers([...otherXmlsList, ...finalOthers]);
      const mergedNfse = deduplicateXmls([...nfseList, ...finalNfse]);

      // Identify main company from emitters only: the company that issues the most notes is the audited entity.
      // Counting emitters (not destCnpj) avoids conflating suppliers' entrada notes with the main company.
      const emitCounts: Record<string, number> = {};
      mergedXmls.forEach(xml => {
        if (xml.emitCnpj) emitCounts[xml.emitCnpj] = (emitCounts[xml.emitCnpj] || 0) + 1;
      });
      mergedInuts.forEach(inut => {
        if (inut.cnpj) emitCounts[inut.cnpj] = (emitCounts[inut.cnpj] || 0) + 1;
      });
      const mainCnpj = Object.entries(emitCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      // Chaves (chNFe) of notes from the main company, used to validate events below
      const mainCnpjChaves = new Set<string>(
        mergedXmls
          .filter(xml => xml.tipo === 'nfe' && (xml.emitCnpj === mainCnpj || xml.destCnpj === mainCnpj) && xml.chave)
          .map(xml => xml.chave!)
      );

      // Classify XMLs: supplier entradas (destCnpj = mainCnpj) are accepted silently;
      // only notes with no connection to the main company are flagged as conflicts.
      let fornecedorEntradaCount = 0;
      const fornecedorNames: Record<string, string> = {};
      const conflictingXmls: XmlData[] = [];

      if (mainCnpj) {
        mergedXmls.forEach(xml => {
          if (xml.tipo === 'evento') {
            const involvesMain = (xml.chave ? mainCnpjChaves.has(xml.chave) : false) || xml.cnpj === mainCnpj;
            if (!involvesMain) conflictingXmls.push(xml);
          } else if (xml.emitCnpj === mainCnpj || xml.cnpj === mainCnpj) {
            // Own note (saída or devolução issued by the main company) — always OK
          } else if (xml.destCnpj === mainCnpj) {
            // Supplier sold TO the main company (nota de entrada/compra) — accept silently
            fornecedorEntradaCount++;
            if (xml.emitCnpj && !fornecedorNames[xml.emitCnpj]) {
              fornecedorNames[xml.emitCnpj] = xml.emitNome || xml.razaoSocial || '';
            }
          } else {
            // No connection to the main company — genuine conflict
            conflictingXmls.push(xml);
          }
        });
        mergedInuts.forEach(inut => {
          if (inut.cnpj !== mainCnpj) conflictingXmls.push(inut as XmlData);
        });
      }

      if (conflictingXmls.length > 0) {
        const distinctConflicting = new Set<string>();
        const cnpjNames: Record<string, string> = {};

        conflictingXmls.forEach(xml => {
          const otherCnpj = xml.emitCnpj || xml.cnpj;
          if (otherCnpj) {
            distinctConflicting.add(otherCnpj);
            if (xml.razaoSocial || xml.emitNome) {
              cnpjNames[otherCnpj] = xml.razaoSocial || xml.emitNome || '';
            }
          }
        });

        if (distinctConflicting.size > 0) {
          const conflictList = Array.from(distinctConflicting).map(cnpj => {
            return `- CNPJ: ${cnpj}${cnpjNames[cnpj] ? ` (${cnpjNames[cnpj]})` : ''}`;
          });

          const dicaAninhamento = extractionErrorsLocal.length > 0
            ? `\n\n⚠ Foram detectadas falhas ao extrair arquivo(s) aninhado(s) durante essa importação (veja os detalhes acima) — é bem provável que as notas de SAÍDA da empresa principal estejam nesses arquivos que falharam, e por isso só sobrou entrada de fornecedores diferentes, parecendo "várias empresas". Tente extrair o ZIP/RAR manualmente no seu computador e reenviar as pastas/arquivos já descompactados.`
            : `\n\nPara evitar inconsistências, envie apenas arquivos de uma única empresa por vez.`;
          alert(`⚠️ Erro de Importação: Múltiplas Empresas Detectadas!\n\nForam encontrados XMLs de outra empresa que não pertencem à empresa principal sob auditoria:\n${conflictList.join('\n')}${dicaAninhamento}`);

          setIsProcessing(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
          if (folderInputRef.current) folderInputRef.current.value = '';
          return;
        }
      }

      // If supplier entradas were found, store info for the UI notice (non-blocking)
      if (fornecedorEntradaCount > 0) {
        const nomesFornecedores = Object.values(fornecedorNames).filter(Boolean).slice(0, 3).join(', ');
        setFornecedorEntradaInfo({ count: fornecedorEntradaCount, nomes: nomesFornecedores });
      } else {
        setFornecedorEntradaInfo(null);
      }

      if (foundSpeds.length > 0) {
        const spedsValidos = foundSpeds.filter(spedTemPeriodoValido);
        foundSpeds.filter(s => !spedTemPeriodoValido(s)).forEach(s => registrarExtractionError(
          `${s.fileName} — SPED com data de início ilegível ("${s.dtIni || '(vazio)'}"); descartado pra não contar notas em dobro. Peça pro cliente reenviar esse arquivo.`
        ));
        if (spedsValidos.length > 0) setSpedEntries(prev => mergeSpedBatch(prev, spedsValidos));
      }
      setAttachedSources(Array.from(sourceMap.values()));
      setProcessedFileNames(updatedProcessedNames);
      setXmlList(mergedXmls);
      setInutilizacoes(mergedInuts);
      setOtherXmlsList(mergedOthers);
      setNfseList(mergedNfse);

      setStats(prev => ({
        ...prev,
        totalXmls: mergedXmls.length + mergedInuts.length + mergedOthers.length + mergedNfse.length
      }));
    } catch (error) {
      console.error('Erro geral no processamento:', error);
    } finally {
      setIsProcessing(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const runAnalysis = () => {
    // Lote só com NFS-e (sem nenhum NF-e/NFC-e) precisa poder abrir a tela de
    // resultados também — senão o card de NFS-e (que não depende de xmlList)
    // fica inacessível. setAnalysis([]) mais abaixo já cobre o caso xmlList
    // vazio sem quebrar nada: analysis vira array vazio (não null), e a tela
    // de resultados abre normalmente, só sem séries de NF-e pra mostrar.
    if (xmlList.length === 0 && nfseList.length === 0) return;

    let filteredXmlsList = xmlList;
    // Inutilizações NUNCA são filtradas por mês: a data da inutilização é só
    // quando o pedido foi registrado no SEFAZ, sem relação com o mês do número
    // que ela cobre (ex: inutilização pedida em agosto pode cobrir uma lacuna
    // de julho). Filtrar isso faria uma lacuna já resolvida aparecer como
    // "faltante real" só porque a inutilização caiu fora do mês selecionado.
    const filteredInutsList = inutilizacoes;

    if (filterMes !== 'Todos') {
      filteredXmlsList = xmlList.filter(xml => getMonthYear(xml.data) === filterMes);
    }

    if (filteredXmlsList.length === 0) {
      setAnalysis([]);
      return;
    }

    // 1. Identify the Main Company (CNPJ focus)
    const cnpjCounts: { [cnpj: string]: number } = {};
    filteredXmlsList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });

    const mainCnpj = Object.entries(cnpjCounts).sort((a,b) => b[1] - a[1])[0]?.[0];
    const groups: { [key: string]: SerieAnalysis } = {};
    let localEntradaCount = 0;

    filteredXmlsList.forEach(xml => {
      // Ignora completamente notas emitidas por terceiros (fornecedores)
      if (xml.emitCnpj !== mainCnpj) {
        localEntradaCount++;
        return;
      }
      
      // Qualquer nota emitida pela própria empresa (mesmo CFOP de entrada, tipo
      // devolução de venda ou baixa de estoque) ocupa numeração real dentro da
      // série/modelo — por isso entra na mesma sequência, independente do tpNF.
      // Só é tratada como "entrada" de fato quando o emitente é um terceiro (acima).
      const direcao = 'saida';

      const key = `${mainCnpj}_${direcao}_${xml.modelo}_${xml.serie}`;
      
      if (!groups[key]) {
        groups[key] = {
          cnpj: mainCnpj || xml.cnpj!,
          ie: xml.ie || 'N/A',
          razaoSocial: xml.emitNome || 'Sua Empresa',
          partnerNome: xml.destNome,
          direcao,
          modelo: xml.modelo!,
          serie: xml.serie!,
          xmls: [],
          min: 0,
          max: 0,
          esperados: 0,
          recebidos: 0,
          faltantes: [],
          faltantesInutilizados: [],
          faltantesInutilizadosManual: [],
          faltantesInutilizadosOutroMes: [],
          todasInutilizacoes: [],
          situacao: 'Íntegra',
          mesReferencia: ''
        };
      }
      groups[key].xmls.push(xml);
    });

    setEntradaCount(localEntradaCount);
    const result = Object.values(groups).map(group => {
      const numerosRaw = group.xmls.map(x => parseInt(x.numero!)).sort((a, b) => a - b);
      const numerosSet = new Set(numerosRaw);
      const numeros = Array.from(numerosSet).sort((a, b) => a - b);
      const min = numeros[0];
      const max = numeros[numeros.length - 1];
      const esperados = max - min + 1;
      // Use unique count — duplicates inflate numerosRaw.length and would mask gaps
      const recebidos = numerosSet.size;
      const duplicados = numerosRaw.length - numerosSet.size;

      // Always scan every number in range — using Set.has is O(1)
      const faltantes: number[] = [];
      for (let i = min; i <= max; i++) {
        if (!numerosSet.has(i)) {
          faltantes.push(i);
          // Safety break to avoid memory crash if millions are missing
          if (faltantes.length > 10000) break;
        }
      }

      const inutSerie = filteredInutsList.filter(inut => 
        inut.cnpj === group.cnpj && 
        inut.modelo === group.modelo && 
        inut.serie === group.serie
      );

      const numerosInutilizadosSet = new Set<number>();
      const numerosInutilizadosManualSet = new Set<number>();
      // Mês (getMonthYear) da inutilização que cobre cada número — usado só para
      // sinalizar quando esse mês diverge do filtro atual, não para decidir se o
      // número está ou não coberto (isso já não depende mais do filtro de mês).
      const mesInutPorNumero = new Map<number, string>();
      inutSerie.forEach(inut => {
        for (let i = inut.nNFIni!; i <= inut.nNFFin!; i++) {
          numerosInutilizadosSet.add(i);
          if (inut.origemManual) numerosInutilizadosManualSet.add(i);
          mesInutPorNumero.set(i, getMonthYear(inut.data));
        }
      });

      const faltantesReais = faltantes.filter(num => !numerosInutilizadosSet.has(num));
      const faltantesInutilizados = faltantes.filter(num => numerosInutilizadosSet.has(num));
      const faltantesInutilizadosManual = faltantesInutilizados.filter(num => numerosInutilizadosManualSet.has(num));
      const faltantesInutilizadosOutroMes = filterMes === 'Todos'
        ? []
        : faltantesInutilizados.filter(num => mesInutPorNumero.get(num) && mesInutPorNumero.get(num) !== filterMes);
      const todasInutilizacoes = Array.from(numerosInutilizadosSet).sort((a, b) => a - b);

      let situacao = faltantesReais.length > 0 ? 'Quebra Identificada' : 'Íntegra';
      
      // Identificar os meses de referência presentes na série (ordenados cronologicamente por data do XML)
      const sortedXmlsForMonths = [...group.xmls].sort((a, b) => (a.data || '').localeCompare(b.data || ''));
      const uniqueMonths = Array.from(new Set(
        sortedXmlsForMonths.map(x => getMonthYear(x.data)).filter(m => m !== '')
      ));
      const mesReferencia = uniqueMonths.length > 0 ? uniqueMonths.join(', ') : 'Não identificado';

      const canceladosSet = new Set<number>();
      group.xmls.forEach(x => {
        if (x.isCancelamento && x.numero) {
          canceladosSet.add(parseInt(x.numero));
        }
      });
      const cancelados = Array.from(canceladosSet).sort((a, b) => a - b);

      return {
        ...group,
        min,
        max,
        esperados,
        recebidos,
        duplicados,
        faltantes: faltantesReais,
        faltantesInutilizados,
        faltantesInutilizadosManual,
        faltantesInutilizadosOutroMes,
        todasInutilizacoes,
        cancelados,
        situacao,
        mesReferencia
      };
    });

    setAnalysis(result);
    
    setConsolidatedMessage(generateInitialConsolidated(result));
  };

  const generateInitialConsolidated = (all: SerieAnalysis[]) => {
    const withProblems = all.filter(s => s.faltantes.length > 0);
    if (withProblems.length === 0) return '';
    const first = withProblems[0];
    let msg = `Prezado(a) Cliente,\n\nIdentificamos quebra de sequência numérica de VENDAS/SAÍDAS em ${withProblems.length} série(s).\n\nEMPRESA: ${first.razaoSocial}\nCNPJ: ${first.cnpj}\nIE: ${first.ie}\nMÊS: ${first.mesReferencia}\n\n`;
    withProblems.forEach((s, i) => {
      msg += `${i + 1}. SÉRIE ${s.serie} - Modelo ${s.modelo}\n`;
      msg += `• Faixa: ${s.min} a ${s.max}\n`;
      msg += `• Faltantes: ${formatarFaixas(agruparFaixas(s.faltantes))}\n\n`;
    });
    msg += `Solicitamos verificar no sistema emissor e nos enviar os XMLs faltantes ou comprovantes de inutilização.\n\nAtenciosamente,\n${analystName || '[Nome do Analista]'}`;
    return msg;
  };

  // Update messages when analyst name changes
  React.useEffect(() => {
    if (analysis) {
      setConsolidatedMessage(prev => {
        const lines = prev.split('\n');
        if (lines.length > 0) {
          lines[lines.length - 1] = analystName || '[Nome do Analista]';
        }
        return lines.join('\n');
      });
    }
  }, [analystName, analysis]);

  const reset = () => {
    // node-unrar-js (WASM) e o libarchive.js carregado via CDN mantêm um
    // singleton por aba inteira — a memória linear do WASM só cresce, nunca
    // encolhe, e o worker do libarchive.js também é reaproveitado. Resetar só
    // o estado do React não zera esse lixo acumulado: numa segunda análise
    // seguida sem dar F5, esses módulos reaproveitam a memória já inchada da
    // análise anterior, e RARs grandes que extrairiam normal na primeira vez
    // passam a falhar no meio ("Archive header or data are damaged" / "File
    // read error"), perdendo notas fiscais silenciosamente. A única forma
    // confiável de zerar isso de verdade é recarregar a página — que é
    // exatamente o que resolvia quando o usuário dava F5 manualmente.
    window.location.reload();
  };

  const filteredAnalysis = useMemo(() => {
    if (!analysis) return [];
    return analysis.filter(serie => {
      const modeloMatch = filterModelo === 'Todos' || serie.modelo === filterModelo;
      return modeloMatch;
    });
  }, [analysis, filterModelo]);

  // Alerta de série sumida/nova: com "Todos os Meses" selecionado, cada série
  // já mostra em que mês(es) teve nota (mesReferencia), mas nada aponta
  // quando uma série ficou de fora de um mês em que as OUTRAS tiveram
  // movimento — pode ser série nova, descontinuada, ou o mês genuinamente
  // sem nenhuma nota dela. Compara o conjunto de meses de cada série contra
  // a união de meses de TODAS as séries do período; só faz sentido com
  // "Todos" selecionado (com um mês específico, toda série já é só daquele mês).
  const mesesFaltantesPorSerie = useMemo(() => {
    const resultado = new Map<number, string[]>();
    if (filterMes !== 'Todos' || filteredAnalysis.length === 0) return resultado;

    const ordenarMeses = (meses: string[]) => [...meses].sort((a, b) => {
      const [nomeA, anoA] = a.split('/');
      const [nomeB, anoB] = b.split('/');
      const chaveA = `${anoA}${String(MESES.indexOf(nomeA)).padStart(2, '0')}`;
      const chaveB = `${anoB}${String(MESES.indexOf(nomeB)).padStart(2, '0')}`;
      return chaveA.localeCompare(chaveB);
    });

    const mesesPorSerie = filteredAnalysis.map(s =>
      s.mesReferencia && s.mesReferencia !== 'Não identificado'
        ? s.mesReferencia.split(',').map(m => m.trim())
        : []
    );
    const mesesGlobais = ordenarMeses(Array.from(new Set(mesesPorSerie.flat())));
    if (mesesGlobais.length < 2) return resultado;

    filteredAnalysis.forEach((_serie, idx) => {
      const proprios = new Set(mesesPorSerie[idx]);
      const faltando = mesesGlobais.filter(m => !proprios.has(m));
      if (faltando.length > 0) resultado.set(idx, faltando);
    });
    return resultado;
  }, [filteredAnalysis, filterMes]);

  const copyToClipboard = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const baixarDanfe = async (nota: XmlData & { isCancelada?: boolean }) => {
    if (!nota.rawXml) {
      alert('XML original desta nota não está disponível para gerar o DANFE.');
      return;
    }
    setDownloadingDanfeChave(nota.chave || null);
    try {
      const response = await fetch('/api/danfe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          xml: nota.rawXml,
          cancelada: !!nota.isCancelada,
          chave: nota.chave,
          protocolo: nota.protocolo,
          dataEmissao: nota.data
        })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao gerar o DANFE');
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `DANFE_${nota.numero || 'nota'}_${nota.chave || ''}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Erro ao baixar DANFE:', err);
      alert('Não foi possível gerar o DANFE desta nota. Tente novamente.');
    } finally {
      setDownloadingDanfeChave(null);
    }
  };

  // Baixa o XML bruto de uma nota específica, pra levantar prova rápida
  // (ex: mostrar pro cliente uma venda que caiu como POS manual/sem TEF).
  const baixarXmlEvidencia = (nota: XmlData) => {
    if (!nota.rawXml) {
      alert('XML original desta nota não está disponível.');
      return;
    }
    const empresa = sanitizarNomeArquivo(nota.razaoSocial || notasSaida[0]?.razaoSocial || '');
    const periodo = sanitizarNomeArquivo(nota.data ? getMonthYear(nota.data) : periodoParaNomeArquivo());
    const nomeArquivo = [empresa, periodo, `Serie${nota.serie}`, nota.numero].filter(Boolean).join('_');
    const blob = new Blob([nota.rawXml], { type: 'application/xml;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${nomeArquivo}.xml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  };

  const toggleSelecaoNota = (chave: string) => {
    setNotasSelecionadas(prev => {
      const next = new Set(prev);
      if (next.has(chave)) next.delete(chave);
      else next.add(chave);
      return next;
    });
  };

  const baixarDanfesSelecionados = async () => {
    // Look up against the full notasSaida pool (not the current search results),
    // since selections made across earlier searches must still be found here.
    const selecionadas = notasSaida.filter(n => n.chave && notasSelecionadas.has(n.chave) && n.rawXml);
    if (selecionadas.length === 0) {
      alert('Nenhuma nota selecionada tem XML disponível para gerar DANFE.');
      return;
    }
    setBaixandoLote({ tipo: 'danfe', atual: 0, total: selecionadas.length });
    try {
      const zip = new JSZip();
      for (let i = 0; i < selecionadas.length; i++) {
        const nota = selecionadas[i];
        setBaixandoLote({ tipo: 'danfe', atual: i + 1, total: selecionadas.length });
        try {
          const response = await fetch('/api/danfe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              xml: nota.rawXml,
              cancelada: !!nota.isCancelada,
              chave: nota.chave,
              protocolo: nota.protocolo,
              dataEmissao: nota.data
            })
          });
          if (!response.ok) continue;
          const blob = await response.blob();
          zip.file(`DANFE_${nota.numero || 'nota'}_${nota.chave || i}.pdf`, blob);
        } catch (err) {
          console.error('Erro ao gerar DANFE em lote:', nota.chave, err);
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `DANFEs_selecionados_${selecionadas.length}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setBaixandoLote(null);
    }
  };

  const baixarXmlsSelecionados = async () => {
    const selecionadas = notasSaida.filter(n => n.chave && notasSelecionadas.has(n.chave) && n.rawXml);
    if (selecionadas.length === 0) {
      alert('Nenhuma nota selecionada tem XML disponível para baixar.');
      return;
    }
    const nomeXml = (nota: (typeof selecionadas)[number]) => {
      const name = nomeBaseArquivo(nota.fileName || `${nota.chave}.xml`);
      return name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
    };

    // 1 nota selecionada: baixa o .xml direto, sem zipar — zip só faz sentido
    // pra agrupar mais de um arquivo.
    if (selecionadas.length === 1) {
      const nota = selecionadas[0];
      const blob = new Blob([nota.rawXml!], { type: 'text/xml;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = nomeXml(nota);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    const zip = new JSZip();
    selecionadas.forEach(nota => {
      zip.file(nomeXml(nota), nota.rawXml!);
    });
    try {
      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `XMLs_selecionados_${selecionadas.length}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Erro ao exportar XMLs selecionados:', err);
      alert('Erro ao gerar o arquivo ZIP dos XMLs selecionados.');
    }
  };

  // SEFAZ portals require a logged-in session/certificate to run this query — there's
  // no public API to call from here, so we just copy the CNPJ and hand off to the portal.
  const PORTAL_INUTILIZADAS_NFCE_PE = 'https://nfce.sefaz.pe.gov.br:444/nfce-web/consultarFaixaInut';
  const PORTAL_INUTILIZADAS_NFE_PE = 'http://nfe.sefaz.pe.gov.br/nfe-web/consultarFaixaInut';

  const consultarInutilizadasNoPortal = (cnpj: string, idx: number, url: string, modelo: string) => {
    navigator.clipboard.writeText(cnpj);
    setCopiedCnpjIdx(idx);
    setPortalConsultado(true);
    setManualInutModelo(modelo);
    setTimeout(() => {
      setCopiedCnpjIdx(null);
      window.open(url, '_blank');
    }, 2000);
  };

  // The analyst checks the SEFAZ portal manually and types in the range that
  // came back as inutilizada; this reuses the same inutilizacoes pipeline
  // that XML-parsed inutilizações already flow through, so faltantes/
  // faltantesInutilizados and the consolidated message recompute for free.
  const confirmarInutilizacaoManual = () => {
    const ini = parseInt(manualInutIni);
    const fim = parseInt(manualInutFim);
    const serieNum = manualInutSerie.trim();
    if (!serieNum || !ini || !fim || ini > fim) {
      alert('Informe a série, o número inicial e o número final (inicial ≤ final).');
      return;
    }
    if (!manualInutData) {
      alert('Informe a data da inutilização (a que aparece no portal da SEFAZ) — isso evita ambiguidade em análises com mais de um mês.');
      return;
    }
    const rotuloModelo = manualInutModelo === '55' ? 'NF-e' : 'NFC-e';
    const serieAlvo = analysis?.find(s => s.modelo === manualInutModelo && s.serie === serieNum);
    if (!serieAlvo) {
      alert(`Não encontrei a série ${rotuloModelo} "${serieNum}" nesta análise. Confira o modelo e o número digitados.`);
      return;
    }
    const cobreAlgumFaltante = serieAlvo.faltantes.some(n => n >= ini && n <= fim);
    if (!cobreAlgumFaltante) {
      alert(`Essa faixa não cobre nenhum número faltante da série ${rotuloModelo} ${serieNum}. Confira os valores digitados.`);
      return;
    }

    // The analysis covers a specific period — reject a date typed outside the
    // months this série actually spans, instead of silently accepting a typo.
    if (serieAlvo.mesReferencia !== 'Não identificado') {
      const mesesDaSerie = serieAlvo.mesReferencia.split(',').map(m => {
        const [nomeMes, ano] = m.trim().split('/');
        const mIdx = MESES.indexOf(nomeMes);
        return mIdx >= 0 && ano ? `${ano}-${String(mIdx + 1).padStart(2, '0')}` : null;
      }).filter(Boolean);
      const mesDigitado = manualInutData.substring(0, 7);
      if (mesesDaSerie.length > 0 && !mesesDaSerie.includes(mesDigitado)) {
        alert(`Essa data está fora do período analisado desta série (${serieAlvo.mesReferencia}). Confira a data digitada.`);
        return;
      }
    }

    const novaInutilizacao: XmlData = {
      tipo: 'inutilizacao',
      cnpj: serieAlvo.cnpj,
      modelo: serieAlvo.modelo,
      serie: serieAlvo.serie,
      nNFIni: ini,
      nNFFin: fim,
      data: manualInutData,
      origemManual: true,
      fileName: 'Confirmado manualmente pelo analista (consulta no portal)'
    };
    setInutilizacoes(prev => deduplicateInutilizacoes([...prev, novaInutilizacao]));
    setManualInutSerie('');
    setManualInutIni('');
    setManualInutFim('');
    setManualInutData('');
  };

  const generateConsolidatedMessage = () => {
    if (!analysis) return '';
    const seriesComProblemas = analysis.filter(s => s.faltantes.length > 0);
    if (seriesComProblemas.length === 0) return '';

    const first = seriesComProblemas[0];
    let msg = `Prezado(a) Cliente,\n\nIdentificamos quebra de sequência numérica de VENDAS/SAÍDAS em ${seriesComProblemas.length} série(s).\n\nEMPRESA: ${first.razaoSocial}\nCNPJ: ${first.cnpj}\n\n`;
    
    seriesComProblemas.forEach((s, i) => {
      msg += `${i + 1}. SÉRIE ${s.serie} - Modelo ${s.modelo}\n`;
      msg += `• Faixa: ${s.min} a ${s.max}\n`;
      msg += `• Faltantes: ${formatarFaixas(agruparFaixas(s.faltantes))}\n\n`;
    });

    msg += `Solicitamos verificar no sistema emissor e nos enviar os XMLs faltantes ou comprovantes de inutilização.\n\nAtenciosamente.`;
    return msg;
  };

  return (
    <div className="min-h-screen flex flex-col font-sans text-slate-900 dark:text-slate-100 relative bg-[#FCFBF8] dark:bg-slate-950 bg-[radial-gradient(ellipse_1400px_520px_at_50%_-8%,rgba(23,21,15,0.05),transparent_65%)] dark:bg-[radial-gradient(ellipse_1400px_520px_at_50%_-8%,rgba(201,162,39,0.05),transparent_65%)]">
      {/* Loading Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 pointer-events-none"
            style={{background: 'rgba(10,14,35,0.88)'}}
          >
            <div className="relative w-24 h-24 mb-8">
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 rounded-full"
                style={{border: '4px solid rgba(201,162,39,0.25)', borderTopColor: '#C9A227'}}
              />
              <motion.div 
                animate={{ rotate: -360 }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                className="absolute inset-4 rounded-full"
                style={{border: '4px solid rgba(255,255,255,0.1)', borderTopColor: 'rgba(255,255,255,0.6)'}}
              />
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-auto cursor-pointer"
                onClick={() => setShowEasterEgg(true)}
                title="Clique pra passar o tempo"
              >
                <img src="/simbolo.png" alt="" className="w-9 h-9 object-contain animate-pulse" />
              </div>
            </div>
            <h2 className="text-2xl font-bold mb-2">Processando Arquivos</h2>
            <div className="w-64 h-2 rounded-full overflow-hidden mb-4" style={{background: 'rgba(255,255,255,0.1)'}}>
              <motion.div
                className="h-full"
                style={{background: 'linear-gradient(90deg, #C9A227, #E7C453)'}}
                initial={{ width: 0 }}
                animate={{ width: `${(processingProgress.current / processingProgress.total) * 100}%` }}
              />
            </div>
            <p className="text-center max-w-md" style={{color: 'rgba(255,255,255,0.6)'}}>
              Lendo {processingProgress.current} de {processingProgress.total} arquivos...
            </p>
            <button
              onClick={() => setShowEasterEgg(true)}
              className="mt-3 text-xs underline pointer-events-auto"
              style={{color: 'rgba(255,255,255,0.4)'}}
            >
              Enquanto isso, que tal um joguinho?
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Export Progress Overlay */}
      <AnimatePresence>
        {exportProgress && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 pointer-events-none"
            style={{background: 'rgba(10,14,35,0.88)'}}
          >
            <div className="relative w-24 h-24 mb-8">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 rounded-full"
                style={{border: '4px solid rgba(201,162,39,0.25)', borderTopColor: '#C9A227'}}
              />
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-auto cursor-pointer"
                onClick={() => setShowEasterEgg(true)}
                title="Clique pra passar o tempo"
              >
                <FileSpreadsheet className="w-9 h-9" style={{color: '#C9A227'}} />
              </div>
            </div>
            <h2 className="text-2xl font-bold mb-2">{exportProgress.titulo || 'Gerando Planilha Completa'}</h2>
            <div className="w-64 h-2 rounded-full overflow-hidden mb-4" style={{background: 'rgba(255,255,255,0.1)'}}>
              <motion.div
                className="h-full"
                style={{background: 'linear-gradient(90deg, #C9A227, #E7C453)'}}
                initial={{ width: 0 }}
                animate={{ width: `${(exportProgress.atual / exportProgress.total) * 100}%` }}
              />
            </div>
            <p className="text-center max-w-md" style={{color: 'rgba(255,255,255,0.6)'}}>
              {exportProgress.etapa} — {exportProgress.atual} de {exportProgress.total} {exportProgress.etapa.startsWith('Consultando') ? 'consultas' : 'notas'}
            </p>
            <button
              onClick={() => setShowEasterEgg(true)}
              className="mt-2 text-xs underline pointer-events-auto"
              style={{color: 'rgba(255,255,255,0.4)'}}
            >
              Enquanto isso, que tal um joguinho?
            </button>
            <p className="text-center max-w-md text-xs mt-2" style={{color: 'rgba(255,255,255,0.4)'}}>
              Não feche nem atualize a página até o download começar.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {showEasterEgg && <EasterEggGame onClose={() => setShowEasterEgg(false)} />}

      {/* Confirmação de Simples puro × híbrido — só aparece ao gerar o Perfil do Cliente de empresa do Simples */}
      <AnimatePresence>
        {confirmaSimples && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] backdrop-blur-sm flex items-center justify-center p-6"
            style={{background: 'rgba(10,14,35,0.6)'}}
            onClick={() => setConfirmaSimples(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              onClick={e => e.stopPropagation()}
              className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6"
            >
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-serif text-base font-semibold text-slate-800 dark:text-slate-100">
                  Como a empresa recolhe IBS e CBS?
                </h3>
                <button onClick={() => setConfirmaSimples(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0" title="Cancelar">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                Notas (CRT): <strong>{confirmaSimples.crtTxt}</strong> · Receita: <strong>{confirmaSimples.receitaTxt}</strong>
                {confirmaSimples.diverge && ' — as notas e a Receita divergem; vale a Receita.'}
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-300 mb-4 leading-relaxed">
                A empresa é do Simples Nacional. O Sequência não consegue ver se ela optou pelo regime regular de IBS/CBS (híbrido): nem a nota (o CRT continua 1 ou 2) nem a Receita informam isso. A resposta muda o crédito de compras e o IBS/CBS das vendas, e já sai fechada no relatório.
              </p>
              <div className="space-y-2 mb-4">
                {([
                  ['puro', 'Dentro do DAS, como hoje (Simples puro)', 'IBS/CBS seguem na guia única; a empresa não toma crédito cheio das compras.'],
                  ['hibrido', 'Por fora do DAS, no regime regular (híbrido)', 'A empresa optou — ou vai optar — pelo regime regular: débito nas vendas e crédito nas compras.'],
                  ['duvida', 'Ainda não sei — mostrar as duas hipóteses', 'O relatório traz um quadro "se for puro × se for híbrido" com os valores lado a lado.'],
                ] as ['puro' | 'hibrido' | 'duvida', string, string][]).map(([k, titulo, desc]) => (
                  <label
                    key={k}
                    className={cn('flex items-start gap-3 p-3 border cursor-pointer transition-colors', modoSimplesEscolhido === k ? 'border-slate-800 dark:border-slate-200 bg-slate-50 dark:bg-slate-800' : 'border-slate-200 dark:border-slate-700 hover:border-slate-400')}
                  >
                    <input type="radio" name="modoSimples" className="mt-1" checked={modoSimplesEscolhido === k} onChange={() => setModoSimplesEscolhido(k)} />
                    <span>
                      <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{titulo}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">{desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mb-4 leading-relaxed">
                Pergunta pronta ao cliente: "Você optou pelo regime regular de IBS e CBS, por fora do DAS?" A opção é feita no Portal do Simples Nacional, por semestre — confira a janela vigente. Dá para trocar a resposta depois, dentro do relatório.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmaSimples(null)}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-slate-400 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => { const modo = modoSimplesEscolhido; setConfirmaSimples(null); exportarRelatorioAlertasHtml({ modoSimples: modo }); }}
                  className="px-4 py-2 text-sm font-semibold text-white transition-colors"
                  style={{background: '#17150F'}}
                >
                  Gerar Perfil do Cliente
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Auditoria de Regime Modal */}
      <AnimatePresence>
        {showAuditoriaRegime && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] backdrop-blur-sm flex items-center justify-center p-6"
            style={{background: 'rgba(10,14,35,0.6)'}}
            onClick={() => setShowAuditoriaRegime(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              onClick={e => e.stopPropagation()}
              className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6"
            >
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-serif text-base font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <Search className="w-4 h-4 text-blue-500" />
                  Auditoria de Regime — Evidências
                </h3>
                <button onClick={() => setShowAuditoriaRegime(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                O badge de Regime vem só do que a própria nota autodeclara (campo CRT) — não é uma consulta independente à Receita Federal. Use essas evidências pra confrontar com o cadastro oficial do cliente.
              </p>

              {auditoriaRegime.totalNotas === 0 ? (
                <div className="text-sm text-slate-500 dark:text-slate-400">Sem notas de saída válidas nesse período pra auditar o regime.</div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Regime predominante</div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100 mt-0.5">{auditoriaRegime.crtPredominanteLabel} (CRT={auditoriaRegime.crtPredominante})</div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Notas analisadas</div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100 mt-0.5">{auditoriaRegime.totalNotas}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Declaração por CRT ao longo do período</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                            <th className="py-1.5 pr-3">CRT</th>
                            <th className="py-1.5 pr-3">Regime declarado</th>
                            <th className="py-1.5 pr-3 text-right">Notas</th>
                            <th className="py-1.5 pr-3">De</th>
                            <th className="py-1.5">Até</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditoriaRegime.crtCounts.map(c => (
                            <tr key={c.crt} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                              <td className="py-1.5 pr-3 font-mono font-bold text-slate-700 dark:text-slate-300">{c.crt}</td>
                              <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">{c.label}</td>
                              <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{c.qtd}</td>
                              <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{c.primeira}</td>
                              <td className="py-1.5 text-slate-600 dark:text-slate-400">{c.ultima}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {auditoriaRegime.mudouNoPeriodo ? (
                      <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        ⚠ O CRT declarado mudou dentro desse período — pode ser uma transição de regime de verdade ou uma correção no sistema de emissão. Confira as datas de corte acima contra o cadastro oficial do cliente.
                      </div>
                    ) : auditoriaRegime.semCrt.length > 0 ? (
                      <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        ⚠ {auditoriaRegime.crtCounts[0]?.qtd} de {auditoriaRegime.totalNotas} nota(s) ({formatarPct(auditoriaRegime.pctPredominante)}%) declaram CRT={auditoriaRegime.crtPredominante} — as outras {auditoriaRegime.semCrt.length} não trazem o campo CRT no XML (veja a amostra abaixo). Os XMLs deveriam seguir um padrão único; confirme com o cliente/sistema por que essas notas saíram diferentes.
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                        ✓ {auditoriaRegime.crtCounts[0]?.qtd} de {auditoriaRegime.totalNotas} nota(s) ({formatarPct(auditoriaRegime.pctPredominante)}%) declaram o mesmo CRT de forma consistente nesse período — não é uma nota isolada, é sistemático.
                      </div>
                    )}
                  </div>

                  {auditoriaRegime.semCrt.length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-2">Notas sem CRT declarado ({auditoriaRegime.semCrt.length})</div>
                      <div className="overflow-x-auto max-h-40 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                              <th className="py-1.5 pr-3">Série</th>
                              <th className="py-1.5 pr-3">Nº</th>
                              <th className="py-1.5 pr-3">Data</th>
                              <th className="py-1.5">Baixar</th>
                            </tr>
                          </thead>
                          <tbody>
                            {auditoriaRegime.semCrt.slice(0, 20).map((n, i) => (
                              <tr key={n.chave || i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.serie}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.numero}</td>
                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td className="py-1.5">
                                  <button
                                    onClick={() => baixarXmlEvidencia(n)}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                  >
                                    <Download className="w-3 h-3" />
                                    XML
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {auditoriaRegime.semCrt.length > 20 && (
                          <p className="text-[11px] text-slate-400 mt-1.5">Mostrando 20 de {auditoriaRegime.semCrt.length}.</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className={cn(
                    "rounded-lg px-3 py-2.5 text-[11px]",
                    auditoriaRegime.consistente
                      ? "bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                      : "bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                  )}>
                    {auditoriaRegime.consistente
                      ? '✓ O cálculo de ICMS item a item (CSOSN vs CST) é consistente com o CRT declarado em todas as notas — não há inconsistência técnica interna.'
                      : `⚠ ${auditoriaRegime.inconsistencias.length} nota(s) têm o cálculo de ICMS (CSOSN/CST) divergente do CRT declarado — veja a amostra abaixo.`}
                  </div>

                  {auditoriaRegime.inconsistencias.length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider mb-2">Notas com CRT x CSOSN/CST divergente</div>
                      <div className="overflow-x-auto max-h-40 overflow-y-auto">
                        <table className="w-full text-xs">
                          <tbody>
                            {auditoriaRegime.inconsistencias.slice(0, 20).map((inc, i) => (
                              <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">Série {inc.xml.serie}, Nº {inc.xml.numero}</td>
                                <td className="py-1.5 text-rose-600 dark:text-rose-400">{inc.motivo}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Amostra pra levantar prova — baixe o XML de uma nota de cada CRT encontrado</div>
                    <input
                      type="text"
                      value={auditoriaRegimeBusca}
                      onChange={e => setAuditoriaRegimeBusca(e.target.value)}
                      placeholder="Buscar por número ou série..."
                      className="w-full max-w-xs mb-2 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                    />
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                            <th className="py-1.5 pr-3">Série</th>
                            <th className="py-1.5 pr-3">Nº</th>
                            <th className="py-1.5 pr-3">Data</th>
                            <th className="py-1.5 pr-3">Valor</th>
                            <th className="py-1.5">Baixar</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditoriaRegime.amostra
                            .filter(n => {
                              const q = auditoriaRegimeBusca.trim().toLowerCase();
                              if (!q) return true;
                              return (n.numero || '').toLowerCase().includes(q) || (n.serie || '').toLowerCase().includes(q);
                            })
                            .map((n, i) => (
                              <tr key={n.chave || i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.serie}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.numero}</td>
                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td className="py-1.5 pr-3 font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(n.valor || '0') || 0)}</td>
                                <td className="py-1.5">
                                  <button
                                    onClick={() => baixarXmlEvidencia(n)}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                  >
                                    <Download className="w-3 h-3" />
                                    XML
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {auditoriaCst.totalItens > 0 && (
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                      <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                        Situação Tributária do ICMS (CST/CSOSN) — {auditoriaCst.totalItens} item(ns) em {auditoriaCst.totalNotas} nota(s)
                      </div>
                      <div className="overflow-x-auto max-h-48 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-white dark:bg-slate-900">
                            <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                              <th className="py-1.5 pr-3">Código</th>
                              <th className="py-1.5 pr-3">Descrição oficial</th>
                              <th className="py-1.5 pr-3 text-right">Itens</th>
                              <th className="py-1.5 pr-3 text-right">Valor</th>
                              <th className="py-1.5 pr-3 text-right">%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {auditoriaCst.usos.map(u => (
                              <tr key={u.codigo} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-mono font-bold text-slate-700 dark:text-slate-300">{u.codigo}</td>
                                <td className={cn("py-1.5 pr-3", u.conhecido ? "text-slate-600 dark:text-slate-400" : "text-rose-600 dark:text-rose-400 font-semibold")}>{u.descricao}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600 dark:text-slate-400">{u.qtdItens}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(u.valor)}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">{formatarPct(u.pct)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className={cn(
                        "mt-2 rounded-lg px-3 py-2.5 text-[11px]",
                        auditoriaCst.problemas.length === 0
                          ? "bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                          : "bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                      )}>
                        {auditoriaCst.problemas.length === 0
                          ? '✓ Nenhum item com ICMS destacado onde o código não permite, e a conta vBC × pICMS bate com o vICMS declarado em todos os itens conferíveis.'
                          : `⚠ ${auditoriaCst.problemas.length} item(ns) com problema no ICMS declarado — veja abaixo.`}
                      </div>

                      {auditoriaCst.problemas.length > 0 && (
                        <div className="overflow-x-auto max-h-40 overflow-y-auto mt-2">
                          <table className="w-full text-xs">
                            <tbody>
                              {auditoriaCst.problemas.slice(0, 20).map((p, i) => (
                                <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                  <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">Série {p.xml.serie}, Nº {p.xml.numero}</td>
                                  <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.xProd}</td>
                                  <td className="py-1.5 text-rose-600 dark:text-rose-400">
                                    {p.tipo === 'destacado_indevido'
                                      ? <>CST/CSOSN {p.codigo} ({CST_ICMS_DESCRICOES[p.codigo]?.descricao}) não deveria ter ICMS destacado, mas o item traz vICMS = {formatarMoeda(p.vICMS)}</>
                                      : <>CST/CSOSN {p.codigo}: vBC ({formatarMoeda(p.vBC || 0)}) × {p.pICMS}% = {formatarMoeda(p.esperado || 0)}, mas o item declara vICMS = {formatarMoeda(p.vICMS)}</>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {auditoriaCst.problemas.length > 20 && (
                            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">Mostrando 20 de {auditoriaCst.problemas.length}.</p>
                          )}
                        </div>
                      )}
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                        Checagem estrutural direto do layout oficial da NF-e — não avalia se o código escolhido é o adequado pro produto/operação (isso exigiria interpretar a natureza da venda, o que é fase 2, não feita aqui).
                      </p>
                    </div>
                  )}

                  {responsavelTecnico.email && (
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
                      Responsável técnico do sistema (XML): {responsavelTecnico.contato && <>{responsavelTecnico.contato} · </>}{responsavelTecnico.email}{responsavelTecnico.foneFormatado && <> · {responsavelTecnico.foneFormatado}</>}{responsavelTecnico.cnpjFormatado && <> · CNPJ {responsavelTecnico.cnpjFormatado}</>}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="text-white relative print:shadow-none" style={{background: '#17150F', boxShadow: '0 12px 32px -12px rgba(23,21,15,0.45)'}}>
        <div className="absolute inset-x-0 bottom-0 h-[3px] print:hidden" style={{background: 'linear-gradient(90deg, transparent, #C9A227 20%, #C9A227 80%, transparent)'}} />
        <div className="max-w-[1920px] mx-auto px-6 pt-8 pb-14 print:px-4 print:py-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex items-center gap-5 print:gap-4">
            <img
              src="/logo-sf.png"
              alt="Contador de Padarias"
              className="h-16 print:h-14 object-contain select-none"
              onClick={() => setMapaFiscalDesbloqueado(v => !v)}
            />
            <div className="hidden md:block w-px h-12 print:h-10 bg-white/15" />
            <div>
              <h1 className="font-serif text-3xl print:text-2xl font-semibold tracking-tight text-white mb-0.5 print:mb-0.5 flex items-center gap-2.5">Sequência Fiscal{new Date().getMonth() === 9 && <LacoRosa className="w-10 h-10 -my-3 shrink-0 -rotate-[14deg]" />}</h1>
              <p className="font-medium text-[0.95rem] print:text-sm" style={{color: 'rgba(201,162,39,0.8)'}}>Auditoria de Sequência de Vendas e Saídas</p>
            </div>
          </div>

          {analysis && (
            <div className="flex flex-col items-end gap-3 no-print">
              <div className="flex items-center gap-3 no-print">
                <ThemeToggle />
                <button
                  onClick={abrirPerfilCliente}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all shrink-0"
                  style={{background: 'rgba(201,162,39,0.18)', border: '1px solid rgba(201,162,39,0.5)', color: '#C9A227'}}
                  title="Baixa o perfil do cliente em HTML (clientes, fornecedores, produtos, sazonalidade e Reforma Tributária: regime, créditos e simulação) — tópicos expansíveis, pra orientar o cliente"
                >
                  <Users className="w-4 h-4" />
                  Perfil do Cliente
                </button>
                <button
                  onClick={reset}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-bold transition-all shrink-0"
                  style={{background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(201,162,39,0.35)'}}
                >
                  <FileSearch className="w-4 h-4" />
                  Nova Análise
                </button>
              </div>
              {analysis.length > 0 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="backdrop-blur-md rounded-xl p-5 flex flex-col gap-1 min-w-[360px] shadow-2xl"
                style={{background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(201,162,39,0.2)'}}
              >
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Empresa:</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-white font-bold text-base truncate min-w-0">{analysis[0].razaoSocial}</span>
                    <button
                      onClick={() => copiarCampoHeader('empresa', analysis[0].razaoSocial)}
                      className="shrink-0 transition-colors"
                      style={{color: copiedHeaderField === 'empresa' ? '#C9A227' : 'rgba(255,255,255,0.3)'}}
                      title="Copiar nome completo da empresa"
                    >
                      {copiedHeaderField === 'empresa' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>CNPJ:</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-base" style={{color: 'rgba(255,255,255,0.85)'}}>{analysis[0].cnpj}</span>
                    <button
                      onClick={() => copiarCampoHeader('cnpj', analysis[0].cnpj)}
                      className="shrink-0 transition-colors"
                      style={{color: copiedHeaderField === 'cnpj' ? '#C9A227' : 'rgba(255,255,255,0.3)'}}
                      title="Copiar CNPJ"
                    >
                      {copiedHeaderField === 'cnpj' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>IE:</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-base" style={{color: 'rgba(255,255,255,0.85)'}}>{analysis[0].ie}</span>
                    <button
                      onClick={() => copiarCampoHeader('ie', analysis[0].ie)}
                      className="shrink-0 transition-colors"
                      style={{color: copiedHeaderField === 'ie' ? '#C9A227' : 'rgba(255,255,255,0.3)'}}
                      title="Copiar Inscrição Estadual"
                    >
                      {copiedHeaderField === 'ie' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Meses:</span>
                  <div className="min-w-0 overflow-x-auto whitespace-nowrap font-bold text-sm leading-snug pb-0.5" style={{color: '#C9A227'}} title={mesesDisponiveis.join(', ')}>
                    {mesesDisponiveis.length === 0 ? 'N/A' : mesesDisponiveis.join(', ')}
                  </div>

                  {regimeTributario.label && (
                    <>
                      <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Regime:</span>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-flex items-center w-fit px-2.5 py-0.5 rounded-full text-xs font-bold"
                          style={(regimeTributario.isSimples || regimeTributario.isMei)
                            ? {background: 'rgba(201,162,39,0.15)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.35)'}
                            : {background: 'rgba(148,163,184,0.15)', color: '#CBD5E1', border: '1px solid rgba(148,163,184,0.3)'}}
                        >
                          {regimeTributario.label}
                        </span>
                        {auditoriaRegime.temAlerta && (
                          <AlertTriangle
                            className="w-3.5 h-3.5 shrink-0"
                            style={{color: '#F87171'}}
                            title={`Atenção: ${auditoriaRegime.semCrt.length > 0 ? `${auditoriaRegime.semCrt.length} nota(s) sem CRT declarado` : ''}${auditoriaRegime.semCrt.length > 0 && auditoriaRegime.mudouNoPeriodo ? ' e ' : ''}${auditoriaRegime.mudouNoPeriodo ? 'o CRT declarado mudou dentro do período' : ''} — só ${formatarPct(auditoriaRegime.pctPredominante)}% das notas confirmam o regime predominante. Veja a Auditoria de Regime.`}
                          />
                        )}
                        <button
                          onClick={() => setShowAuditoriaRegime(true)}
                          className="shrink-0 transition-colors no-print"
                          style={{color: 'rgba(255,255,255,0.3)'}}
                          title="Auditoria de Regime — ver evidências (CRT, consistência CSOSN/CST, amostra de nota)"
                        >
                          <Search className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}

                  <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Receita Federal:</span>
                  <div className="flex items-center gap-2 flex-wrap no-print">
                    {receitaConsultaStatus === 'idle' && !receitaConsulta && (
                      <button
                        onClick={() => mainCnpj && consultarSituacaoReceita(mainCnpj)}
                        className="text-xs font-bold underline transition-colors"
                        style={{color: '#C9A227'}}
                      >
                        Consultar situação (BrasilAPI)
                      </button>
                    )}
                    {receitaConsultaStatus === 'loading' && (
                      <span className="flex items-center gap-1.5 text-xs" style={{color: 'rgba(255,255,255,0.6)'}}>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Consultando...
                      </span>
                    )}
                    {receitaConsultaStatus === 'erro' && (
                      <span className="flex items-center gap-1.5 text-xs" style={{color: '#F87171'}}>
                        <AlertCircle className="w-3.5 h-3.5" /> Falha ao consultar
                        <button onClick={() => mainCnpj && consultarSituacaoReceita(mainCnpj)} className="underline font-bold">tentar de novo</button>
                      </span>
                    )}
                    {receitaConsulta && (
                      <>
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold"
                          style={receitaConsulta.situacao === 'ATIVA'
                            ? {background: 'rgba(34,197,94,0.15)', color: '#4ADE80', border: '1px solid rgba(34,197,94,0.35)'}
                            : {background: 'rgba(248,113,113,0.15)', color: '#F87171', border: '1px solid rgba(248,113,113,0.35)'}}
                        >
                          {receitaConsulta.situacao}
                        </span>
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold"
                          style={{background: 'rgba(148,163,184,0.15)', color: '#CBD5E1', border: '1px solid rgba(148,163,184,0.3)'}}
                        >
                          {receitaConsulta.opcaoMei ? 'MEI' : receitaConsulta.opcaoSimples ? 'Optante Simples' : 'Não optante Simples'}
                        </span>
                        {((regimeTributario.isSimples && !receitaConsulta.opcaoSimples && !receitaConsulta.opcaoMei) ||
                          (!regimeTributario.isSimples && !regimeTributario.isMei && (receitaConsulta.opcaoSimples || receitaConsulta.opcaoMei))) && (
                          <AlertTriangle
                            className="w-3.5 h-3.5 shrink-0"
                            style={{color: '#F87171'}}
                            title={`Atenção: as notas declaram CRT de ${regimeTributario.label || 'regime não identificado'}, mas a Receita mostra ${receitaConsulta.opcaoMei ? 'MEI' : receitaConsulta.opcaoSimples ? 'optante do Simples' : 'não optante do Simples'} agora. Pode ser mudança de regime dentro do período — confira as datas.`}
                          />
                        )}
                        <span className="text-[10px]" style={{color: 'rgba(255,255,255,0.35)'}} title={`Consultado em ${receitaConsulta.dataConsulta} via api.brasilapi.com.br — dados públicos da Receita Federal`}>
                          (consultado agora)
                        </span>
                      </>
                    )}
                  </div>

                </div>
              </motion.div>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-[1920px] mx-auto px-6 lg:px-8 pb-6 lg:pb-8 -mt-8 relative z-10 no-print flex-1 w-full">
        {extractionErrors.length > 0 && (
          <div className="bg-white dark:bg-slate-900 border border-rose-300 dark:border-rose-800 border-l-4 border-l-rose-500 rounded-xl p-5 mb-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-rose-700 dark:text-rose-300">
                  {extractionErrors.length} arquivo(s) não puderam ser lidos completamente
                </div>
                <div className="text-xs text-rose-600 dark:text-rose-400 mt-0.5 mb-2">
                  Pode haver notas fiscais faltando na análise abaixo por causa disso. RAR muito grande/aninhado esbarra num limite de memória do navegador que não dá pra garantir 100% — a forma confiável de resolver é <strong>você mesmo extrair esse RAR no seu computador (WinRAR ou 7-Zip) e anexar os arquivos ZIP de dentro dele diretamente</strong>, sem o RAR. Assim a extração não depende mais desse limite.
                </div>
                <ul className="space-y-1">
                  {extractionErrors.map((err, i) => (
                    <li key={i} className="text-xs font-mono text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2 break-words">
                      <div>{err.msg}</div>
                      {err.downloadUrl && (
                        <a
                          href={err.downloadUrl}
                          download={err.downloadName || 'arquivo-original'}
                          className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg font-sans font-bold text-[11px] no-underline text-white"
                          style={{background: '#17150F'}}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Baixar arquivo original ({err.downloadName})
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                onClick={() => setExtractionErrors([])}
                className="text-rose-400 hover:text-rose-600 shrink-0"
                title="Dispensar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        <AnimatePresence>
          {!analysis ? (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {/* Stats Summary - Now at the top for better visibility */}
              {stats.totalFiles > 0 && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white rounded-2xl border border-slate-200 overflow-hidden"
                >
                  <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h4 className="font-bold text-slate-800 flex items-center gap-2">
                      <BarChart3 className="w-5 h-5 text-blue-600" />
                      Resumo do Carregamento
                    </h4>
                    {isProcessing && (
                      <span className="text-sm text-blue-600 font-medium animate-pulse">
                        Processando {processingProgress.current} de {processingProgress.total}...
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-slate-100">
                    <div className="p-6 text-center">
                      <div className="text-3xl font-bold text-slate-900">{stats.totalXmls}</div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-1">Total XMLs Anexados</div>
                    </div>
                    <div className="p-6 text-center bg-slate-50/30">
                      <div className="text-3xl font-bold text-slate-400">{stats.nonXmlCount}</div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-1">Não-XML</div>
                    </div>
                    <div className="p-6 text-center">
                      <div className="text-xl font-bold text-emerald-600 truncate">{formatarMoeda(faturamentoTotal)}</div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-1">Total de Saídas Estimado</div>
                    </div>
                    <div className="p-6 text-center bg-slate-50/30">
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {periodoAnalise.inicio ? `${periodoAnalise.inicio} a ${periodoAnalise.fim}` : 'N/A'}
                      </div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-1">Período Detectado</div>
                    </div>
                  </div>

                  {fornecedorEntradaInfo && (
                    <div className="mx-6 mb-0 mt-0 border-t border-slate-100/50 pt-4 pb-2">
                      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-blue-700 text-sm">
                        <svg className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <div>
                          <span className="font-bold">{fornecedorEntradaInfo.count} nota{fornecedorEntradaInfo.count !== 1 ? 's' : ''} de entrada de fornecedor</span> detectada{fornecedorEntradaInfo.count !== 1 ? 's' : ''} e ignorada{fornecedorEntradaInfo.count !== 1 ? 's' : ''} — o app analisa apenas saídas da empresa auditada.
                          {fornecedorEntradaInfo.nomes && <span className="text-blue-500 ml-1">({fornecedorEntradaInfo.nomes}{Object.keys(fornecedorEntradaInfo.nomes).length > 3 ? ' e outros' : ''})</span>}
                        </div>
                        <button onClick={() => setFornecedorEntradaInfo(null)} className="ml-auto shrink-0 text-blue-400 hover:text-blue-600" title="Fechar">✕</button>
                      </div>
                    </div>
                  )}

                  {spedData && spedCrossRef && (
                    <SpedValidationPanel
                      spedData={spedData}
                      crossRef={spedCrossRef}
                      onClose={() => setSpedEntries(prev => {
                        if (filterMes === 'Todos') return {};
                        const next = { ...prev };
                        delete next[filterMes];
                        return next;
                      })}
                    />
                  )}

                  {attachedSources.length > 0 && (
                    <div className="p-6 border-t border-slate-100/50">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Fontes Anexadas ({attachedSources.length})</div>
                      <div className="flex flex-wrap gap-2 max-h-[360px] overflow-y-auto custom-scrollbar pr-1">
                        {attachedSources.map((source, sIdx) => {
                          // Somar todos os tipos de documentos fiscais identificados nesta fonte
                          const countNfe = xmlList.filter(x => x.sourceName === source.name).length;
                          const countInut = inutilizacoes.filter(x => x.sourceName === source.name).length;
                          const countOther = otherXmlsList.filter(x => x.sourceName === source.name).length;
                          const countNfse = nfseList.filter(x => x.sourceName === source.name).length;
                          const totalFiscalInSource = countNfe + countInut + countOther + countNfse;
                          
                          // Identificar o CNPJ da empresa auditada no lote todo
                          const cnpjCounts: Record<string, number> = {};
                          xmlList.forEach(x => {
                            if (x.emitCnpj) cnpjCounts[x.emitCnpj] = (cnpjCounts[x.emitCnpj] || 0) + 1;
                          });
                          const topCnpj = Object.entries(cnpjCounts).sort((a,b) => b[1] - a[1])[0]?.[0];

                          let status: 'awaiting' | 'sales' | 'purchases' | 'mixed' = 'awaiting';
                          if (countNfe > 0 && topCnpj) {
                            const sourceXmls = xmlList.filter(x => x.sourceName === source.name);
                            const hasSaida = sourceXmls.some(x => {
                              if (x.tpNF === '1') return true;
                              if (x.tpNF === '0') return false;
                              return x.emitCnpj === topCnpj;
                            });
                            const hasEntrada = sourceXmls.some(x => {
                              if (x.tpNF === '0') return true;
                              if (x.tpNF === '1') return false;
                              return x.destCnpj === topCnpj;
                            });
                            
                            if (hasSaida && hasEntrada) status = 'mixed';
                            else if (hasSaida) status = 'sales';
                            else if (hasEntrada) status = 'purchases';
                          }

                          return (
                            <div 
                              key={sIdx}
                              className="group flex items-center gap-2 bg-white border border-slate-200 px-3 py-1.5 rounded-lg text-xs font-bold transition-all hover:border-blue-300"
                            >
                              {source.isZip ? (
                                <FileText className="w-3 h-3 text-blue-500" />
                              ) : (
                                <FolderOpen className="w-3 h-3 text-blue-500" />
                              )}
                              <span className="text-slate-700">{source.name}</span>
                              <div className="flex items-center gap-1.5 ml-1">
                                <span className="bg-slate-50 text-slate-400 px-1.5 py-0.5 rounded text-[9px] border border-slate-100">
                                  {totalFiscalInSource} XMLs
                                </span>
                                
                                {(source as any).error ? (
                                  <span className="bg-rose-50 text-rose-600 px-1.5 py-0.5 rounded text-[9px] border border-rose-100 flex items-center gap-1">
                                    <AlertCircle className="w-2.5 h-2.5" />
                                    {(source as any).errorMsg || 'Erro'}
                                  </span>
                                ) : (
                                  <>
                                    {status === 'sales' && (
                                      <span className="bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded text-[9px] border border-emerald-100">
                                        Vendas
                                      </span>
                                    )}
                                    {status === 'purchases' && (
                                      <span className="bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded text-[9px] border border-amber-100">
                                        Compras - Ignorada
                                      </span>
                                    )}
                                    {status === 'mixed' && (
                                      <span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[9px] border border-blue-100">
                                        Misto
                                      </span>
                                    )}
                                    {status === 'awaiting' && (
                                      <span className="bg-slate-50 text-slate-400 px-1.5 py-0.5 rounded text-[9px] border border-slate-100">
                                        Pronto
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}



                  <div className="p-10 bg-slate-50 flex flex-col items-center gap-6 border-t border-slate-100">
                    <div className="flex gap-4">
                      <button
                        onClick={runAnalysis}
                        disabled={xmlList.length === 0 && nfseList.length === 0}
                        className="flex items-center gap-2 px-10 py-5 text-white rounded-xl font-bold text-xl transition-all shadow-lg disabled:opacity-50 disabled:grayscale scale-105 active:scale-100"
                      style={{background: '#17150F', boxShadow: '0 8px 32px rgba(23,21,15,0.4)'}}
                      >
                        <CheckCircle2 className="w-7 h-7" />
                        Iniciar Auditoria Agora
                      </button>
                      <button 
                        onClick={reset}
                        className="flex items-center gap-2 px-8 py-5 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all active:scale-95"
                      >
                        <Trash2 className="w-5 h-5" />
                        Limpar
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Upload Area - Now becomes smaller if data is present */}
              <div
                className={cn(
                  "relative group bg-white dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-2xl transition-all duration-500",
                  stats.totalFiles > 0 ? "p-8 opacity-60 hover:opacity-100" : "p-12 text-center",
                  "hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-950/30 cursor-pointer"
                )}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-blue-500', 'bg-blue-50'); }}
                onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50'); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50');
                  
                  const items = e.dataTransfer.items;
                  if (items) {
                    const entries: FileSystemEntry[] = [];
                    for (let i = 0; i < items.length; i++) {
                      const item = items[i].webkitGetAsEntry();
                      if (item) {
                        entries.push(item);
                      }
                    }
                    
                    const allFiles: File[] = [];
                    for (const entry of entries) {
                      const files = await traverseFileTree(entry);
                      allFiles.push(...files);
                    }
                    handleFiles(allFiles);
                  } else {
                    handleFiles(e.dataTransfer.files);
                  }
                }}
              >
                <div className={cn(
                  "flex items-center gap-6",
                  stats.totalFiles === 0 ? "flex-col text-center" : "justify-between"
                )}>
                  <div className={cn(
                    "flex items-center gap-6",
                    stats.totalFiles === 0 && "flex-col"
                  )}>
                    <div className={cn(
                      "p-5 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-400 dark:text-slate-500 group-hover:text-blue-500 group-hover:bg-blue-100 dark:group-hover:bg-blue-950 transition-colors",
                      stats.totalFiles > 0 && "scale-75"
                    )}>
                      <Upload className="w-8 h-8" />
                    </div>
                    <div className={stats.totalFiles === 0 ? "text-center" : "text-left"}>
                      <h3 className={cn(
                        "font-bold text-slate-800 dark:text-slate-100",
                        stats.totalFiles === 0 ? "text-xl" : "text-lg"
                      )}>
                        {stats.totalFiles === 0 ? "Arraste seus arquivos aqui" : "Deseja adicionar mais arquivos?"}
                      </h3>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Suporta XMLs individuais, pastas ou arquivos ZIP</p>
                  </div>
                </div>

                {extractionStatus && (
                  <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 px-6 py-3 rounded-xl border border-emerald-100 dark:border-emerald-900 animate-pulse mb-6">
                    <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-bounce"></div>
                    <span className="text-sm font-black uppercase tracking-wider">{extractionStatus}</span>
                  </div>
                )}
                
                <div className="flex flex-col items-center">
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-3 px-10 py-5 text-white rounded-xl font-bold transition-all active:scale-95 hover:scale-[1.02] shadow-xl"
                      style={{background: '#17150F'}}
                    >
                      <Upload className="w-6 h-6 text-blue-400" />
                      Anexar Arquivos (ZIP ou XMLs)
                    </button>
                    <p className="text-[10px] font-medium text-slate-400 mt-4 uppercase tracking-[0.2em] select-none">
                      Arraste pastas aqui se preferir
                    </p>
                  </div>
                </div>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  multiple 
                  accept=".xml,.zip,.rar" 
                  className="hidden" 
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                />
                <input 
                  type="file" 
                  ref={folderInputRef} 
                  // @ts-ignore
                  webkitdirectory="" 
                  directory="" 
                  multiple 
                  className="hidden" 
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col gap-6"
            >
              {/* Faixa de métricas — visão geral, encosta na base do header */}
              <div className="flex flex-wrap gap-6 items-stretch">
                <div
                  onClick={() => breakdownPorCfop.length > 0 && setShowCfopBreakdown(!showCfopBreakdown)}
                  onKeyDown={e => { if (breakdownPorCfop.length > 0 && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setShowCfopBreakdown(!showCfopBreakdown); } }}
                  role={breakdownPorCfop.length > 0 ? 'button' : undefined}
                  tabIndex={breakdownPorCfop.length > 0 ? 0 : undefined}
                  className={cn(
                    "group flex-1 min-w-[260px] bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-700",
                    breakdownPorCfop.length > 0 && "cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                  )}
                >
                  <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Total de Saídas Auditadas (Válidas)</div>
                  <div className="text-3xl font-bold text-emerald-600 dark:text-emerald-400 mt-2">
                    {formatarMoeda(faturamentoTotal)}
                  </div>
                  {breakdownPorCfop.length > 0 && (
                    <div title="Ver totais por natureza (CFOP)" className="inline-flex items-center justify-center mt-3 no-print">
                      <ChevronRight className={cn("w-6 h-6 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 transition-all duration-300", showCfopBreakdown && "rotate-90")} />
                    </div>
                  )}
                </div>

                {(() => {
                  const faltantesLiquidos = analysis.reduce((acc, s) => acc + s.faltantes.length, 0);
                  const totalManual = analysis.reduce((acc, s) => acc + s.faltantesInutilizadosManual.length, 0);
                  const faltantesBrutos = faltantesLiquidos + totalManual;

                  const tilePad = totalManual > 0 ? "p-3" : "p-6";
                  const tileLabel = cn("font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide", totalManual > 0 ? "text-[10px] leading-tight" : "text-sm");
                  const tileNumber = totalManual > 0 ? "text-2xl mt-1" : "text-4xl mt-2";

                  return (
                    <div className={cn("bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden", totalManual > 0 ? "flex-[2] min-w-[640px]" : "flex-[2] min-w-[420px]")}>
                      <div className={cn(
                        "grid grid-cols-2 h-full divide-y divide-slate-100 dark:divide-slate-800 md:divide-y-0 md:divide-x",
                        totalManual > 0 ? "md:grid-cols-3 lg:grid-cols-6" : "md:grid-cols-4"
                      )}>
                        <div className={tilePad}>
                          <div className={tileLabel}>Séries</div>
                          <div className={cn("font-bold text-slate-900 dark:text-slate-100", tileNumber)}>{analysis.length}</div>
                        </div>
                        <div className={tilePad}>
                          <div className={tileLabel}>Com Quebra</div>
                          <div className={cn("font-bold text-amber-500 dark:text-amber-400", tileNumber)}>
                            {analysis.filter(s => s.faltantes.length > 0).length}
                          </div>
                        </div>
                        {totalManual > 0 ? (
                          <>
                            <div className={cn(tilePad, "no-print")}>
                              <div className={tileLabel}>Faltante Bruto</div>
                              <div className={cn("font-bold text-rose-600 dark:text-rose-400", tileNumber)}>{faltantesBrutos}</div>
                            </div>
                            <div className={cn(tilePad, "bg-amber-50/50 dark:bg-amber-950/20 no-print")}>
                              <div className={tileLabel}>Inutilizadas</div>
                              <div className={cn("font-bold text-amber-600 dark:text-amber-400", tileNumber)}>{totalManual}</div>
                            </div>
                            <div className={tilePad}>
                              <div className={tileLabel}>Faltante Líquido</div>
                              <div className={cn("font-bold text-slate-500 dark:text-slate-400", tileNumber)}>{faltantesLiquidos}</div>
                            </div>
                          </>
                        ) : (
                          <div className={tilePad}>
                            <div className={tileLabel}>Total Faltantes</div>
                            <div className={cn("font-bold text-rose-600 dark:text-rose-400", tileNumber)}>{faltantesLiquidos}</div>
                          </div>
                        )}
                        <div className={tilePad}>
                          <div className={tileLabel}>Total Recebidos</div>
                          <div className={cn("font-bold text-blue-600 dark:text-blue-400", tileNumber)}>
                            {analysis.reduce((acc, s) => acc + s.recebidos, 0)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {auditoriaIbsCbs.totalNotas > 0 && (() => {
                  const corIbsCbs = auditoriaIbsCbs.pctComGrupo === 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : auditoriaIbsCbs.pctComGrupo === 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400';
                  return (
                    <div
                      onClick={() => { setShowAuditoriaIbsCbs(!showAuditoriaIbsCbs); setShowAuditoriaPagamento(false); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAuditoriaIbsCbs(!showAuditoriaIbsCbs); setShowAuditoriaPagamento(false); } }}
                      role="button"
                      tabIndex={0}
                      title="Ver auditoria de IBS/CBS (Reforma Tributária)"
                      className="group flex-1 min-w-[200px] bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                          <Receipt className="w-3.5 h-3.5" />
                          IBS/CBS
                        </div>
                        <div className="inline-flex items-center justify-center no-print">
                          <ChevronRight className={cn("w-6 h-6 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 transition-all duration-300", showAuditoriaIbsCbs && "rotate-90")} />
                        </div>
                      </div>
                      <div className={cn("text-3xl font-bold mt-2", corIbsCbs)}>{formatarPct(auditoriaIbsCbs.pctComGrupo)}%</div>
                      <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 mt-1">
                        {auditoriaIbsCbs.notasComGrupo} de {auditoriaIbsCbs.totalNotas} nota(s) com o grupo IBS/CBS
                      </div>
                    </div>
                  );
                })()}

                {(auditoriaPagamento.totalCartao > 0 || auditoriaPagamento.totalCartaoNaoAplicavel > 0 || auditoriaPagamento.problemas.length > 0 || auditoriaPagamento.breakdownPorTipoPagamento.length > 0) && (() => {
                  // Sem Math.round: 464/466 arredondaria pra "100%" e escondia os 2
                  // POS manual (mesmo bug já corrigido no card de IBS/CBS).
                  const pctIntegradoResumo = auditoriaPagamento.totalCartao > 0
                    ? (auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100
                    : 0;
                  const pctNaoIntegradoResumo = auditoriaPagamento.totalCartao > 0
                    ? (auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100
                    : 0;
                  const temProblemasTecnicos = auditoriaPagamento.problemas.length > 0;
                  const riscoObrigatoriedade = !regimeTributario.isSimples && !regimeTributario.isMei && regimeTributario.label !== null && auditoriaPagamento.totalNaoIntegrado > 0;
                  const corTef = temProblemasTecnicos || riscoObrigatoriedade
                    ? 'text-rose-600 dark:text-rose-400'
                    : pctNaoIntegradoResumo >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
                  return (
                    <div
                      onClick={() => { setShowAuditoriaPagamento(!showAuditoriaPagamento); setShowAuditoriaIbsCbs(false); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAuditoriaPagamento(!showAuditoriaPagamento); setShowAuditoriaIbsCbs(false); } }}
                      role="button"
                      tabIndex={0}
                      title="Ver auditoria de pagamento (TEF)"
                      className="group flex-1 min-w-[200px] bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                          <CreditCard className="w-3.5 h-3.5" />
                          TEF
                        </div>
                        <div className="inline-flex items-center justify-center no-print">
                          <ChevronRight className={cn("w-6 h-6 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 transition-all duration-300", showAuditoriaPagamento && "rotate-90")} />
                        </div>
                      </div>
                      <div className={cn("text-3xl font-bold mt-2", corTef)}>{formatarPct(pctIntegradoResumo)}%</div>
                      <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 mt-1">
                        integrado ao TEF — {auditoriaPagamento.totalNaoIntegrado} POS manual de {auditoriaPagamento.totalCartao} sujeita(s)
                        {temProblemasTecnicos && <span className="text-rose-500 dark:text-rose-400"> · {auditoriaPagamento.problemas.length} problema(s)</span>}
                      </div>
                      {auditoriaPagamento.totalFalsoTef > 0 && (
                        <div className="text-xs font-bold text-rose-600 dark:text-rose-400 mt-1">
                          ⚠ {auditoriaPagamento.totalFalsoTef} Falso TEF
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Mapa Fiscal: usado pouco, então fica pequeno e fechado por padrão —
                  abaixo da fileira de métricas principal, não no topo da tela. */}
              {mapaFiscal && mapaFiscalDesbloqueado && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700">
                  <div className="flex items-center gap-3 px-6 py-3.5">
                    <button
                      onClick={() => setShowMapaFiscal(!showMapaFiscal)}
                      className="flex-1 flex items-center justify-between gap-3 text-left"
                    >
                      <span className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                        Mapa Fiscal
                      </span>
                      <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showMapaFiscal && "rotate-90")} />
                    </button>
                    <button
                      onClick={exportarRelatorioMapaFiscalPdf}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors shrink-0 no-print"
                      title="Abre um relatório em uma janela pra imprimir/salvar como PDF — resumo, comparativo mensal, séries por mês, ranking, NCMs, sazonalidade, devoluções e mudanças de cadastro"
                    >
                      <Download className="w-3 h-3" />
                      Exportar PDF
                    </button>
                  </div>

                  {showMapaFiscal && (
                    <div className="px-6 pb-6">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-5">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Faturamento</div>
                          <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">{formatarMoeda(mapaFiscal.faturamento)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Notas válidas</div>
                          <div className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{mapaFiscal.quantidadeNotas}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Ticket médio</div>
                          <div className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{formatarMoeda(mapaFiscal.ticketMedio)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Produtos distintos</div>
                          <div className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{mapaFiscal.produtosDistintos}</div>
                        </div>
                        {mapaFiscal.pctComGrupoIbsCbs !== null && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Com grupo IBS/CBS</div>
                            <div className={cn(
                              "text-xl font-bold mt-1",
                              mapaFiscal.pctComGrupoIbsCbs === 0 ? "text-rose-600 dark:text-rose-400" : mapaFiscal.pctComGrupoIbsCbs === 100 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                            )}>{formatarPct(mapaFiscal.pctComGrupoIbsCbs)}%</div>
                          </div>
                        )}
                        {mapaFiscal.pctConformeCclasstrib !== null && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Conformidade cClassTrib</div>
                            <div className={cn(
                              "text-xl font-bold mt-1",
                              mapaFiscal.pctConformeCclasstrib === 100 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                            )}>{formatarPct(mapaFiscal.pctConformeCclasstrib)}%</div>
                          </div>
                        )}
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Cadastros divergentes</div>
                          <div className={cn("text-xl font-bold mt-1", mapaFiscal.cadastrosDivergentes > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-800 dark:text-slate-100")}>{mapaFiscal.cadastrosDivergentes}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Produtos suspeitos</div>
                          <div className={cn("text-xl font-bold mt-1", mapaFiscal.produtosSuspeitosTotal > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-slate-100")}>{mapaFiscal.produtosSuspeitosTotal}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Devolvido</div>
                          <div className={cn("text-xl font-bold mt-1", mapaFiscal.pctDevolvido > 5 ? "text-rose-600 dark:text-rose-400" : mapaFiscal.pctDevolvido > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-800 dark:text-slate-100")} title={`${formatarMoeda(mapaFiscal.valorDevolvido)} em ${mapaFiscal.quantidadeDevolucoes} nota(s) de devolução`}>
                            {formatarPct(mapaFiscal.pctDevolvido)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Não presencial</div>
                          <div className="text-xl font-bold mt-1 text-slate-800 dark:text-slate-100">{formatarPct(mapaFiscal.pctNaoPresencial)}%</div>
                        </div>
                      </div>

                      {/* Comparativo Mensal: mês é uma sequência real, então cada célula pode
                          dizer "subiu/desceu vs. o anterior" com segurança. */}
                      {mapaFiscalPorMes.length >= 2 && (() => {
                        type ItemComparativo = {
                          chave: string; faturamento: number; quantidadeNotas: number; ticketMedio: number;
                          produtosDistintos: number; pctComGrupoIbsCbs: number; pctProducaoPropria: number;
                          pctRevenda: number; pctST: number; pctNaoPresencial: number; pctDevolvido: number;
                        };
                        type Linha = { label: string; formato: 'moeda' | 'numero' | 'pct'; valor: (m: ItemComparativo) => number };
                        const linhas: Linha[] = [
                          { label: 'Faturamento', formato: 'moeda', valor: m => m.faturamento },
                          { label: 'Notas válidas', formato: 'numero', valor: m => m.quantidadeNotas },
                          { label: 'Ticket médio', formato: 'moeda', valor: m => m.ticketMedio },
                          { label: 'Produtos distintos', formato: 'numero', valor: m => m.produtosDistintos },
                          { label: 'Com grupo IBS/CBS', formato: 'pct', valor: m => m.pctComGrupoIbsCbs },
                          { label: 'Produção própria', formato: 'pct', valor: m => m.pctProducaoPropria },
                          { label: 'Revenda', formato: 'pct', valor: m => m.pctRevenda },
                          { label: 'Sujeito a ST', formato: 'pct', valor: m => m.pctST },
                          { label: 'Não presencial', formato: 'pct', valor: m => m.pctNaoPresencial },
                          { label: 'Devolvido', formato: 'pct', valor: m => m.pctDevolvido },
                        ];
                        const formatar = (v: number, formato: string) =>
                          formato === 'moeda' ? formatarMoeda(v) : formato === 'pct' ? `${formatarPct(v)}%` : String(v);
                        const dados: ItemComparativo[] = mapaFiscalPorMes.map(m => ({ chave: m.mes, ...m }));

                        return (
                          <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                            <button
                              onClick={() => setShowComparativoMensal(!showComparativoMensal)}
                              className="w-full flex items-center justify-between gap-3 text-left"
                            >
                              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                Comparativo Mensal ({mapaFiscalPorMes.length} meses)
                              </span>
                              <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showComparativoMensal && "rotate-90")} />
                            </button>
                            {showComparativoMensal && (
                              <div className="mt-4">
                                <div className="overflow-auto max-h-[420px] border border-slate-200 dark:border-slate-800 rounded-lg">
                                  <table className="w-full text-xs">
                                    <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/60">
                                      <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-2 pr-3 pl-3 sticky left-0 bg-slate-50 dark:bg-slate-800/60">Indicador</th>
                                        {dados.map(m => (
                                          <th key={m.chave} className="py-2 pr-3 text-right whitespace-nowrap">{m.chave}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {linhas.map((l, i) => (
                                        <tr key={i} className={cn("border-b border-slate-100 dark:border-slate-800 last:border-0", i % 2 === 1 && "bg-slate-50/70 dark:bg-slate-800/20")}>
                                          <td className={cn("py-2 pr-3 pl-3 font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap sticky left-0", i % 2 === 1 ? "bg-slate-50 dark:bg-slate-900" : "bg-white dark:bg-slate-900")}>{l.label}</td>
                                          {dados.map((m, j) => {
                                            const atual = l.valor(m);
                                            const anterior = j > 0 ? l.valor(dados[j - 1]) : null;
                                            const variacao = anterior === null ? null
                                              : anterior !== 0 ? ((atual - anterior) / anterior) * 100 : (atual !== 0 ? Infinity : 0);
                                            const subiu = variacao !== null && variacao > 0.05;
                                            const desceu = variacao !== null && variacao < -0.05;
                                            return (
                                              <td key={m.chave} className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                                                <span className="text-slate-600 dark:text-slate-400">{formatar(atual, l.formato)}</span>
                                                {variacao !== null && Number.isFinite(variacao) && (
                                                  <span className={cn(
                                                    "ml-1.5 text-[10px] font-bold",
                                                    subiu ? "text-emerald-600 dark:text-emerald-400" : desceu ? "text-rose-600 dark:text-rose-400" : "text-slate-300 dark:text-slate-600"
                                                  )}>
                                                    {variacao > 0 ? '+' : ''}{formatarPct(variacao)}%
                                                  </span>
                                                )}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                                  A variação em cada célula é contra o mês anterior na mesma linha. Produção própria, revenda e ST são fatias independentes do faturamento — um item pode ser própria+ST ou revenda+ST ao mesmo tempo, então as três não precisam somar 100%. Devolvido usa o CFOP de devolução de venda (não finNFe), sobre notas de entrada emitidas pela própria empresa.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Séries por Mês: NÃO é um comparativo de métricas (isso é o card acima)
                          — é só a contagem de notas de cada série em cada mês, lado a lado, pra
                          o analista notar de cara se uma série que sempre aparecia sumiu (ou uma
                          nova apareceu) no mês mais recente. Célula zerada só é marcada como
                          "buraco" quando a série TEM movimento em algum outro mês do período —
                          senão qualquer série nova apareceria marcada nos meses antes dela existir. */}
                      {matrizSeriePorMes.series.length >= 2 && matrizSeriePorMes.meses.length >= 2 && (
                        <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                          <button
                            onClick={() => setShowComparativoSerie(!showComparativoSerie)}
                            className="w-full flex items-center justify-between gap-3 text-left"
                          >
                            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                              Séries por Mês ({matrizSeriePorMes.series.length} séries)
                            </span>
                            <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showComparativoSerie && "rotate-90")} />
                          </button>
                          {showComparativoSerie && (
                            <div className="mt-4">
                              <div className="overflow-auto max-h-[420px] border border-slate-200 dark:border-slate-800 rounded-lg">
                                <table className="w-full text-xs">
                                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/60">
                                    <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                      <th className="py-2 pr-3 pl-3 sticky left-0 bg-slate-50 dark:bg-slate-800/60">Série</th>
                                      {matrizSeriePorMes.meses.map(mes => (
                                        <th key={mes} className="py-2 pr-3 text-right whitespace-nowrap border-l border-slate-200 dark:border-slate-700">{mes}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {matrizSeriePorMes.series.map((serie, i) => {
                                      const porMes = matrizSeriePorMes.matriz.get(serie);
                                      const totalSerie = porMes
                                        ? Array.from(porMes.values() as IterableIterator<number>).reduce((s: number, q: number) => s + q, 0)
                                        : 0;
                                      return (
                                        <tr key={serie} className={cn("border-b border-slate-100 dark:border-slate-800 last:border-0", i % 2 === 1 && "bg-slate-50/70 dark:bg-slate-800/20")}>
                                          <td className={cn("py-2 pr-3 pl-3 font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap sticky left-0", i % 2 === 1 ? "bg-slate-50 dark:bg-slate-900" : "bg-white dark:bg-slate-900")}>{serie}</td>
                                          {matrizSeriePorMes.meses.map(mes => {
                                            const qtd = porMes?.get(mes) || 0;
                                            const buraco = qtd === 0 && totalSerie > 0;
                                            return (
                                              <td
                                                key={mes}
                                                className={cn(
                                                  "py-2 pr-3 text-right tabular-nums border-l border-slate-100 dark:border-slate-800",
                                                  buraco ? "bg-rose-50 dark:bg-rose-950" : ""
                                                )}
                                                title={buraco ? `Série sem nenhuma nota em ${mes}, apesar de ter movimento em outros meses do período` : undefined}
                                              >
                                                {qtd > 0 ? (
                                                  <span className="text-slate-600 dark:text-slate-400">{qtd}</span>
                                                ) : (
                                                  <span className={cn("font-bold", buraco ? "text-rose-500 dark:text-rose-400" : "text-slate-300 dark:text-slate-600")}>—</span>
                                                )}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                                Quantidade de notas válidas de cada série em cada mês. Célula em vermelho com "—" é uma série que tem movimento em outro mês do período mas nenhuma nota neste mês — vale confirmar se ela devia ter aparecido.
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Ranking de Produtos: quem mais vende + origem (própria/revenda/misto) —
                          responde de cara "quais produtos compõem a produção própria". */}
                      {rankingProdutos.produtos.length > 0 && (() => {
                        const contagem = { propria: 0, revenda: 0, misto: 0, indefinida: 0 };
                        rankingProdutos.produtos.forEach(p => { contagem[p.origem]++; });
                        const filtrados = filtroOrigemRanking === 'todos'
                          ? rankingProdutos.produtos
                          : rankingProdutos.produtos.filter(p => p.origem === filtroOrigemRanking);
                        const LIMITE = 20;
                        const visiveis = filtrados.slice(0, LIMITE);
                        const origemLabel = { propria: 'Produção própria', revenda: 'Revenda', misto: 'Misto', indefinida: 'Indefinida' };
                        const origemCor = {
                          propria: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
                          revenda: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400',
                          misto: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
                          indefinida: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                        };
                        const classeAbcCor = {
                          A: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
                          B: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
                          C: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                        };
                        const qtdClasseA = rankingProdutos.produtos.filter(p => p.classeAbc === 'A').length;
                        return (
                          <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => setShowRankingProdutos(!showRankingProdutos)}
                                className="flex-1 flex items-center justify-between gap-3 text-left"
                              >
                                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                  Ranking de Produtos ({rankingProdutos.produtos.length})
                                </span>
                                <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showRankingProdutos && "rotate-90")} />
                              </button>
                              <button
                                onClick={exportarRankingProdutosExcel}
                                className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0 no-print"
                                title="Exportar o ranking (respeitando o filtro de origem atual) em Excel"
                              >
                                Exportar Excel
                              </button>
                            </div>

                            {showRankingProdutos && (
                              <div className="mt-4">
                                <div className="flex items-center gap-2 mb-3 flex-wrap text-xs">
                                  {(['todos', 'propria', 'revenda', 'misto'] as const).map(f => {
                                    if (f !== 'todos' && contagem[f] === 0) return null;
                                    const label = f === 'todos' ? `Todos (${rankingProdutos.produtos.length})` : `${origemLabel[f]} (${contagem[f]})`;
                                    return (
                                      <button
                                        key={f}
                                        onClick={() => setFiltroOrigemRanking(f)}
                                        className={cn(
                                          "px-3 py-1.5 rounded-full font-semibold border transition-colors",
                                          filtroOrigemRanking === f
                                            ? "bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100"
                                            : "bg-white text-slate-500 border-slate-200 hover:border-slate-300 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700"
                                        )}
                                      >
                                        {label}
                                      </button>
                                    );
                                  })}
                                  <div className="flex items-center rounded-full border border-slate-200 dark:border-slate-700 overflow-hidden ml-auto">
                                    {([
                                      { v: false, label: 'Por Código' },
                                      { v: true, label: 'Por Nome' },
                                    ] as const).map(opt => (
                                      <button
                                        key={String(opt.v)}
                                        onClick={() => setAgruparRankingPorNome(opt.v)}
                                        title={opt.v
                                          ? 'Junta cProd diferente com o mesmo nome numa só linha — total por produto, ignora cadastro divergente'
                                          : 'Uma linha por código interno (cProd) — mostra cadastro divergente (mesmo produto recadastrado) separado'}
                                        className={cn(
                                          "px-3 py-1.5 font-semibold transition-colors",
                                          agruparRankingPorNome === opt.v
                                            ? "bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900"
                                            : "bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
                                        )}
                                      >
                                        {opt.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-2">
                                  Curva ABC: <strong>{qtdClasseA}</strong> produto(s) (Classe A) já somam 80% do faturamento do catálogo inteiro.
                                  {agruparRankingPorNome && ' Agrupado por nome — cProd pode mostrar mais de um código (cadastro divergente juntado numa linha só).'}
                                </p>
                                <div className="overflow-auto max-h-[420px] border border-slate-100 dark:border-slate-800 rounded-lg">
                                  <table className="w-full text-xs">
                                    <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                      <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-1.5 pr-3 pl-3">#</th>
                                        <th className="py-1.5 pr-3">Produto</th>
                                        <th className="py-1.5 pr-3">cProd</th>
                                        <th className="py-1.5 pr-3">Origem</th>
                                        <th className="py-1.5 pr-3 text-center">Curva ABC</th>
                                        <th className="py-1.5 pr-3 text-right">Qtd</th>
                                        <th className="py-1.5 pr-3 text-right">Valor</th>
                                        <th className="py-1.5 pr-3 text-right">%</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {visiveis.map((p, i) => (
                                        <tr key={`${p.cProd}-${i}`} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                          <td className="py-1.5 pr-3 pl-3 text-slate-400 dark:text-slate-500 tabular-nums">{i + 1}</td>
                                          <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">{p.xProd}</td>
                                          <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-500">
                                            {p.cProd}
                                            {p.cProdsCount > 1 && (
                                              <span
                                                className="ml-1.5 text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                                                title={`${p.cProdsCount} códigos internos diferentes juntados nessa linha (cadastro divergente)`}
                                              >
                                                {p.cProdsCount}x
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-1.5 pr-3">
                                            <span className={cn("text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded", origemCor[p.origem])}>
                                              {origemLabel[p.origem]}
                                            </span>
                                          </td>
                                          <td className="py-1.5 pr-3 text-center" title={`${formatarPct(p.pctAcumulado)}% acumulado até este produto, ordenado por valor`}>
                                            <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded", classeAbcCor[p.classeAbc])}>{p.classeAbc}</span>
                                          </td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatarQuantidadePorUnidade(p.porUnidade)}</td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(p.valor)}</td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">{formatarPct(p.pct)}%</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {filtrados.length > LIMITE && (
                                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                                    Mostrando os {LIMITE} primeiros de {filtrados.length} produtos nesse filtro.
                                  </p>
                                )}
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                                  Valor é a soma dos itens (vProd), não o total da nota — pode divergir um pouco do faturamento quando há desconto ou frete não rateado por item. Já é líquido de devolução de venda (desconta do produto que originou) e não inclui CFOP que não é venda de verdade (transferência, remessa, bonificação/amostra, consignação, devolução de compra) — por isso pode ser menor que o Total de Saídas Auditadas. Origem "Misto" é o mesmo produto vendido ora como própria, ora como revenda — já listado em Produtos Suspeitos. Curva ABC (A até 80% acumulado, B até 95%, C o resto) é sempre calculada sobre o catálogo inteiro, não sobre o filtro de origem atual.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Top NCMs: concentração de faturamento por categoria fiscal, não só
                          por produto — ajuda a enxergar risco de ST/IBS-CBS por NCM. */}
                      {rankingNcm.ncms.length > 0 && (() => {
                        const LIMITE_NCM = 20;
                        const visiveisNcm = rankingNcm.ncms.slice(0, LIMITE_NCM);
                        return (
                          <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => setShowRankingNcm(!showRankingNcm)}
                                className="flex-1 flex items-center justify-between gap-3 text-left"
                              >
                                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                  Top NCMs ({rankingNcm.ncms.length})
                                </span>
                                <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showRankingNcm && "rotate-90")} />
                              </button>
                              <button
                                onClick={exportarRankingNcmExcel}
                                className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0 no-print"
                                title="Exportar a lista completa de NCMs em Excel"
                              >
                                Exportar Excel
                              </button>
                            </div>
                            {showRankingNcm && (
                              <div className="mt-4">
                                <div className="overflow-auto max-h-[420px] border border-slate-100 dark:border-slate-800 rounded-lg">
                                  <table className="w-full text-xs">
                                    <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                      <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-1.5 pr-3 pl-3">#</th>
                                        <th className="py-1.5 pr-3">NCM</th>
                                        <th className="py-1.5 pr-3">Produto (amostra)</th>
                                        <th className="py-1.5 pr-3 text-right">Produtos</th>
                                        <th className="py-1.5 pr-3 text-right">Valor</th>
                                        <th className="py-1.5 pr-3 text-right">%</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {visiveisNcm.map((n, i) => (
                                        <tr key={n.ncm} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                          <td className="py-1.5 pr-3 pl-3 text-slate-400 dark:text-slate-500 tabular-nums">{i + 1}</td>
                                          <td className={cn("py-1.5 pr-3 font-mono", n.ncm === '(vazio)' ? "text-rose-600 dark:text-rose-400 font-bold" : "text-slate-700 dark:text-slate-300")}>{n.ncm}</td>
                                          <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.xProdAmostra}</td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">{n.produtosDistintos}</td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(n.valor)}</td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">{formatarPct(n.pct)}%</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {rankingNcm.ncms.length > LIMITE_NCM && (
                                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                                    Mostrando os {LIMITE_NCM} primeiros de {rankingNcm.ncms.length} NCMs — exporte em Excel pra ver a lista completa.
                                  </p>
                                )}
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                                  Não inclui CFOP que não é venda de verdade (transferência, remessa, bonificação/amostra, consignação, devolução de compra) — por isso pode ser menor que o Total de Saídas Auditadas.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Sazonalidade: dia da semana e horário de pico — direto pra decisão
                          de escala/produção, sem precisar abrir nota por nota. */}
                      {sazonalidade.porDiaSemana.some(d => d.quantidadeNotas > 0) && (() => {
                        const maxDia = Math.max(...sazonalidade.porDiaSemana.map(d => d.faturamento), 1);
                        // Com um dia selecionado, o painel de horário mostra só o cruzamento
                        // daquele dia (ex: "nas sextas, que horário concentra?") em vez do
                        // agregado de todos os dias juntos.
                        const horasBase = sazonalidadeDiaSelecionado !== null
                          ? sazonalidade.porDiaEHora[sazonalidadeDiaSelecionado].horas
                          : sazonalidade.porHora;
                        const horasComMovimento = horasBase.filter(h => h.quantidadeNotas > 0);
                        const maxHora = Math.max(...horasComMovimento.map(h => h.faturamento), 1);
                        return (
                          <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                            <button
                              onClick={() => setShowSazonalidade(!showSazonalidade)}
                              className="w-full flex items-center justify-between gap-3 text-left"
                            >
                              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                Sazonalidade (dia da semana e horário)
                              </span>
                              <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showSazonalidade && "rotate-90")} />
                            </button>
                            {showSazonalidade && (
                              <div className="mt-4">
                                <div className="flex items-center rounded-full border border-slate-200 dark:border-slate-700 overflow-hidden w-fit mb-4 no-print">
                                  {([
                                    { v: false, label: 'Todos os Modelos' },
                                    { v: true, label: 'Somente NFC-e' },
                                  ] as const).map(opt => (
                                    <button
                                      key={String(opt.v)}
                                      onClick={() => setSazonalidadeSomenteNfce(opt.v)}
                                      title={opt.v
                                        ? 'Só NFC-e (modelo 65) — venda de balcão/PDV, sem NF-e de atacado/B2B que pode distorcer o pico de horário'
                                        : 'NFC-e e NF-e juntas — visão completa do faturamento'}
                                      className={cn(
                                        "px-3 py-1.5 text-xs font-semibold transition-colors",
                                        sazonalidadeSomenteNfce === opt.v
                                          ? "bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900"
                                          : "bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
                                      )}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              <div className="grid sm:grid-cols-2 gap-6">
                                <div>
                                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                                    Faturamento por dia da semana <span className="normal-case font-normal text-slate-400 dark:text-slate-500">(clique num dia pra ver o horário só dele)</span>
                                  </div>
                                  <div className="space-y-1.5">
                                    {sazonalidade.porDiaSemana.map((d, i) => (
                                      <button
                                        key={d.dia}
                                        onClick={() => setSazonalidadeDiaSelecionado(sazonalidadeDiaSelecionado === i ? null : i)}
                                        disabled={d.quantidadeNotas === 0}
                                        title={`${d.quantidadeNotas} nota(s)${d.quantidadeNotas > 0 ? ' — clique pra ver o horário só desse dia' : ''}`}
                                        className={cn(
                                          "w-full flex items-center gap-2 text-xs rounded px-1 py-0.5 -mx-1 transition-colors",
                                          d.quantidadeNotas === 0 ? "cursor-default" : "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800",
                                          sazonalidadeDiaSelecionado === i && "bg-blue-50 dark:bg-blue-950/40"
                                        )}
                                      >
                                        <div className={cn("w-9 shrink-0 text-left", sazonalidadeDiaSelecionado === i ? "text-blue-600 dark:text-blue-400 font-bold" : "text-slate-500 dark:text-slate-400")}>{d.dia.slice(0, 3)}</div>
                                        <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                          <div className={cn("h-full", sazonalidadeDiaSelecionado === i ? "bg-blue-600 dark:bg-blue-400" : "bg-blue-400 dark:bg-blue-600")} style={{ width: `${(d.faturamento / maxDia) * 100}%` }} />
                                        </div>
                                        <div className="w-28 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatarMoeda(d.faturamento)}</div>
                                        <div className="w-12 shrink-0 text-right tabular-nums text-slate-400 dark:text-slate-500">{formatarPct(d.pct)}%</div>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div>
                                  <div className="flex items-center justify-between gap-2 mb-2">
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                                      Faturamento por horário{sazonalidadeDiaSelecionado !== null && <> — {sazonalidade.porDiaSemana[sazonalidadeDiaSelecionado].dia}</>}
                                    </div>
                                    {sazonalidadeDiaSelecionado !== null && (
                                      <button
                                        onClick={() => setSazonalidadeDiaSelecionado(null)}
                                        className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                                      >
                                        Ver todos os dias
                                      </button>
                                    )}
                                  </div>
                                  <div className="space-y-1 max-h-[280px] overflow-auto pr-1">
                                    {horasComMovimento.map(h => (
                                      <div key={h.hora} className="flex items-center gap-2 text-xs" title={`${h.quantidadeNotas} nota(s)`}>
                                        <div className="w-8 shrink-0 text-slate-500 dark:text-slate-400 tabular-nums">{String(h.hora).padStart(2, '0')}h</div>
                                        <div className="flex-1 h-3.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                          <div className="h-full bg-emerald-400 dark:bg-emerald-600" style={{ width: `${(h.faturamento / maxHora) * 100}%` }} />
                                        </div>
                                        <div className="w-24 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatarMoeda(h.faturamento)}</div>
                                        <div className="w-12 shrink-0 text-right tabular-nums text-slate-400 dark:text-slate-500">{formatarPct(h.pct)}%</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              </div>
                            )}
                            {showSazonalidade && (
                              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-3">
                                Só venda de verdade (exclui transferência, baixa de estoque, devolução de compra e outras saídas que não são venda) — % é a fatia de cada dia/horário sobre o faturamento total desse gráfico.{sazonalidadeSomenteNfce && ' Mostrando só NFC-e (modelo 65) — NF-e (modelo 55) fora.'}
                              </p>
                            )}
                          </div>
                        );
                      })()}

                      {/* Devoluções: quanto do faturamento voltou como devolução de venda, e
                          quais produtos mais retornam. Os totais (valor, %, qtde de notas) vêm
                          de mapaFiscal — mesma agregação do card resumo e dos comparativos —
                          isso aqui só detalha produto a produto. */}
                      {mapaFiscal.quantidadeDevolucoes > 0 && (
                        <div className="border-t border-slate-100 dark:border-slate-800 mt-6 pt-5">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setShowDevolucoes(!showDevolucoes)}
                              className="flex-1 flex items-center justify-between gap-3 text-left"
                            >
                              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                Devoluções ({mapaFiscal.quantidadeDevolucoes} nota(s), {formatarMoeda(mapaFiscal.valorDevolvido)})
                              </span>
                              <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showDevolucoes && "rotate-90")} />
                            </button>
                            <button
                              onClick={exportarDevolucoesExcel}
                              className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0 no-print"
                              title="Exportar a lista completa de produtos devolvidos em Excel"
                            >
                              Exportar Excel
                            </button>
                          </div>
                          {showDevolucoes && (
                            <div className="mt-4">
                              <div className="rounded-lg px-4 py-2.5 text-xs border bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 mb-3">
                                🟡 {formatarPct(mapaFiscal.pctDevolvido)}% do faturamento do período voltou como devolução de venda ({formatarMoeda(mapaFiscal.valorDevolvido)} em {mapaFiscal.quantidadeDevolucoes} nota(s)).
                              </div>
                              <div className="overflow-auto max-h-[420px] border border-slate-100 dark:border-slate-800 rounded-lg">
                                <table className="w-full text-xs">
                                  <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                    <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                      <th className="py-1.5 pr-3 pl-3">#</th>
                                      <th className="py-1.5 pr-3">Produto</th>
                                      <th className="py-1.5 pr-3">cProd</th>
                                      <th className="py-1.5 pr-3 text-right">Qtd Devolvida</th>
                                      <th className="py-1.5 pr-3 text-right">Valor</th>
                                      <th className="py-1.5 pr-3 text-right">%</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {devolucoesProdutos.slice(0, 20).map((p, i) => (
                                      <tr key={p.cProd} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                        <td className="py-1.5 pr-3 pl-3 text-slate-400 dark:text-slate-500 tabular-nums">{i + 1}</td>
                                        <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">{p.xProd}</td>
                                        <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-500">{p.cProd}</td>
                                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatarQuantidadePorUnidade(p.porUnidade)}</td>
                                        <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(p.valor)}</td>
                                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">{formatarPct(p.pct)}%</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {devolucoesProdutos.length > 20 && (
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                                  Mostrando os 20 primeiros de {devolucoesProdutos.length} produtos — exporte em Excel pra ver a lista completa.
                                </p>
                              )}
                              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                                Considera só devolução de venda (CFOP dedicado), não baixa de estoque ou outras entradas emitidas pela própria empresa sob CFOP de entrada.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Corpo em duas colunas: filtros/utilitários à esquerda, auditoria ao centro */}
              <div className="flex flex-col lg:flex-row gap-8 items-start">
                <aside className="w-full lg:w-72 shrink-0 lg:sticky lg:top-6 space-y-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
                  <div
                    onClick={() => (periodoAnalise.diasDetalhados?.length ?? 0) > 0 && setShowDaysDetail(!showDaysDetail)}
                    onKeyDown={e => { if ((periodoAnalise.diasDetalhados?.length ?? 0) > 0 && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setShowDaysDetail(!showDaysDetail); } }}
                    role={(periodoAnalise.diasDetalhados?.length ?? 0) > 0 ? 'button' : undefined}
                    tabIndex={(periodoAnalise.diasDetalhados?.length ?? 0) > 0 ? 0 : undefined}
                    className={cn(
                      "group bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-700 transition-all",
                      (periodoAnalise.diasDetalhados?.length ?? 0) > 0 && "cursor-pointer hover:border-slate-300 dark:hover:border-slate-600"
                    )}
                  >
                    <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Período Analisado</div>
                  <div className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-2">
                    {periodoAnalise.inicio ? `${periodoAnalise.inicio} a ${periodoAnalise.fim}` : 'N/A'}
                  </div>
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-400 dark:text-slate-500 mt-2">
                    <span>{periodoAnalise.totalDias} dias · {periodoAnalise.totalNotas ?? 0} notas</span>
                    {periodoAnalise.diasDetalhados && periodoAnalise.diasDetalhados.length > 0 && (
                      <div title="Ver detalhes" className="inline-flex items-center justify-center shrink-0">
                        <ChevronRight className={cn("w-6 h-6 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 transition-all duration-300", showDaysDetail && "rotate-90")} />
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-700">
                  <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-3">Pesquisar Notas de Saída</div>
                  <div className="flex flex-col gap-2">
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-4 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={notaSearchQuery}
                        onChange={(e) => setNotaSearchQuery(e.target.value)}
                        placeholder={`Buscar por ${notaSearchCampo === 'Item' ? 'produto' : notaSearchCampo === 'Ncm' ? 'NCM' : notaSearchCampo.toLowerCase()}...`}
                        className="w-full pl-11 pr-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                      />
                    </div>
                    <select
                      value={notaSearchCampo}
                      onChange={(e) => setNotaSearchCampo(e.target.value as typeof notaSearchCampo)}
                      className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs bg-white dark:bg-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <option value="Numero">Só Número</option>
                      <option value="Chave">Só Chave</option>
                      <option value="Cliente">Só Cliente</option>
                      <option value="Item">Produto</option>
                      <option value="Ncm">NCM</option>
                      <option value="Data">Só Data</option>
                      <option value="Valor">Só Valor</option>
                    </select>
                    <select
                      value={filterNotaModelo}
                      onChange={(e) => setFilterNotaModelo(e.target.value)}
                      className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs bg-white dark:bg-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <option value="Todos">Todos os modelos</option>
                      {modelosDisponiveis.map(modelo => (
                        <option key={modelo} value={modelo}>
                          {modelo === '55' ? 'NF-e (55)' : modelo === '65' ? 'NFC-e (65)' : `Modelo ${modelo}`}
                        </option>
                      ))}
                    </select>
                    <select
                      value={filterNotaSituacao}
                      onChange={(e) => setFilterNotaSituacao(e.target.value)}
                      className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs bg-white dark:bg-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <option value="Todas">Todas as situações</option>
                      <option value="Válidas">Somente válidas</option>
                      <option value="Canceladas">Somente canceladas</option>
                      <option value="Inutilizadas">Somente inutilizadas</option>
                      <option value="SemAutorizacao">Sem autorização</option>
                      <option value="ForaDoPrazo">Autorizada fora do prazo</option>
                    </select>
                    {cfopsDisponiveis.length > 0 && (
                      <select
                        value={filterNotaCfop}
                        onChange={(e) => setFilterNotaCfop(e.target.value)}
                        className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs bg-white dark:bg-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      >
                        <option value="Todos">Todos os CFOPs</option>
                        {cfopsDisponiveis.map(cfop => (
                          <option key={cfop} value={cfop}>{cfop}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* SPED Fiscal card — compacto, abre para a direita */}
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden no-print">
                  <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide px-6 pt-5 pb-3 flex items-center justify-between">
                    SPED Fiscal
                    {spedData && (
                      <button
                        onClick={() => spedInputRef.current?.click()}
                        className="text-[11px] font-normal normal-case text-slate-400 hover:text-slate-600 transition-colors"
                        title="Anexar SPED de outro mês (ou substituir o do mesmo mês) sem reiniciar a análise"
                      >
                        Anexar +
                      </button>
                    )}
                  </div>

                  {Object.keys(spedEntries).length > 0 && (
                    <div className="px-6 pb-1 text-[10px] text-slate-400">
                      SPED carregado: {Object.keys(spedEntries).join(', ')}
                    </div>
                  )}

                  {!spedData ? (
                    <div className="px-6 pb-5 flex flex-col gap-3">
                      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        {Object.keys(spedEntries).length > 0
                          ? `Nenhum SPED anexado para ${filterMes} ainda — anexe o SPED dessa competência para cruzar com os XMLs.`
                          : 'Anexe o SPED Fiscal para cruzar com os XMLs e identificar faltantes.'}
                      </p>
                      <button
                        onClick={() => spedInputRef.current?.click()}
                        className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-700 transition-colors"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Anexar SPED (.txt)
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSpedCardOpen(v => !v)}
                      className="w-full flex items-center justify-between px-6 pb-5 text-left group"
                    >
                      <div className="min-w-0">
                        <div className="text-xs text-slate-500 truncate">{spedData.razaoSocial}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{spedCrossRef?.periodo}</div>
                        <div className="flex gap-2 mt-2 flex-wrap">
                          <span className="text-[11px] font-semibold text-slate-600">{spedCrossRef?.spedSaidasTotal} saídas</span>
                          {(spedCrossRef?.saidaFaltantes.length ?? 0) > 0 && (
                            <span className="text-[11px] font-semibold text-amber-600">
                              ⚠ {spedCrossRef?.saidaFaltantes.length} sem XML
                            </span>
                          )}
                          {(spedCrossRef?.xmlsNaoDeclarados.length ?? 0) > 0 && (
                            <span className="text-[11px] font-semibold text-red-600">
                              ⚠ {spedCrossRef?.xmlsNaoDeclarados.length} não declarados
                            </span>
                          )}
                          {(spedCrossRef?.mesesFora.length ?? 0) > 0 && (
                            <span className="text-[11px] font-semibold text-orange-600">
                              ⚠ XMLs fora do período
                            </span>
                          )}
                          {(spedCrossRef?.adicionados.length ?? 0) > 0 && (
                            <span className="text-[11px] font-semibold text-blue-600">
                              +{spedCrossRef?.adicionados.length} adicionados
                            </span>
                          )}
                          {(spedCrossRef?.saidaFaltantes.length ?? 0) === 0 &&
                           (spedCrossRef?.xmlsNaoDeclarados.length ?? 0) === 0 &&
                           (spedCrossRef?.mesesFora.length ?? 0) === 0 &&
                           (spedCrossRef?.adicionados.length ?? 0) === 0 && (
                            <span className="text-[11px] font-semibold text-emerald-600">✓ Todos com XML</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className={cn(
                        'w-5 h-5 text-slate-300 group-hover:text-slate-500 shrink-0 ml-3 transition-transform duration-300',
                        spedCardOpen && 'rotate-90'
                      )} />
                    </button>
                  )}

                  <input
                    type="file"
                    ref={spedInputRef}
                    accept=".txt"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      const sped = parseSped(text, file.name);
                      if (sped && spedTemPeriodoValido(sped)) {
                        setSpedEntries(prev => upsertSpedManual(prev, sped));
                        setSpedCardFiltro('Todas');
                        setSpedSearch('');
                        setSpedCardOpen(true);
                      } else if (sped) {
                        alert(`Não foi possível ler a data de início desse SPED ("${file.name}") — o arquivo pode estar corrompido ou fora do padrão esperado. Peça pro cliente reenviar.`);
                      }
                      e.target.value = '';
                    }}
                  />
                </div>

                {/* Perfil de Clientes (NF-e) — compacto, abre para a direita (mesma lógica do SPED Fiscal) */}
                {perfilClientes.clientes.length > 0 && (
                  <button
                    onClick={() => setShowPerfilClientes(v => !v)}
                    className="group w-full text-left bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 border-l-4 border-l-violet-400 overflow-hidden no-print hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                  >
                    <div className="px-6 py-5 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide flex items-center gap-2">
                          <Users className="w-4 h-4 text-violet-500 shrink-0" />
                          Perfil de Clientes
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                          <strong className="text-slate-700 dark:text-slate-200">{perfilClientes.clientes.length} cliente(s)</strong> com CNPJ (NF-e)
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{formatarMoeda(perfilClientes.totalConsiderado)} em vendas</div>
                      </div>
                      <ChevronRight className={cn('w-5 h-5 text-slate-300 group-hover:text-slate-500 shrink-0 ml-3 transition-transform duration-300', showPerfilClientes && 'rotate-90')} />
                    </div>
                  </button>
                )}

                {/* Quando a empresa só vende por NFC-e o Perfil de Clientes não existe — sem este aviso
                    o card some calado e parece bug (já confundiu analista). */}
                {perfilClientes.vendeSoPorNfce && (
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 border-l-4 border-l-violet-300 px-6 py-5 no-print">
                    <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide flex items-center gap-2">
                      <Users className="w-4 h-4 text-violet-400 shrink-0" />
                      Perfil de Clientes
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">
                      Não se aplica: as vendas do período são por NFC-e (consumidor final) e o destinatário quase nunca tem CNPJ. É esperado pra varejo/balcão, não um erro.
                    </div>
                  </div>
                )}

                {/* Perfil de Fornecedores (NF-e de Entrada) — compacto, abre para a direita */}
                {perfilFornecedores.fornecedores.length > 0 && (
                  <button
                    onClick={() => setShowPerfilFornecedores(v => !v)}
                    className="group w-full text-left bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 border-l-4 border-l-amber-400 overflow-hidden no-print hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                  >
                    <div className="px-6 py-5 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide flex items-center gap-2">
                          <Package className="w-4 h-4 text-amber-500 shrink-0" />
                          Perfil de Fornecedores
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                          <strong className="text-slate-700 dark:text-slate-200">{perfilFornecedores.fornecedores.length} fornecedor(es)</strong> (NF-e de entrada)
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{formatarMoeda(perfilFornecedores.totalConsiderado)} em compras</div>
                      </div>
                      <ChevronRight className={cn('w-5 h-5 text-slate-300 group-hover:text-slate-500 shrink-0 ml-3 transition-transform duration-300', showPerfilFornecedores && 'rotate-90')} />
                    </div>
                  </button>
                )}
              </aside>

              {/* Main content */}
              <div className="flex-1 min-w-0 space-y-8">

              {/* Card: Perfil de Clientes (NF-e) — NFC-e fica de fora, ver nota no useMemo */}
              {showPerfilClientes && perfilClientes.clientes.length > 0 && (() => {
                const q = perfilClientesBusca.trim().toLowerCase();
                const filtrados = !q ? perfilClientes.clientes : perfilClientes.clientes.filter(c =>
                  c.nome.toLowerCase().includes(q) || c.cnpj.includes(q)
                );
                const LIMITE = 30;
                const visiveis = filtrados.slice(0, LIMITE);
                const formatarCnpjCliente = (cnpj: string) =>
                  cnpj.replace(/^([0-9A-Za-z]{2})([0-9A-Za-z]{3})([0-9A-Za-z]{3})([0-9A-Za-z]{4})(\d{2})$/, '$1.$2.$3/$4-$5') || cnpj;
                const formatarDataCliente = (d: string) => d ? d.slice(0, 10).split('-').reverse().join('/') : '—';
                return (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 border-l-violet-400 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <Users className="w-5 h-5 text-violet-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Perfil de Clientes (NF-e)</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            <strong className="text-slate-700 dark:text-slate-200">{perfilClientes.clientes.length} cliente(s)</strong> · {formatarMoeda(perfilClientes.totalConsiderado)} em vendas por NF-e — NFC-e não entra aqui (consumidor final quase nunca tem CNPJ)
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowPerfilClientes(false)}
                        className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 transition-colors shrink-0 no-print"
                        title="Fechar"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {showPerfilClientes && (
                      <div className="space-y-3">
                        <input
                          type="text"
                          value={perfilClientesBusca}
                          onChange={e => setPerfilClientesBusca(e.target.value)}
                          placeholder="Buscar por nome ou CNPJ..."
                          className="w-full max-w-xs px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
                        />

                        <div className="max-h-[420px] overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                              <tr>
                                <th className="w-6 px-1 py-2"></th>
                                <th className="text-left px-3 py-2 font-bold">Cliente</th>
                                <th className="text-right px-3 py-2 font-bold">Notas</th>
                                <th className="text-right px-3 py-2 font-bold">Total comprado</th>
                                <th className="text-right px-3 py-2 font-bold">Ticket médio</th>
                                <th className="text-right px-3 py-2 font-bold">Última compra</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visiveis.map(c => (
                                <React.Fragment key={c.cnpj}>
                                  <tr
                                    onClick={() => {
                                      const abrindo = perfilClienteExpandido !== c.cnpj;
                                      setPerfilClienteExpandido(abrindo ? c.cnpj : null);
                                      if (abrindo && !consultaClientesCnpj[c.cnpj]) consultarCnpjCliente(c.cnpj);
                                    }}
                                    className="border-t border-slate-100 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    <td className="px-1 py-2">
                                      <ChevronRight className={cn("w-3.5 h-3.5 text-slate-400 transition-transform", perfilClienteExpandido === c.cnpj && "rotate-90")} />
                                    </td>
                                    <td className="px-3 py-2">
                                      <div className="font-semibold text-slate-700 dark:text-slate-200">{c.nome}</div>
                                      <div className="text-[10px] text-slate-400 font-mono">{formatarCnpjCliente(c.cnpj)}</div>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{c.quantidadeNotas}</td>
                                    <td className="text-right px-3 py-2 tabular-nums font-semibold">{formatarMoeda(c.totalComprado)}</td>
                                    <td className="text-right px-3 py-2 tabular-nums">{formatarMoeda(c.ticketMedio)}</td>
                                    <td className="text-right px-3 py-2 tabular-nums">{formatarDataCliente(c.ultimaCompra)}</td>
                                  </tr>
                                  {perfilClienteExpandido === c.cnpj && (
                                    <tr className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40">
                                      <td colSpan={6} className="px-3 py-3">
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <Package className="w-3 h-3" /> Produtos mais comprados
                                            </div>
                                            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
                                              {c.produtos.map((p, i) => (
                                                <React.Fragment key={i}>
                                                  <span className="truncate text-slate-600 dark:text-slate-300">{p.xProd}</span>
                                                  <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-200">{formatarMoeda(p.valor)}</span>
                                                </React.Fragment>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <TrendingUp className="w-3 h-3" /> Tendência mensal
                                            </div>
                                            {c.primeiraCompra && (
                                              <div className="text-[10px] text-slate-400 -mt-1 mb-1.5">desde {formatarDataCliente(c.primeiraCompra)}</div>
                                            )}
                                            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
                                              {c.porMes.map((m, i) => (
                                                <React.Fragment key={i}>
                                                  <span className="text-slate-600 dark:text-slate-300">{m.mes}</span>
                                                  <span className="tabular-nums text-right">
                                                    <span className="font-semibold text-slate-700 dark:text-slate-200">{formatarMoeda(m.valor)}</span>
                                                    <span className="text-slate-400"> · {m.quantidade} nota{m.quantidade !== 1 ? 's' : ''}</span>
                                                  </span>
                                                </React.Fragment>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <Landmark className="w-3 h-3" /> Receita Federal
                                            </div>
                                            {(() => {
                                              const consulta = consultaClientesCnpj[c.cnpj];
                                              if (!consulta || consulta.status === 'loading') {
                                                return <div className="text-slate-400 flex items-center gap-1.5 text-xs"><Loader2 className="w-3 h-3 animate-spin" /> Consultando...</div>;
                                              }
                                              if (consulta.status === 'erro' || !consulta.dados) {
                                                return (
                                                  <div className="text-rose-500 text-xs">
                                                    Não foi possível consultar.{' '}
                                                    <button onClick={(e) => { e.stopPropagation(); consultarCnpjCliente(c.cnpj); }} className="underline hover:text-rose-600 font-semibold">Tentar de novo</button>
                                                  </div>
                                                );
                                              }
                                              const d = consulta.dados;
                                              const ativa = d.situacao.toUpperCase() === 'ATIVA';
                                              const optanteTexto = (v: boolean | null) => v === null ? '—' : v ? 'Sim' : 'Não';
                                              return (
                                                <div className="space-y-2">
                                                  <div className={cn(
                                                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                    ativa ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400"
                                                  )}>
                                                    <span className={cn("w-1.5 h-1.5 rounded-full", ativa ? "bg-emerald-500" : "bg-rose-500")} />
                                                    {d.situacao}
                                                  </div>
                                                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-slate-600 dark:text-slate-300">
                                                    {d.porte && <><span className="text-slate-400">Porte</span><span className="text-right font-medium">{d.porte}</span></>}
                                                    <span className="text-slate-400">Simples Nacional</span><span className="text-right font-medium">{optanteTexto(d.opcaoSimples)}</span>
                                                    <span className="text-slate-400">MEI</span><span className="text-right font-medium">{optanteTexto(d.opcaoMei)}</span>
                                                    {d.dataInicioAtividade && <><span className="text-slate-400">Desde</span><span className="text-right font-medium">{formatarDataCliente(d.dataInicioAtividade)}</span></>}
                                                    {(d.municipio || d.uf) && <><span className="text-slate-400">Local</span><span className="text-right font-medium">{d.municipio}{d.municipio && d.uf ? '/' : ''}{d.uf}</span></>}
                                                  </div>
                                                  {d.naturezaJuridica && <div className="text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">{d.naturezaJuridica}</div>}
                                                  {d.cnaeDescricao && <div className="text-slate-500 dark:text-slate-400 truncate" title={d.cnaeDescricao}>{d.cnaeDescricao}</div>}
                                                </div>
                                              );
                                            })()}
                                          </div>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {filtrados.length > LIMITE && (
                          <div className="text-[10px] text-slate-400">Mostrando os {LIMITE} primeiros de {filtrados.length} clientes — refine a busca pra achar um específico.</div>
                        )}
                        <div className="text-[10px] text-slate-400">
                          Considera só saída por NF-e (mod 55) com item em CFOP de venda — devolução, transferência, remessa e bonificação ficam de fora do total. NFC-e (venda a consumidor) não aparece aqui porque o destinatário quase nunca tem CNPJ pra identificar.
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Card: Perfil de Fornecedores (NF-e de entrada) — espelho do Perfil de
                  Clientes, ver nota no useMemo perfilFornecedores */}
              {showPerfilFornecedores && perfilFornecedores.fornecedores.length > 0 && (() => {
                const q = perfilFornecedoresBusca.trim().toLowerCase();
                const filtrados = !q ? perfilFornecedores.fornecedores : perfilFornecedores.fornecedores.filter(f =>
                  f.nome.toLowerCase().includes(q) || f.cnpj.includes(q)
                );
                const LIMITE = 30;
                const visiveis = filtrados.slice(0, LIMITE);
                const formatarCnpjFornecedor = (cnpj: string) =>
                  cnpj.replace(/^([0-9A-Za-z]{2})([0-9A-Za-z]{3})([0-9A-Za-z]{3})([0-9A-Za-z]{4})(\d{2})$/, '$1.$2.$3/$4-$5') || cnpj;
                const formatarDataFornecedor = (d: string) => d ? d.slice(0, 10).split('-').reverse().join('/') : '—';
                return (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 border-l-amber-400 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <Package className="w-5 h-5 text-amber-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Perfil de Fornecedores (NF-e de Entrada)</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            <strong className="text-slate-700 dark:text-slate-200">{perfilFornecedores.fornecedores.length} fornecedor(es)</strong> · {formatarMoeda(perfilFornecedores.totalConsiderado)} em compras — quem vende PRA empresa auditada, com regime declarado por cada um (importa pro crédito de IBS/CBS na Reforma)
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowPerfilFornecedores(false)}
                        className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 transition-colors shrink-0 no-print"
                        title="Fechar"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {showPerfilFornecedores && (
                      <div className="space-y-3">
                        <input
                          type="text"
                          value={perfilFornecedoresBusca}
                          onChange={e => setPerfilFornecedoresBusca(e.target.value)}
                          placeholder="Buscar por nome ou CNPJ..."
                          className="w-full max-w-xs px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
                        />

                        <div className="max-h-[420px] overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                              <tr>
                                <th className="w-6 px-1 py-2"></th>
                                <th className="text-left px-3 py-2 font-bold">Fornecedor</th>
                                <th className="text-right px-3 py-2 font-bold">Notas</th>
                                <th className="text-right px-3 py-2 font-bold">Total comprado</th>
                                <th className="text-right px-3 py-2 font-bold">ICMS destacado</th>
                                <th className="text-left px-3 py-2 font-bold">Regime declarado</th>
                                <th className="text-right px-3 py-2 font-bold">Última compra</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visiveis.map(f => (
                                <React.Fragment key={f.cnpj}>
                                  <tr
                                    onClick={() => {
                                      const abrindo = perfilFornecedorExpandido !== f.cnpj;
                                      setPerfilFornecedorExpandido(abrindo ? f.cnpj : null);
                                      if (abrindo && !consultaClientesCnpj[f.cnpj]) consultarCnpjCliente(f.cnpj);
                                    }}
                                    className="border-t border-slate-100 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    <td className="px-1 py-2">
                                      <ChevronRight className={cn("w-3.5 h-3.5 text-slate-400 transition-transform", perfilFornecedorExpandido === f.cnpj && "rotate-90")} />
                                    </td>
                                    <td className="px-3 py-2">
                                      <div className="font-semibold text-slate-700 dark:text-slate-200">{f.nome}</div>
                                      <div className="text-[10px] text-slate-400 font-mono">{formatarCnpjFornecedor(f.cnpj)}</div>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{f.quantidadeNotas}</td>
                                    <td className="text-right px-3 py-2 tabular-nums font-semibold">{formatarMoeda(f.totalComprado)}</td>
                                    <td className="text-right px-3 py-2 tabular-nums text-emerald-600 dark:text-emerald-400">{f.totalIcmsDestacado > 0 ? formatarMoeda(f.totalIcmsDestacado) : '—'}</td>
                                    <td className="px-3 py-2">
                                      <span className={cn(
                                        "inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold",
                                        f.crtDeclarado === '1' || f.crtDeclarado === '2' ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                                          : f.crtDeclarado === '4' ? "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-400"
                                          : f.crtDeclarado === '3' ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                          : "bg-slate-50 text-slate-400 dark:bg-slate-800/50 dark:text-slate-500"
                                      )}>
                                        {f.crtDeclaradoLabel}
                                      </span>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{formatarDataFornecedor(f.ultimaCompra)}</td>
                                  </tr>
                                  {perfilFornecedorExpandido === f.cnpj && (
                                    <tr className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40">
                                      <td colSpan={7} className="px-3 py-3">
                                        {(f.totalIcmsDestacado > 0 || f.totalIbsDestacado > 0) && (
                                          <div className="flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 rounded-lg px-3 py-2 mb-3">
                                            <Landmark className="w-3.5 h-3.5 shrink-0" />
                                            <span>
                                              <strong>{formatarMoeda(f.totalIcmsDestacado)}</strong> de ICMS destacado
                                              {f.totalIbsDestacado > 0 && <> · <strong>{formatarMoeda(f.totalIbsDestacado)}</strong> de IBS/CBS destacado</>}
                                              {' '}nas notas desse fornecedor — base do crédito a avaliar (depende do regime da própria empresa auditada).
                                            </span>
                                          </div>
                                        )}
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <Package className="w-3 h-3" /> Produtos mais comprados
                                            </div>
                                            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
                                              {f.produtos.map((p, i) => (
                                                <React.Fragment key={i}>
                                                  <span className="truncate text-slate-600 dark:text-slate-300">{p.xProd}</span>
                                                  <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-200">{formatarMoeda(p.valor)}</span>
                                                </React.Fragment>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <TrendingUp className="w-3 h-3" /> Tendência mensal
                                            </div>
                                            {f.primeiraCompra && (
                                              <div className="text-[10px] text-slate-400 -mt-1 mb-1.5">desde {formatarDataFornecedor(f.primeiraCompra)}</div>
                                            )}
                                            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
                                              {f.porMes.map((m, i) => (
                                                <React.Fragment key={i}>
                                                  <span className="text-slate-600 dark:text-slate-300">{m.mes}</span>
                                                  <span className="tabular-nums text-right">
                                                    <span className="font-semibold text-slate-700 dark:text-slate-200">{formatarMoeda(m.valor)}</span>
                                                    <span className="text-slate-400"> · {m.quantidade} nota{m.quantidade !== 1 ? 's' : ''}</span>
                                                  </span>
                                                </React.Fragment>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                              <Landmark className="w-3 h-3" /> Receita Federal
                                            </div>
                                            {(() => {
                                              const consulta = consultaClientesCnpj[f.cnpj];
                                              if (!consulta || consulta.status === 'loading') {
                                                return <div className="text-slate-400 flex items-center gap-1.5 text-xs"><Loader2 className="w-3 h-3 animate-spin" /> Consultando...</div>;
                                              }
                                              if (consulta.status === 'erro' || !consulta.dados) {
                                                return (
                                                  <div className="text-rose-500 text-xs">
                                                    Não foi possível consultar.{' '}
                                                    <button onClick={(e) => { e.stopPropagation(); consultarCnpjCliente(f.cnpj); }} className="underline hover:text-rose-600 font-semibold">Tentar de novo</button>
                                                  </div>
                                                );
                                              }
                                              const d = consulta.dados;
                                              const ativa = d.situacao.toUpperCase() === 'ATIVA';
                                              const optanteTexto = (v: boolean | null) => v === null ? '—' : v ? 'Sim' : 'Não';
                                              return (
                                                <div className="space-y-2">
                                                  <div className={cn(
                                                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                    ativa ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400"
                                                  )}>
                                                    <span className={cn("w-1.5 h-1.5 rounded-full", ativa ? "bg-emerald-500" : "bg-rose-500")} />
                                                    {d.situacao}
                                                  </div>
                                                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-slate-600 dark:text-slate-300">
                                                    <span className="text-slate-400">Regime (nota)</span><span className="text-right font-medium">{f.crtDeclaradoLabel}</span>
                                                    {d.porte && <><span className="text-slate-400">Porte</span><span className="text-right font-medium">{d.porte}</span></>}
                                                    <span className="text-slate-400">Simples Nacional</span><span className="text-right font-medium">{optanteTexto(d.opcaoSimples)}</span>
                                                    <span className="text-slate-400">MEI</span><span className="text-right font-medium">{optanteTexto(d.opcaoMei)}</span>
                                                    {d.dataInicioAtividade && <><span className="text-slate-400">Desde</span><span className="text-right font-medium">{formatarDataFornecedor(d.dataInicioAtividade)}</span></>}
                                                    {(d.municipio || d.uf) && <><span className="text-slate-400">Local</span><span className="text-right font-medium">{d.municipio}{d.municipio && d.uf ? '/' : ''}{d.uf}</span></>}
                                                  </div>
                                                  {d.naturezaJuridica && <div className="text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">{d.naturezaJuridica}</div>}
                                                  {d.cnaeDescricao && <div className="text-slate-500 dark:text-slate-400 truncate" title={d.cnaeDescricao}>{d.cnaeDescricao}</div>}
                                                </div>
                                              );
                                            })()}
                                          </div>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {filtrados.length > LIMITE && (
                          <div className="text-[10px] text-slate-400">Mostrando os {LIMITE} primeiros de {filtrados.length} fornecedores — refine a busca pra achar um específico.</div>
                        )}
                        <div className="text-[10px] text-slate-400">
                          Considera toda NF-e onde a empresa auditada é o destinatário (nota de entrada/compra) — soma o valor de todos os itens recebidos, sem separar por CFOP. "ICMS destacado" soma o vICMS item a item (base do crédito a avaliar, não o crédito efetivo). "Regime declarado" vem direto do CRT da nota mais recente de cada fornecedor (1/2 = Simples Nacional, 3 = Regime Normal, 4 = MEI); a consulta à Receita Federal abaixo é um complemento opcional, não substitui o que a própria nota já declara.
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Card: Notas de Serviço (NFS-e) — só aparece se alguma for encontrada */}
              {nfseList.length > 0 && (() => {
                const q = nfseBusca.trim().toLowerCase();
                const filtradas = nfseList.filter(n =>
                  !q ||
                  (n.numero || '').toLowerCase().includes(q) ||
                  (n.razaoSocial || '').toLowerCase().includes(q) ||
                  (n.destNome || '').toLowerCase().includes(q)
                );
                const valorTotal = nfseList.reduce((s, n) => s + (parseFloat(n.valor || '0') || 0), 0);
                return (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 border-l-blue-400 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <Briefcase className="w-5 h-5 text-blue-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Notas de Serviço (NFS-e)</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            <strong className="text-slate-700 dark:text-slate-200">{nfseList.length} nota(s)</strong> · {formatarMoeda(valorTotal)} — TEF e IBS/CBS acima são só pra NF-e/NFC-e; sequência da NFS-e é auditada abaixo
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowNfse(!showNfse)}
                        className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print"
                      >
                        {showNfse ? 'Ocultar' : 'Ver detalhes'}
                      </button>
                    </div>

                    {nfseRecebidasInfo && (
                      <div className="flex items-start gap-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 text-blue-700 dark:text-blue-300 text-sm mb-4">
                        <svg className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <div>
                          <span className="font-bold">{nfseRecebidasInfo.count} nota{nfseRecebidasInfo.count !== 1 ? 's' : ''} de serviço tomado (a empresa é a tomadora, não a prestadora)</span> detectada{nfseRecebidasInfo.count !== 1 ? 's' : ''} e ignorada{nfseRecebidasInfo.count !== 1 ? 's' : ''} na sequência abaixo — só a numeração própria da empresa (como prestadora) é auditada.
                          {nfseRecebidasInfo.nomes && <span className="text-blue-500 dark:text-blue-400 ml-1">({nfseRecebidasInfo.nomes})</span>}
                        </div>
                      </div>
                    )}

                    {showNfse && (
                      <div className="space-y-3">
                        <input
                          type="text"
                          value={nfseBusca}
                          onChange={e => setNfseBusca(e.target.value)}
                          placeholder="Buscar por número ou prestador/tomador..."
                          className="w-full max-w-xs px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
                        />

                        {nfseAnalysis.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                              Sequência (nDPS — número interno do prestador, não o nº da NFS-e)
                            </div>
                            <div className="space-y-2">
                              {nfseAnalysis.map((s, i) => (
                                <div
                                  key={`${s.cnpj}_${s.serie}_${i}`}
                                  className={cn(
                                    "rounded-lg px-3 py-2 text-xs border",
                                    s.faltantes.length > 0
                                      ? "bg-rose-50 dark:bg-rose-950 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200"
                                      : "bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
                                  )}
                                >
                                  <div className="font-semibold">
                                    Série {s.serie} — {s.recebidos} de {s.esperados} DPS ({s.min} a {s.max}){s.duplicados > 0 && ` · ${s.duplicados} duplicado(s)`}
                                  </div>
                                  {s.faltantes.length > 0 ? (
                                    <div className="mt-0.5">⚠ Faltando: {formatarFaixas(agruparFaixas(s.faltantes))}</div>
                                  ) : (
                                    <div className="mt-0.5">✓ Sequência íntegra nessa série</div>
                                  )}
                                  {s.cancelados.length > 0 && (
                                    <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                                      ⓘ {s.cancelados.length} nDPS cancelado(s): {formatarFaixas(agruparFaixas(s.cancelados))}
                                    </div>
                                  )}
                                  {s.suspeitasCanceladas.length > 0 && (
                                    <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                                      ⚠ {s.suspeitasCanceladas.length} nDPS suspeito(s) de cancelamento/reemissão (mesmo tomador/valor/data, nDPS consecutivo — confirme manualmente): {formatarFaixas(agruparFaixas(s.suspeitasCanceladas))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="overflow-x-auto overflow-y-auto max-h-72">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-white dark:bg-slate-900">
                              <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                <th className="py-1.5 pr-3">Nº NFS-e</th>
                                <th className="py-1.5 pr-3">Nº DPS</th>
                                <th className="py-1.5 pr-3">Série</th>
                                <th className="py-1.5 pr-3">Data</th>
                                <th className="py-1.5 pr-3">Prestador</th>
                                <th className="py-1.5 pr-3">Tomador</th>
                                <th className="py-1.5 pr-3">Serviço</th>
                                <th className="py-1.5 text-right pr-3">Valor</th>
                                <th className="py-1.5 pr-3">Baixar</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtradas.slice(0, 100).map((n, i) => {
                                const nCancelada = (!!n.chave && nfseCanceladasRefs.has(`chave:${n.chave}`)) ||
                                                   (!!n.nfseNumeroDFSe && nfseCanceladasRefs.has(`ndfse:${n.nfseNumeroDFSe}`));
                                const nSuspeita = !nCancelada && !!n.chave && nfseSuspeitasCanceladas.has(n.chave);
                                return (
                                <tr key={n.chave || i} className={cn(
                                  "border-b border-slate-100 dark:border-slate-800 last:border-0",
                                  nCancelada && "bg-rose-50/60 dark:bg-rose-950/30",
                                  nSuspeita && "bg-amber-50/60 dark:bg-amber-950/30"
                                )}>
                                  <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">
                                    <span className="inline-flex items-center gap-1">
                                      {n.numero || '—'}
                                      {nCancelada && <Ban className="w-3 h-3 text-rose-500 shrink-0" title="NFS-e cancelada" />}
                                      {nSuspeita && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" title="Possível nota cancelada e reemitida (mesmo tomador/valor/data, nDPS consecutivo) — confirme manualmente" />}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400">{n.nfseNumeroDPS || '—'}</td>
                                  <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400">{n.serie || '—'}</td>
                                  <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                                  <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300 max-w-[160px] truncate" title={n.razaoSocial}>{n.razaoSocial || '—'}</td>
                                  <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300 max-w-[160px] truncate" title={n.destNome}>{n.destNome || '—'}</td>
                                  <td className="py-1.5 pr-3 text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title={n.descServico}>{n.descServico || '—'}</td>
                                  <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(n.valor || '0') || 0)}</td>
                                  <td className="py-1.5 pr-3">
                                    <button
                                      onClick={() => baixarXmlEvidencia(n)}
                                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                    >
                                      <Download className="w-3 h-3" />
                                      XML
                                    </button>
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {filtradas.length > 100 && (
                            <p className="text-[11px] text-slate-400 mt-1.5">Mostrando 100 de {filtradas.length}. Refine a busca.</p>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          ⚠ Extração best-effort (padrão Sistema Nacional NFS-e/ADN) — se algum campo vier vazio, o sistema do prestador pode nomear a tag de um jeito diferente do esperado; o XML original continua disponível pra baixar e conferir manualmente.
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* SPED Fiscal — card expandido (abre para a direita) */}
              {spedCardOpen && spedData && spedCrossRef && (() => {
                const formatValorSped = (v: string) => {
                  const n = parseFloat(v.replace(',', '.'));
                  return isNaN(n) ? v : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                };
                // Lote grande pode ter dezenas de milhares de linhas de SPED — desenhar
                // tudo de uma vez trava a aba (visto em produção). A tela mostra só uma
                // amostra; a lista completa sempre está disponível via "Exportar Excel",
                // que não tem esse limite.
                const LIMITE_SPED_LINHAS = 300;
                return (
                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden no-print">
                    {/* Cabeçalho */}
                    <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-bold text-slate-800">SPED Fiscal</div>
                        <div className="text-xs text-slate-400 mt-0.5">{spedData.razaoSocial} · CNPJ {spedData.cnpj} · {spedCrossRef.periodo}</div>
                      </div>
                      <button
                        onClick={() => setSpedCardOpen(false)}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                        title="Fechar"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Estatísticas rápidas */}
                    <div className="px-6 py-3 border-b border-slate-100 flex gap-6 flex-wrap text-xs">
                      <span className="text-slate-500">No SPED: <strong className="text-slate-700">{spedCrossRef.spedSaidasTotal}</strong></span>
                      <span className="text-slate-500">Com XML: <strong className="text-emerald-600">{spedCrossRef.saidaOk}</strong></span>
                      <span className="text-slate-500">Sem XML: <strong className={spedCrossRef.saidaFaltantes.length > 0 ? 'text-amber-600' : 'text-slate-700'}>{spedCrossRef.saidaFaltantes.length}</strong></span>
                      {spedCrossRef.adicionados.length > 0 && (
                        <span className="text-slate-500">Adicionados: <strong className="text-blue-600">{spedCrossRef.adicionados.length}</strong></span>
                      )}
                      {spedCrossRef.xmlsNaoDeclarados.length > 0 && (
                        <span className="flex items-center gap-2">
                          <span className="text-slate-500">Não declarados: <strong className="text-red-600">{spedCrossRef.xmlsNaoDeclarados.length}</strong></span>
                          {activeSpedList.length !== 1 ? (
                            <span className="text-[11px] text-slate-400" title="Selecione um único mês no filtro para baixar o SPED corrigido daquela competência">
                              (selecione um mês para baixar o corrigido)
                            </span>
                          ) : (
                          <button
                            onClick={() => {
                              const corrigido = gerarSpedCorrigido(spedData!, spedCrossRef.xmlsNaoDeclarados);
                              const blob = new Blob([corrigido], { type: 'text/plain;charset=utf-8' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
                              const mmI = parseInt(spedData!.dtIni.slice(2, 4)) - 1;
                              const aaI = spedData!.dtIni.slice(4, 8);
                              const mmF = parseInt(spedData!.dtFin.slice(2, 4)) - 1;
                              const aaF = spedData!.dtFin.slice(4, 8);
                              const per = mmI === mmF && aaI === aaF ? `${meses[mmI]}${aaI}` : `${meses[mmI]}${aaI}-${meses[mmF]}${aaF}`;
                              const emp = spedData!.razaoSocial.replace(/[/\\:*?"<>|]/g, '').trim();
                              a.download = `SPED ${emp} ${per} ATUALIZADO - SEQUENCIA FISCAL.txt`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-red-700 text-[11px] font-semibold hover:bg-red-100 transition-colors"
                            title="Gera novo SPED com os XMLs não declarados inseridos como C100"
                          >
                            <Download className="w-3 h-3" />
                            Baixar SPED Corrigido
                          </button>
                          )}
                        </span>
                      )}
                    </div>

                    {/* Banner de período parcial */}
                    {spedCrossRef.mesesFora.length > 0 && (
                      <div className="mx-6 my-3 px-4 py-3 bg-orange-50 border border-orange-200 rounded-xl text-xs text-orange-800">
                        <strong>⚠ SPED com período parcial</strong> — cobre apenas {spedCrossRef.periodo}.<br />
                        XMLs de <strong>{spedCrossRef.mesesFora.join(', ')}</strong> ({spedCrossRef.xmlsForaPeriodo.length} notas) estão fora do período declarado e não podem ser comparados com este SPED.
                      </div>
                    )}

                    {/* Filtros + Busca */}
                    <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap gap-3 items-center">
                      <div className="flex gap-1.5 flex-wrap">
                        {(['Todas', 'SemXML', 'NaoDeclarado', 'Adicionados', 'Canceladas'] as const).map(f => {
                          const label =
                            f === 'SemXML' ? `Sem XML (${spedCrossRef.saidaFaltantes.length})` :
                            f === 'NaoDeclarado' ? `Não Declarados (${spedCrossRef.xmlsNaoDeclarados.length})` :
                            f === 'Adicionados' ? `Adicionados (${spedCrossRef.adicionados.length})` :
                            f === 'Canceladas' ? 'Canceladas' :
                            `Todas (${spedCrossRef.spedSaidasTotal})`;
                          if (f === 'NaoDeclarado' && spedCrossRef.xmlsNaoDeclarados.length === 0) return null;
                          if (f === 'Adicionados' && spedCrossRef.adicionados.length === 0) return null;
                          return (
                            <button
                              key={f}
                              onClick={() => setSpedCardFiltro(f)}
                              className={cn(
                                'px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors',
                                spedCardFiltro === f
                                  ? f === 'SemXML'
                                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                    : f === 'NaoDeclarado'
                                      ? 'bg-red-100 text-red-800 border border-red-300'
                                      : f === 'Adicionados'
                                        ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                        : 'bg-slate-900 text-white'
                                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="relative flex-1 min-w-[180px] max-w-xs">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                        <input
                          type="text"
                          value={spedSearch}
                          onChange={e => setSpedSearch(e.target.value)}
                          placeholder="Buscar número, chave, data…"
                          className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300 bg-slate-50"
                        />
                        {spedSearch && (
                          <button onClick={() => setSpedSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <button
                        onClick={exportarSpedTabelaExcel}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-semibold hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0"
                        title="Exporta a lista atual (respeitando o filtro e a busca) para Excel"
                      >
                        <Download className="w-3 h-3" />
                        Exportar Excel
                      </button>
                    </div>

                    {/* Tabela com scroll interno */}
                    <div className="overflow-y-auto max-h-[500px] custom-scrollbar">
                      {spedCardFiltro === 'NaoDeclarado' ? (() => {
                        const q = spedSearch.trim().toLowerCase();
                        const rows = q
                          ? spedCrossRef.xmlsNaoDeclarados.filter(x =>
                              (x.numero ?? '').includes(q) ||
                              (x.chave ?? '').toLowerCase().includes(q) ||
                              (x.data ?? '').includes(q)
                            )
                          : spedCrossRef.xmlsNaoDeclarados;
                        if (rows.length === 0) return (
                          <div className="px-6 py-10 text-center text-sm text-slate-400">Nenhum resultado para a busca.</div>
                        );
                        // Lote pode ter dezenas de milhares de linhas — desenhar tudo de
                        // uma vez trava a aba. Mostra só uma amostra; quem quiser a lista
                        // inteira usa o botão "Exportar Excel" logo acima, sem esse limite.
                        return (
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
                              <tr>
                                <th className="text-left px-6 py-2.5 text-slate-400 font-semibold">Data</th>
                                <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Mod</th>
                                <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Série</th>
                                <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Nº Doc</th>
                                <th className="text-right px-6 py-2.5 text-slate-400 font-semibold">Valor</th>
                                <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Chave</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.slice(0, LIMITE_SPED_LINHAS).map((x, i) => (
                                <tr key={i} className="border-b border-slate-50 hover:bg-red-50/30 bg-red-50/20 transition-colors">
                                  <td className="px-6 py-2 text-slate-500">{x.data ?? '—'}</td>
                                  <td className="px-3 py-2 text-slate-400">{x.modelo ?? '—'}</td>
                                  <td className="px-3 py-2 text-slate-400">{x.serie ?? '—'}</td>
                                  <td className="px-3 py-2 font-mono text-slate-700">{x.numero ?? '—'}</td>
                                  <td className="px-6 py-2 text-right text-slate-600">
                                    {x.valor ? parseFloat(x.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-[10px] text-slate-400 max-w-[200px] truncate">{x.chave ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        );
                      })() : spedRowsFiltradas.length === 0 ? (
                        <div className="px-6 py-10 text-center text-sm text-slate-400">
                          {spedCardFiltro === 'SemXML' ? '✅ Nenhum faltante — todos os XMLs estão carregados.' : spedSearch ? 'Nenhum resultado para a busca.' : 'Nenhum registro neste filtro.'}
                        </div>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
                            <tr>
                              <th className="text-left px-6 py-2.5 text-slate-400 font-semibold">Data</th>
                              <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Mod</th>
                              <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Série</th>
                              <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Nº Doc</th>
                              <th className="text-right px-6 py-2.5 text-slate-400 font-semibold">Valor</th>
                              <th className="text-left px-3 py-2.5 text-slate-400 font-semibold">Chave</th>
                              <th className="px-3 py-2.5 text-slate-400 font-semibold text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spedRowsFiltradas.slice(0, LIMITE_SPED_LINHAS).map((c, i) => {
                              const falta = c.chave ? spedCrossRef.saidaFaltantesSet.has(c.chave) : false;
                              const cancelada = c.codSit === '02' || c.codSit === '06';
                              const adicionado = spedCardFiltro === 'Adicionados';
                              return (
                                <tr key={i} className={cn('border-b border-slate-50 hover:bg-slate-50 transition-colors', falta && !cancelada && 'bg-amber-50/40', adicionado && 'bg-blue-50/30')}>
                                  <td className="px-6 py-2 text-slate-500">{spedCrossRef.formatDt(c.dtDoc)}</td>
                                  <td className="px-3 py-2 text-slate-400">{c.codMod}</td>
                                  <td className="px-3 py-2 text-slate-400">{c.ser}</td>
                                  <td className="px-3 py-2 font-mono text-slate-700">{c.numDoc}</td>
                                  <td className="px-6 py-2 text-right text-slate-600">{formatValorSped(c.vlDoc)}</td>
                                  <td className="px-3 py-2 font-mono text-[10px] text-slate-400 max-w-[200px] truncate">{c.chave || '—'}</td>
                                  <td className="px-3 py-2 text-center">
                                    {cancelada ? (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500">Cancelada</span>
                                    ) : falta ? (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Sem XML</span>
                                    ) : (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">Com XML</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                    {(() => {
                      const count = spedCardFiltro === 'NaoDeclarado'
                        ? spedCrossRef.xmlsNaoDeclarados.length
                        : spedRowsFiltradas.length;
                      if (count === 0) return null;
                      return (
                        <div className="px-6 py-2.5 border-t border-slate-100 text-[11px] text-slate-400 text-right">
                          {count > LIMITE_SPED_LINHAS
                            ? `Mostrando ${LIMITE_SPED_LINHAS} de ${count} registros — exporte em Excel pra ver a lista completa`
                            : `${count} registro${count !== 1 ? 's' : ''}`}
                          {spedSearch ? ' (filtrados)' : ''}
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Selection bar — always visible regardless of the current search/filter, since
                  selections made across earlier searches must stay reachable and downloadable. */}
              {notasSelecionadas.size > 0 && (
                <div className="bg-white p-4 rounded-2xl border border-slate-200 no-print">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => setShowSelecionadas(!showSelecionadas)}
                      className="flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 transition-all"
                    >
                      {notasSelecionadas.size} selecionada{notasSelecionadas.size > 1 ? 's' : ''}
                      <ChevronRight className={cn("w-3.5 h-3.5 transition-transform duration-300", showSelecionadas && "rotate-90")} />
                    </button>
                    <button
                      onClick={() => baixarDanfesSelecionados()}
                      disabled={!!baixandoLote}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold disabled:opacity-40 hover:bg-slate-700 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {baixandoLote?.tipo === 'danfe' ? `Gerando ${baixandoLote.atual}/${baixandoLote.total}...` : 'Baixar DANFEs (.zip)'}
                    </button>
                    <button
                      onClick={() => baixarXmlsSelecionados()}
                      disabled={!!baixandoLote}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-bold disabled:opacity-40 hover:bg-slate-50 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {notasSelecionadas.size === 1 ? 'Baixar XML' : 'Baixar XMLs (.zip)'}
                    </button>
                    <button
                      onClick={() => setNotasSelecionadas(new Set())}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-500 text-xs font-bold hover:text-slate-700 transition-all ml-auto"
                    >
                      <X className="w-3.5 h-3.5" />
                      Limpar seleção
                    </button>
                  </div>
                  {showSelecionadas && (
                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 max-h-64 overflow-y-auto custom-scrollbar space-y-1.5">
                      {notasSaida.filter(n => n.chave && notasSelecionadas.has(n.chave)).map(nota => (
                        <div key={nota.chave} className="flex items-center justify-between gap-3 text-xs bg-slate-50 dark:bg-slate-800 rounded-lg px-3 py-2">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">Nº {nota.numero}</span>
                          <span className="text-slate-500 dark:text-slate-400 truncate flex-1">{nota.destNome || '—'}</span>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(nota.valor || '0') || 0)}</span>
                          <button
                            onClick={() => toggleSelecaoNota(nota.chave!)}
                            className="text-slate-400 hover:text-rose-600 transition-all shrink-0"
                            title="Remover da seleção"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Search results — opens here in the main area as soon as the sidebar search has a query/filter active */}
              {(notaSearchQuery.trim() || filterNotaModelo !== 'Todos' || filterNotaSituacao !== 'Todas' || filterNotaCfop !== 'Todos') && (
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-700">
                  <div className="overflow-x-auto overflow-y-auto max-h-[520px] custom-scrollbar">
                    {notasSaidaFiltradas.length === 0 ? (
                      <p className="text-sm text-slate-400 dark:text-slate-500 py-4 text-center">Nenhuma nota encontrada com os filtros atuais.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
                          <tr className="text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                            <th className="py-2 pr-2 w-8"></th>
                            <th className="py-2 pr-4">Número</th>
                            <th className="py-2 pr-4">Série/Modelo</th>
                            <th className="py-2 pr-4">Cliente</th>
                            <th className="py-2 pr-4">Data</th>
                            <th className="py-2 pr-4 text-right">Valor</th>
                            <th className="py-2 pr-4">CFOP</th>
                            <th className="py-2 pr-4">Chave</th>
                            <th className="py-2 pr-4">Situação</th>
                            <th className="py-2 pr-4">DANFE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {notasSaidaFiltradas.slice(0, 100).map((nota, idx) => {
                            const isInutilizacao = nota.tipo === 'inutilizacao';
                            const podeSelecionar = !isInutilizacao && !!nota.chave && !!nota.rawXml;
                            return (
                              <tr key={nota.chave || `${nota.cnpj}-${nota.modelo}-${nota.serie}-${nota.nNFIni}-${idx}`} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-2 pr-2">
                                  {podeSelecionar && (
                                    <input
                                      type="checkbox"
                                      checked={notasSelecionadas.has(nota.chave!)}
                                      onChange={() => toggleSelecaoNota(nota.chave!)}
                                      className="w-4 h-4 rounded border-slate-300 accent-slate-900 cursor-pointer"
                                    />
                                  )}
                                </td>
                                <td className="py-2 pr-4 font-semibold text-slate-900 dark:text-slate-100">{nota.numero}</td>
                                <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">{nota.serie}/{nota.modelo}</td>
                                <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{isInutilizacao ? '—' : (nota.destNome || '—')}</td>
                                <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">{nota.data ? nota.data.substring(0, 10).split('-').reverse().join('/') : '—'}</td>
                                <td className="py-2 pr-4 text-right font-semibold text-slate-900 dark:text-slate-100">{isInutilizacao ? '—' : formatarMoeda(parseFloat(nota.valor || '0') || 0)}</td>
                                <td className="py-2 pr-4 font-mono text-xs">
                                  {isInutilizacao || !nota.cfopValores
                                    ? <span className="text-slate-400 dark:text-slate-500">—</span>
                                    : Object.keys(nota.cfopValores).sort().map((c, i) => (
                                        <span key={c} className={isAlertCfop(c) ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-600 dark:text-slate-400'}>
                                          {i > 0 ? ', ' : ''}{c}
                                        </span>
                                      ))}
                                </td>
                                <td className="py-2 pr-4 text-slate-400 dark:text-slate-500 font-mono text-xs">{isInutilizacao ? '—' : nota.chave}</td>
                                <td className="py-2 pr-4">
                                  {isInutilizacao ? (
                                    nota.origemManual ? (
                                      <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold">Inutilizada (Manual)</span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-300 text-xs font-bold">Inutilizada (XML)</span>
                                    )
                                  ) : nota.isCancelada ? (
                                    <span className="px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-300 text-xs font-bold">Cancelada</span>
                                  ) : nota.isEntradaPropria ? (
                                    <span className="px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-300 text-xs font-bold" title="Nota emitida com CFOP de entrada (devolução de venda, baixa de estoque, etc.) — não entra no faturamento.">Devolução/Entrada</span>
                                  ) : !nota.protocolo ? (
                                    <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-xs font-bold" title="Nota sem protocolo de autorização SEFAZ — não incluída no total válido">Sem Autorização</span>
                                  ) : isForaDoPrazo(nota) ? (
                                    <span className="px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 text-xs font-bold" title={`Contingência autorizada fora do prazo — emissão: ${nota.data ? new Date(nota.data).toLocaleString('pt-BR') : '?'} · autorização: ${nota.dhRecbto ? new Date(nota.dhRecbto).toLocaleString('pt-BR') : '?'}`}>Fora do Prazo</span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-300 text-xs font-bold">Válida</span>
                                  )}
                                </td>
                                <td className="py-2 pr-4">
                                  {!isInutilizacao && (
                                    <button
                                      onClick={() => baixarDanfe(nota)}
                                      disabled={downloadingDanfeChave === nota.chave || !nota.rawXml}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700 transition-all"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      {downloadingDanfeChave === nota.chave ? 'Gerando...' : 'Baixar'}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {notasSaidaFiltradas.length > 100 && (
                      <p className="text-xs text-slate-400 mt-2">Mostrando 100 de {notasSaidaFiltradas.length} resultados. Refine a busca para ver menos notas.</p>
                    )}
                  </div>
                </div>
              )}

              {showDaysDetail && periodoAnalise.diasComContagem && periodoAnalise.diasComContagem.length > 0 && (
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-700">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Notas por Dia</div>
                    <button
                      onClick={() => setNotasPorDiaModoResumido(v => !v)}
                      className="flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print"
                      title="Alterna entre lista dia a dia e faixas de dias consecutivos (ex: 01 a 31)"
                    >
                      {notasPorDiaModoResumido ? 'Ver dia a dia' : 'Ver por período'}
                    </button>
                  </div>
                  <div className="overflow-y-auto max-h-72">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white dark:bg-slate-900">
                        <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-100 dark:border-slate-800">
                          <th className="py-1.5 pr-4">{notasPorDiaModoResumido ? 'Período' : 'Data'}</th>
                          <th className="py-1.5 text-right">Notas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notasPorDiaModoResumido ? (
                          periodoAnalise.diasDetalhadosComContagem?.map((faixa, idx) => (
                            <tr key={idx} className="border-b border-slate-50 dark:border-slate-800 last:border-0">
                              <td className="py-1.5 pr-4 font-mono text-slate-600 dark:text-slate-400">{faixa.label}</td>
                              <td className="py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300">{faixa.totalNotas}</td>
                            </tr>
                          ))
                        ) : (
                          periodoAnalise.diasComContagem.map((dia, idx) => (
                            <tr key={idx} className="border-b border-slate-50 dark:border-slate-800 last:border-0">
                              <td className="py-1.5 pr-4 font-mono text-slate-600 dark:text-slate-400">{dia.data}</td>
                              <td className="py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300">{dia.count}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                      <tfoot className="sticky bottom-0 bg-white dark:bg-slate-900">
                        <tr className="border-t border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 font-black text-slate-500 dark:text-slate-400 text-xs">Total</td>
                          <td className="py-1.5 text-right font-black text-slate-700 dark:text-slate-300">{periodoAnalise.totalNotas ?? 0}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {showCfopBreakdown && breakdownPorCfop.length > 0 && (
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Totais por Natureza da Operação (CFOP)</div>
                    <button
                      onClick={() => setShowCfopPorModelo(v => !v)}
                      className="flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print"
                      title="Mostra o valor de cada CFOP separado por NF-e (mod 55) e NFC-e (mod 65)"
                    >
                      {showCfopPorModelo ? 'Ocultar por modelo' : 'Detalhar por NF-e/NFC-e'}
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                          <th className="py-2 pr-4">CFOP</th>
                          <th className="py-2 pr-4">Natureza</th>
                          {showCfopPorModelo && (
                            <>
                              <th className="py-2 pr-4 text-right whitespace-nowrap">NF-e (mod 55)</th>
                              <th className="py-2 pr-4 text-right whitespace-nowrap">NFC-e (mod 65)</th>
                            </>
                          )}
                          <th className="py-2 pr-4 text-right whitespace-nowrap">Vlr Contábil</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPorCfop.map(({ cfop, descricao, valor }) => {
                          const alerta = isAlertCfop(cfop);
                          const porModelo = breakdownPorCfopPorModelo[cfop];
                          return (
                            <tr key={cfop} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                              <td className={`py-2 pr-4 font-mono font-bold ${alerta ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>{cfop}</td>
                              <td className={`py-2 pr-4 ${alerta ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-slate-700 dark:text-slate-300'}`}>{descricao}</td>
                              {showCfopPorModelo && (
                                <>
                                  <td className="py-2 pr-4 text-right text-slate-500 dark:text-slate-400">{formatarMoeda(porModelo?.nfe ?? 0)}</td>
                                  <td className="py-2 pr-4 text-right text-slate-500 dark:text-slate-400">{formatarMoeda(porModelo?.nfce ?? 0)}</td>
                                </>
                              )}
                              <td className={`py-2 pr-4 text-right font-semibold ${alerta ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>{formatarMoeda(valor)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={showCfopPorModelo ? 4 : 2} className="py-3 pr-4 font-black text-slate-900 dark:text-slate-100 uppercase text-xs tracking-wider">Total de Saídas</td>
                          <td className="py-3 pr-4 text-right font-black text-emerald-600 dark:text-emerald-400">
                            {formatarMoeda(breakdownPorCfop.reduce((acc, item) => acc + item.valor, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Painel de problemas reais: sem protocolo + número duplicado */}
              {(notasAnomalias.semProtocolo.length > 0 || notasAnomalias.numeroDuplicado.length > 0) && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 border-l-amber-400 rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500" />
                      <div>
                        <div className="flex items-baseline gap-3">
                          <div className="text-sm font-bold text-amber-700 tracking-wide">Contingência Não Regularizada</div>
                          {notasAnomalias.semProtocolo.length > 0 && (
                            <div className="text-sm font-bold text-amber-700">{formatarMoeda(notasAnomalias.semProtocolo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}</div>
                          )}
                        </div>
                        <div className="text-xs text-amber-600 mt-0.5">
                          {notasAnomalias.semProtocolo.length > 0 && (
                            <span>{notasAnomalias.semProtocolo.length} nota(s) emitida(s) offline sem autorização SEFAZ{notasAnomalias.numeroDuplicado.length > 0 ? ' · ' : ''}</span>
                          )}
                          {notasAnomalias.numeroDuplicado.length > 0 && (
                            <span>{notasAnomalias.numeroDuplicado.length} número(s) com chave duplicada</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowAnomalias(!showAnomalias)}
                      className="text-xs font-bold text-amber-600 hover:text-amber-800 underline no-print"
                    >
                      {showAnomalias ? 'Ocultar' : 'Ver detalhes'}
                    </button>
                  </div>

                  {showAnomalias && (
                    <div className="space-y-6">
                      {notasAnomalias.semProtocolo.length > 0 && (
                        <div>
                          <div className="text-xs font-black text-amber-700 uppercase tracking-wider mb-2">
                            Emitidas em Contingência sem Autorização SEFAZ — excluídas do total válido
                          </div>
                          <div className="overflow-x-auto overflow-y-auto max-h-72">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-amber-50">
                                <tr className="text-left text-amber-600 font-bold border-b border-amber-200">
                                  <th className="py-1.5 pr-3">Série</th>
                                  <th className="py-1.5 pr-3">Nº</th>
                                  <th className="py-1.5 pr-3">Data</th>
                                  <th className="py-1.5 pr-3">Chave</th>
                                  <th className="py-1.5 text-right">Valor</th>
                                </tr>
                              </thead>
                              <tbody>
                                {notasAnomalias.semProtocolo.map((xml, i) => (
                                  <tr key={i} className="border-b border-amber-100 last:border-0">
                                    <td className="py-1.5 pr-3 font-mono text-amber-800">{xml.serie}</td>
                                    <td className="py-1.5 pr-3 font-mono text-amber-800">{xml.numero}</td>
                                    <td className="py-1.5 pr-3 text-amber-700">{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                    <td className="py-1.5 pr-3 font-mono text-amber-600 text-[10px] truncate max-w-[180px]" title={xml.chave}>{xml.chave || '—'}</td>
                                    <td className="py-1.5 text-right font-semibold text-amber-800">{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr>
                                  <td colSpan={4} className="py-2 font-black text-amber-700 text-xs">Total excluído</td>
                                  <td className="py-2 text-right font-black text-amber-700">
                                    {formatarMoeda(notasAnomalias.semProtocolo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}

                      {notasAnomalias.numeroDuplicado.length > 0 && (
                        <div>
                          <div className="text-xs font-black text-amber-700 uppercase tracking-wider mb-2">
                            Números com Mais de uma Chave — possível contingência re-emitida
                          </div>
                          <div className="space-y-3">
                            {notasAnomalias.numeroDuplicado.map((grupo, i) => (
                              <div key={i} className="bg-white rounded-lg border border-amber-200 p-3">
                                <div className="text-xs font-bold text-amber-700 mb-2">
                                  Série {grupo[0].serie} · Nº {grupo[0].numero}
                                </div>
                                <div className="space-y-1">
                                  {grupo.map((xml, j) => (
                                    <div key={j} className="flex items-center gap-2 text-xs">
                                      <span className={`px-1.5 py-0.5 rounded font-bold ${xml.protocolo ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                                        {xml.protocolo ? '✓ COM protocolo' : '✗ SEM protocolo'}
                                      </span>
                                      <span className="font-mono text-slate-500 text-[10px] truncate flex-1" title={xml.chave}>{xml.chave}</span>
                                      <span className="font-semibold text-slate-700 shrink-0">{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Card: Notas Malformadas (cancelamento disfarçado + chave inconsistente com os dados internos + checklist de estrutura) */}
              {notasAnomalias.malformadas.length > 0 && (() => {
                const excluidas = notasAnomalias.malformadas.filter(x => !x.contaNoFaturamento);
                const paraConferir = notasAnomalias.malformadas.filter(x => x.contaNoFaturamento);
                const valorExcluido = excluidas.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0);
                return (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                      <div>
                        <div className="flex items-baseline gap-3">
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Notas Malformadas</div>
                          {valorExcluido > 0 && (
                            <div className="text-sm font-bold text-rose-600 dark:text-rose-400">
                              {formatarMoeda(valorExcluido)} excluído
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {excluidas.length > 0 && <>{excluidas.length} cancelamento(s) disfarçado(s) (excluída{excluidas.length > 1 ? 's' : ''} do total válido)</>}
                          {excluidas.length > 0 && paraConferir.length > 0 && ' · '}
                          {paraConferir.length > 0 && <>{paraConferir.length} pra conferir (continua{paraConferir.length > 1 ? 'm' : ''} contando no faturamento)</>}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowMalformadas(!showMalformadas)}
                      className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print shrink-0"
                    >
                      {showMalformadas ? 'Ocultar' : 'Ver detalhes'}
                    </button>
                  </div>

                  {showMalformadas && (
                    <div>
                      <div className="mb-3 text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-1">
                        <div className="flex items-start gap-2">
                          <span className="inline-block w-2 h-2 rounded-full mt-1 shrink-0" style={{background: '#BE123C'}} />
                          <span><strong className="text-slate-700 dark:text-slate-300">Cancelamento disfarçado</strong> — o próprio XML já veio com cStat/xMotivo de cancelamento em vez do evento separado (tpEvento=110111). Excluída do faturamento.</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="inline-block w-2 h-2 rounded-full mt-1 shrink-0" style={{background: '#B45309'}} />
                          <span><strong className="text-slate-700 dark:text-slate-300">Chave ou estrutura pra conferir</strong> — a chave de acesso não bate com os dados internos do XML, ou algum campo básico do leiaute (CNPJ, modelo, valor, data) está fora do padrão. Pode ser corrupção do arquivo — não prova que a venda é inválida, então continua contando no faturamento.</span>
                        </div>
                      </div>
                      <div className="overflow-x-auto overflow-y-auto max-h-72">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                            <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                              <th className="py-1.5 pr-3">Tipo</th>
                              <th className="py-1.5 pr-3">Série</th>
                              <th className="py-1.5 pr-3">Nº</th>
                              <th className="py-1.5 pr-3">Data</th>
                              <th className="py-1.5 pr-3">Chave</th>
                              <th className="py-1.5 pr-3">Motivo</th>
                              <th className="py-1.5 pr-3">Baixar</th>
                              <th className="py-1.5 text-right">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notasAnomalias.malformadas.map((xml, i) => (
                              <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">{xml.modelo === '65' ? 'NFC-e' : xml.modelo === '55' ? 'NF-e' : (xml.modelo ? `Mod. ${xml.modelo}` : '—')}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{xml.serie}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{xml.numero}</td>
                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400 text-[10px] truncate max-w-[180px]" title={xml.chave}>{xml.chave || '—'}</td>
                                <td className="py-1.5 pr-3 max-w-[220px]">
                                  <span
                                    className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold mb-1"
                                    style={xml.contaNoFaturamento
                                      ? {background: 'rgba(245,158,11,0.15)', color: '#B45309'}
                                      : {background: 'rgba(244,63,94,0.15)', color: '#BE123C'}}
                                  >
                                    {xml.contaNoFaturamento ? 'Conferir — não afeta faturamento' : 'Cancelamento disfarçado — excluída'}
                                  </span>
                                  <div className="text-slate-500 dark:text-slate-400" title={xml.motivoMalformada}>{xml.motivoMalformada}</div>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <button
                                    onClick={() => baixarXmlEvidencia(xml)}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                  >
                                    <Download className="w-3 h-3" />
                                    XML
                                  </button>
                                </td>
                                <td className="py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
                );
              })()}

              {/* Card: Sem Autorização (não contingência) */}
              {notasAnomalias.semAutorizacaoNaoContingencia.length > 0 && (
                <div className="bg-white dark:bg-slate-900 border-l-4 border-l-slate-400 border border-slate-200 dark:border-slate-700 rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <Ban className="w-5 h-5 text-slate-400 dark:text-slate-500" />
                      <div>
                        <div className="flex items-baseline gap-3">
                          <div className="text-sm font-bold text-slate-600 dark:text-slate-300 tracking-wide">Sem Autorização</div>
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                            {formatarMoeda(notasAnomalias.semAutorizacaoNaoContingencia.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                          </div>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {notasAnomalias.semAutorizacaoNaoContingencia.length} nota(s) sem protocolo SEFAZ e sem flag de contingência — excluídas do total válido
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowSemAutorizacao(!showSemAutorizacao)}
                      className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print"
                    >
                      {showSemAutorizacao ? 'Ocultar' : 'Ver detalhes'}
                    </button>
                  </div>

                  {showSemAutorizacao && (
                    <div>
                      <div className="text-xs font-black text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                        Emitidas sem autorização SEFAZ — excluídas do total válido
                      </div>
                      <div className="mb-3 text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
                        <span className="font-bold">Por que caiu aqui:</span> o XML dessas notas não tem o bloco <code className="font-mono">&lt;protNFe&gt;</code> (com <code className="font-mono">nProt</code>/<code className="font-mono">cStat</code>) — só o pedido de emissão assinado, sem a resposta de autorização do SEFAZ anexada. Isso costuma acontecer quando o sistema do emissor exporta o XML da nota separado do protocolo. Não significa necessariamente que a nota foi rejeitada: baixe o XML completo direto do portal do SEFAZ (ou do sistema emissor) pra confirmar — se ele vier com <code className="font-mono">cStat 100</code>, é só substituir o arquivo.
                      </div>
                      <div className="overflow-x-auto overflow-y-auto max-h-72">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                            <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                              <th className="py-1.5 pr-3">Série</th>
                              <th className="py-1.5 pr-3">Nº</th>
                              <th className="py-1.5 pr-3">Data</th>
                              <th className="py-1.5 pr-3">Chave</th>
                              <th className="py-1.5 text-right">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notasAnomalias.semAutorizacaoNaoContingencia.map((xml, i) => (
                              <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{xml.serie}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{xml.numero}</td>
                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400 text-[10px] truncate max-w-[180px]" title={xml.chave}>{xml.chave || '—'}</td>
                                <td className="py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300">
                                  <div>{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</div>
                                  {xml.temInutilizacao && (
                                    <div className="mt-0.5 text-[10px] font-bold text-orange-600 dark:text-orange-300 bg-orange-100 dark:bg-orange-950 rounded px-1.5 py-0.5 text-right whitespace-nowrap">
                                      ⚠ Série/Nº inutilizado
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={4} className="py-2 font-black text-slate-600 dark:text-slate-300 text-xs">Total excluído</td>
                              <td className="py-2 text-right font-black text-slate-700 dark:text-slate-200">
                                {formatarMoeda(notasAnomalias.semAutorizacaoNaoContingencia.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                      {notasAnomalias.semAutorizacaoNaoContingencia.some(x => x.temInutilizacao) && (
                        <div className="mt-3 text-xs text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2">
                          <span className="font-bold">⚠ Atenção:</span> uma ou mais notas acima têm o mesmo série/número de uma inutilização registrada. Verifique se a numeração foi reaproveitada indevidamente.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Painel informativo: contingência autorizada fora do prazo */}
              {notasAnomalias.foraDoPrazo.length > 0 && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 border-l-orange-400 rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <Clock className="w-5 h-5 text-orange-400" />
                      <div>
                        <div className="flex items-baseline gap-3">
                          <div className="text-sm font-bold text-orange-700 tracking-wide">Contingência Regularizada Fora do Prazo</div>
                          <div className="text-sm font-bold text-orange-700">{formatarMoeda(notasAnomalias.foraDoPrazo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}</div>
                        </div>
                        <div className="text-xs text-orange-600 mt-0.5">
                          {notasAnomalias.foraDoPrazo.length} nota(s) emitida(s) offline e autorizada(s) pelo SEFAZ com atraso superior a 30 min — incluídas no faturamento
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowForaDoPrazo(!showForaDoPrazo)}
                      className="text-xs font-bold text-orange-600 hover:text-orange-800 underline no-print"
                    >
                      {showForaDoPrazo ? 'Ocultar' : 'Ver detalhes'}
                    </button>
                  </div>

                  {showForaDoPrazo && (
                    <div className="overflow-x-auto overflow-y-auto max-h-72">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-orange-50">
                          <tr className="text-left text-orange-600 font-bold border-b border-orange-200">
                            <th className="py-1.5 pr-3">Série</th>
                            <th className="py-1.5 pr-3">Nº</th>
                            <th className="py-1.5 pr-3">Emissão</th>
                            <th className="py-1.5 pr-3">Autorização SEFAZ</th>
                            <th className="py-1.5 text-right">Valor</th>
                          </tr>
                        </thead>
                        <tbody>
                          {notasAnomalias.foraDoPrazo.map((xml, i) => {
                            const emi = xml.data ? new Date(xml.data) : null;
                            const rec = xml.dhRecbto ? new Date(xml.dhRecbto) : null;
                            const diffMin = (emi && rec) ? Math.round((rec.getTime() - emi.getTime()) / 60_000) : null;
                            return (
                              <tr key={i} className="border-b border-orange-100 last:border-0">
                                <td className="py-1.5 pr-3 font-mono text-orange-800">{xml.serie}</td>
                                <td className="py-1.5 pr-3 font-mono text-orange-800">{xml.numero}</td>
                                <td className="py-1.5 pr-3 text-orange-700">{emi ? emi.toLocaleString('pt-BR') : '—'}</td>
                                <td className="py-1.5 pr-3 text-orange-700">
                                  {rec ? rec.toLocaleString('pt-BR') : '—'}
                                  {diffMin !== null && (
                                    <span className="ml-1.5 text-orange-500 font-semibold">
                                      +{diffMin < 60 ? `${diffMin}min` : diffMin < 1440 ? `${Math.round(diffMin / 60)}h` : `${Math.round(diffMin / 1440)}d`}
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 text-right font-semibold text-orange-800">{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={4} className="py-2 font-black text-orange-700 text-xs">Total incluído no faturamento</td>
                            <td className="py-2 text-right font-black text-orange-700">
                              {formatarMoeda(notasAnomalias.foraDoPrazo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Card: Auditoria de IBS/CBS (Reforma Tributária) — aberto pelo card compacto na lateral direita */}
              {showAuditoriaIbsCbs && auditoriaIbsCbs.totalNotas > 0 && (() => {
                const corBordaIbsCbs = auditoriaIbsCbs.pctComGrupo === 0
                  ? 'border-l-rose-400'
                  : auditoriaIbsCbs.pctComGrupo === 100 ? 'border-l-emerald-400' : 'border-l-amber-400';
                return (
                  <div className={cn("bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 rounded-xl p-6 mb-6", corBordaIbsCbs)}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <Receipt className="w-5 h-5 text-blue-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Auditoria de IBS/CBS (Reforma Tributária)</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            <strong className={cn(
                              auditoriaIbsCbs.pctComGrupo === 0 ? "text-rose-600 dark:text-rose-400" : auditoriaIbsCbs.pctComGrupo === 100 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                            )}>{auditoriaIbsCbs.notasComGrupo} de {auditoriaIbsCbs.totalNotas} nota(s) ({formatarPct(auditoriaIbsCbs.pctComGrupo)}%)</strong> já trazem o grupo IBS/CBS preenchido
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 no-print">
                        <button
                          onClick={abrirPerfilCliente}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                          title="Baixa o Perfil do Cliente em HTML (clientes, fornecedores, produtos, sazonalidade e Reforma Tributária) — tópicos expansíveis, pra orientar o cliente"
                        >
                          <Download className="w-3 h-3" />
                          Exportar Perfil do Cliente
                        </button>
                        <button
                          onClick={() => setShowAuditoriaIbsCbs(false)}
                          className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline"
                        >
                          Ocultar
                        </button>
                      </div>
                    </div>

                    <div className="space-y-4">
                        {auditoriaIbsCbs.pctComGrupo === 0 && (
                          <div className="rounded-lg px-4 py-3 text-xs bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                            ⚠ Nenhuma nota desse período traz o grupo &lt;IBSCBS&gt; preenchido — 2026 é o período de teste da Reforma Tributária (0,1% IBS + 0,9% CBS, compensável). O sistema de emissão do cliente ainda não parece estar adaptado; vale confirmar com o suporte do sistema antes de virar obrigatório de verdade.
                          </div>
                        )}
                        {auditoriaIbsCbs.pctComGrupo === 100 && (
                          <div className="rounded-lg px-4 py-3 text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                            ✓ 100% das notas desse período já trazem o grupo IBS/CBS — sistema do cliente parece adaptado à Reforma Tributária.
                          </div>
                        )}
                        {auditoriaIbsCbs.pctComGrupo > 0 && auditoriaIbsCbs.pctComGrupo < 100 && (
                          <div className="rounded-lg px-4 py-3 text-xs bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            ⚠ Só parte das notas traz o grupo IBS/CBS — pode ser uma atualização de sistema no meio do período (confira as datas das amostras abaixo) ou inconsistência a esclarecer com o suporte do sistema.
                          </div>
                        )}

                        {auditoriaIbsCbs.amostraSemGrupo.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Amostra sem o grupo IBS/CBS ({auditoriaIbsCbs.amostraSemGrupo.length})</div>
                            <div className="overflow-x-auto overflow-y-auto max-h-56">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                  <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                    <th className="py-1.5 pr-3">Série</th>
                                    <th className="py-1.5 pr-3">Nº</th>
                                    <th className="py-1.5 pr-3">Data</th>
                                    <th className="py-1.5">Baixar</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auditoriaIbsCbs.amostraSemGrupo.map((n, i) => (
                                    <tr key={n.chave || i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.serie}</td>
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.numero}</td>
                                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                                      <td className="py-1.5">
                                        <button
                                          onClick={() => baixarXmlEvidencia(n)}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                        >
                                          <Download className="w-3 h-3" />
                                          XML
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {auditoriaIbsCbs.amostraComGrupo.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Amostra com o grupo IBS/CBS ({auditoriaIbsCbs.amostraComGrupo.length})</div>
                            <div className="overflow-x-auto overflow-y-auto max-h-56">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                  <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                    <th className="py-1.5 pr-3">Série</th>
                                    <th className="py-1.5 pr-3">Nº</th>
                                    <th className="py-1.5 pr-3">Data</th>
                                    <th className="py-1.5">Baixar</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auditoriaIbsCbs.amostraComGrupo.map((n, i) => (
                                    <tr key={n.chave || i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.serie}</td>
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.numero}</td>
                                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                                      <td className="py-1.5">
                                        <button
                                          onClick={() => baixarXmlEvidencia(n)}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                        >
                                          <Download className="w-3 h-3" />
                                          XML
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Validação estrutural de cClassTrib × tabela oficial — só código × código,
                            sem nenhuma interpretação de produto/NCM (essa fica pro contador). */}
                        {auditoriaClassTrib.totalItens > 0 && (
                          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
                            <div className="flex items-center justify-between mb-1">
                              <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                Validação cClassTrib × Tabela Oficial
                              </div>
                              <button
                                onClick={exportarLaudoIbsCbs}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors no-print"
                                title="Abre o laudo em uma janela pra imprimir/salvar como PDF — com a lista de produtos do cadastro do cliente dentro de cada código, pra identificar visualmente qual classificação destoa"
                              >
                                <Download className="w-3 h-3" />
                                Exportar Laudo (PDF)
                              </button>
                            </div>
                            <div className="text-[11px] text-slate-400 dark:text-slate-500 mb-3">
                              {CCLASSTRIB_VERSAO} · {auditoriaClassTrib.totalItens} item(ns) em {auditoriaClassTrib.totalNotas} nota(s) verificados · checagem estrutural (formato, prefixo CST, existência, vigência, modelo e redução) — não avalia se o código escolhido é o adequado pro produto
                            </div>

                            {auditoriaClassTrib.problemas.length === 0 ? (
                              <div className="rounded-lg px-4 py-3 text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                ✓ Todos os {auditoriaClassTrib.totalItens} itens usam códigos existentes na tabela oficial, vigentes na data de emissão, permitidos pro modelo do documento e com redução de alíquota compatível.
                              </div>
                            ) : (
                              <div className="space-y-2 mb-3">
                                {auditoriaClassTrib.problemas.map((p, i) => (
                                  <div
                                    key={i}
                                    className={cn(
                                      'rounded-lg px-4 py-2.5 text-xs border flex items-start gap-2',
                                      p.nivel === 'erro'
                                        ? 'bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                                        : 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                                    )}
                                  >
                                    <span className="shrink-0 font-bold">{p.nivel === 'erro' ? '🔴' : '🟡'}</span>
                                    <span>
                                      <strong className="font-mono">{p.code}</strong> — {p.motivo}
                                      <span className="block mt-0.5 opacity-75">
                                        {p.itens} item(ns) em {p.notas.size} nota(s) · ex: nota {p.exemplo}
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {auditoriaClassTrib.cclassTribUnicoSuspeito && (
                              <div className="rounded-lg px-4 py-2.5 text-xs border bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 mb-3">
                                🟡 Só <strong className="font-mono">{auditoriaClassTrib.codigosUsados[0]?.code}</strong> foi usado no período inteiro, apesar de {auditoriaClassTrib.ncmsDistintos} NCMs distintos no catálogo — vale confirmar se o sistema do cliente está classificando produto a produto ou aplicando um valor fixo/padrão pra tudo. Cada código individual pode estar estruturalmente correto (por isso não vira erro acima) e ainda assim ser resultado de um cadastro que nunca foi de fato analisado.
                              </div>
                            )}

                            {auditoriaClassTrib.codigosUsados.length > 0 && (
                              <div className="mt-3">
                                <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Códigos em uso neste período</div>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-1.5 pr-3">cClassTrib</th>
                                        <th className="py-1.5 pr-3">Descrição oficial</th>
                                        <th className="py-1.5 pr-3 text-right">Red. IBS</th>
                                        <th className="py-1.5 pr-3 text-right">Red. CBS</th>
                                        <th className="py-1.5 pr-3 text-right">Itens</th>
                                        <th className="py-1.5 pr-3 text-right">Notas</th>
                                        <th className="py-1.5 pr-3 text-right">Valor (vProd)</th>
                                        <th className="py-1.5 text-right" title="Soma do vIBS + vCBS que o sistema do cliente destacou nos itens — leitura direta do XML, sem cálculo do app">IBS+CBS destacado</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {auditoriaClassTrib.codigosUsados.map(c => (
                                        <tr key={c.code} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                          <td className={cn('py-1.5 pr-3 font-mono', c.naTabela ? 'text-slate-700 dark:text-slate-300' : 'text-rose-600 dark:text-rose-400 font-bold')}>{c.code}</td>
                                          <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{c.nome}</td>
                                          <td className="py-1.5 pr-3 text-right text-slate-600 dark:text-slate-400">{c.naTabela ? `${c.redIBS}%` : '—'}</td>
                                          <td className="py-1.5 pr-3 text-right text-slate-600 dark:text-slate-400">{c.naTabela ? `${c.redCBS}%` : '—'}</td>
                                          <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{c.itens}</td>
                                          <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{c.notas.size}</td>
                                          <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{formatarMoeda(c.valor)}</td>
                                          <td className="py-1.5 text-right font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{formatarMoeda(c.vIBS + c.vCBS)}</td>
                                        </tr>
                                      ))}
                                      <tr className="border-t-2 border-slate-200 dark:border-slate-700">
                                        <td colSpan={6} className="py-1.5 pr-3 text-right text-slate-500 dark:text-slate-400 font-bold">Total do período</td>
                                        <td className="py-1.5 pr-3 text-right font-bold text-slate-700 dark:text-slate-200 tabular-nums">{formatarMoeda(auditoriaClassTrib.codigosUsados.reduce((s, c) => s + c.valor, 0))}</td>
                                        <td className="py-1.5 text-right font-bold text-slate-700 dark:text-slate-200 tabular-nums">{formatarMoeda(auditoriaClassTrib.totalIBS + auditoriaClassTrib.totalCBS)}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                                <div className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                                  "IBS+CBS destacado" é a soma do que o próprio sistema do cliente calculou e destacou nos itens (vIBS + vCBS do XML) — em 2026, período de teste da Reforma (0,1% IBS + 0,9% CBS), esse valor é compensável e não é recolhido de fato.
                                </div>
                                {(() => {
                                  // Nota com itens em códigos diferentes conta em cada linha onde
                                  // aparece — sem esse aviso a coluna "Notas" parece somável e a
                                  // soma ultrapassando o total parece bug.
                                  const aparicoesPorNota = new Map<string, number>();
                                  auditoriaClassTrib.codigosUsados.forEach(c =>
                                    c.notas.forEach(n => aparicoesPorNota.set(n, (aparicoesPorNota.get(n) || 0) + 1))
                                  );
                                  const notasMistas = Array.from(aparicoesPorNota.values()).filter(v => v > 1).length;
                                  if (notasMistas === 0) return null;
                                  const somaNotas = auditoriaClassTrib.codigosUsados.reduce((s, c) => s + c.notas.size, 0);
                                  return (
                                    <div className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                                      ℹ A coluna "Notas" não é somável: {notasMistas} nota(s) têm itens em mais de um código na mesma venda e contam em cada linha onde aparecem — por isso a soma da coluna dá {somaNotas}, acima das {auditoriaClassTrib.totalNotas} notas verificadas. "Itens" e "Valor" não se repetem e somam certinho.
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Conferência aritmética: o valor destacado bate com base × alíquota? */}
                        {auditoriaIbsCbsAritmetica.itensVerificados > 0 && (
                          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
                            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                              Conferência Aritmética do IBS/CBS
                            </div>
                            <div className="text-[11px] text-slate-400 dark:text-slate-500 mb-3">
                              {auditoriaIbsCbsAritmetica.itensVerificados} item(ns) em {auditoriaIbsCbsAritmetica.notasVerificadas} nota(s): valor destacado × (base × alíquota efetiva), vIBS = UF + Município, e totais da nota × soma dos itens (tolerância de R$ 0,01 por arredondamento)
                            </div>
                            {auditoriaIbsCbsAritmetica.divergencias.length === 0 ? (
                              <div className="rounded-lg px-4 py-3 text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                ✓ Toda a matemática confere — o sistema do cliente está calculando IBS e CBS de forma consistente.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {auditoriaIbsCbsAritmetica.divergencias.map((d, i) => (
                                  <div key={i} className="rounded-lg px-4 py-2.5 text-xs border bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 flex items-start gap-2">
                                    <span className="shrink-0 font-bold">🔴</span>
                                    <span>
                                      {d.motivo}
                                      <span className="block mt-0.5 opacity-75">{d.itens} ocorrência(s) em {d.notas.size} nota(s) · ex: nota {d.exemplo}</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Linha do tempo de cadastro por cProd: mesmo código interno mudou de NCM/CEST/cClassTrib no período?
                            Fechado por padrão — pode ter dezenas de linhas — mas com amostra de notas
                            (nº/série/chave) em cada valor, pra ter prova rápida sem precisar caçar. */}
                        {auditoriaCadastroProdutos.totalProdutos > 0 && (
                          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => setShowMudancasCadastro(!showMudancasCadastro)}
                                className="flex-1 flex items-center justify-between gap-3 text-left"
                              >
                                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                  Mudanças de Cadastro no Período — {auditoriaCadastroProdutos.mudancas.length} mudança{auditoriaCadastroProdutos.mudancas.length !== 1 ? 's' : ''} • {produtosSuspeitos.nomeDuplicado.length} nome{produtosSuspeitos.nomeDuplicado.length !== 1 ? 's' : ''} duplicado{produtosSuspeitos.nomeDuplicado.length !== 1 ? 's' : ''}
                                </span>
                                <ChevronRight className={cn("w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 transition-transform", showMudancasCadastro && "rotate-90")} />
                              </button>
                              {(auditoriaCadastroProdutos.mudancas.length > 0 || produtosSuspeitos.nomeDuplicado.length > 0) && (
                                <button
                                  onClick={exportarMudancasCadastroExcel}
                                  className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0 no-print"
                                  title="Exportar todas as mudanças de cadastro em Excel"
                                >
                                  Exportar Excel
                                </button>
                              )}
                            </div>

                            {showMudancasCadastro && (
                              <div className="mt-3">
                                <div className="text-[11px] text-slate-400 dark:text-slate-500 mb-3">
                                  {auditoriaCadastroProdutos.totalProdutos} produto(s) distinto(s) acompanhados pelo código interno (cProd) — NCM, CEST, cClassTrib, nome, código de barras (EAN) e benefício fiscal. CFOP e CST de ICMS ficam de fora porque variam legitimamente por tipo de operação.
                                </div>
                                {auditoriaCadastroProdutos.mudancas.length === 0 && produtosSuspeitos.nomeDuplicado.length === 0 ? (
                                  <div className="rounded-lg px-4 py-3 text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                    ✓ Nenhum produto mudou de cadastro nem teve nome duplicado em código diferente dentro do período — cadastro estável.
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    {auditoriaCadastroProdutos.mudancas.length > 0 && (
                                      <div>
                                        <div className="rounded-lg px-4 py-2.5 text-xs border bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 mb-2">
                                          🟡 {auditoriaCadastroProdutos.mudancas.length} mudança(s) de cadastro detectada(s) no meio do período — o mesmo código de produto saiu com classificações diferentes em datas diferentes. Vale confirmar se foi correção intencional ou mexida acidental no cadastro.
                                        </div>
                                        <div className="overflow-auto max-h-[420px] border border-slate-100 dark:border-slate-800 rounded-lg">
                                        <table className="w-full text-xs">
                                          <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                            <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                              <th className="py-1.5 pr-3 pl-3">cProd</th>
                                              <th className="py-1.5 pr-3">Produto</th>
                                              <th className="py-1.5 pr-3">Campo</th>
                                              <th className="py-1.5 pr-3">Valores no período (primeira → última aparição, amostra de notas)</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {auditoriaCadastroProdutos.mudancas.map((m, i) => (
                                              <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                                <td className="py-1.5 pr-3 pl-3 font-mono text-slate-700 dark:text-slate-300 align-top">{m.cProd}</td>
                                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400 align-top">{m.xProd}</td>
                                                <td className="py-1.5 pr-3 font-semibold text-slate-700 dark:text-slate-300 align-top">{m.campo}</td>
                                                <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">
                                                  {m.valores.map((v, j) => (
                                                    <div key={j} className={j > 0 ? "mt-1.5" : ""}>
                                                      <strong className="font-mono">{v.valor}</strong>
                                                      <span className="opacity-60"> ({v.primeira.split('-').reverse().join('/')} a {v.ultima.split('-').reverse().join('/')}, {v.itens} item(ns))</span>
                                                      {v.amostra.length > 0 && (
                                                        <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                                          ex: {v.amostra.map((a, k) => (
                                                            <span key={k} title={a.chave ? `Chave: ${a.chave}` : undefined}>
                                                              {k > 0 && ', '}
                                                              nº {a.numero || '?'}{a.serie ? `/${a.serie}` : ''} ({a.data.split('-').reverse().join('/')})
                                                            </span>
                                                          ))}
                                                        </div>
                                                      )}
                                                    </div>
                                                  ))}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                        </div>
                                      </div>
                                    )}

                                    {produtosSuspeitos.nomeDuplicado.length > 0 && (
                                      <div>
                                        <div className="rounded-lg px-4 py-2.5 text-xs border bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 mb-2">
                                          🟡 {produtosSuspeitos.nomeDuplicado.length} nome(s) de produto associado(s) a mais de um código interno (cProd) — pode ser cadastro duplicado (fragmenta estoque/relatório) ou um código reaproveitado pra outro produto.
                                        </div>
                                        <div className="overflow-auto max-h-[420px] border border-slate-100 dark:border-slate-800 rounded-lg">
                                          <table className="w-full text-xs">
                                            <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                              <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                                <th className="py-1.5 pr-3 pl-3">Produto</th>
                                                <th className="py-1.5 pr-3">cProd usados (amostra de nota)</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {produtosSuspeitos.nomeDuplicado.map((p, i) => (
                                                <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                                  <td className="py-1.5 pr-3 pl-3 text-slate-600 dark:text-slate-400 align-top">{p.xProd}</td>
                                                  <td className="py-1.5 pr-3 font-mono text-slate-600 dark:text-slate-400">
                                                    {p.cProds.map((c, k) => (
                                                      <div key={k} className={k > 0 ? "mt-1" : ""}>
                                                        <span>{c.cProd}</span>
                                                        <span
                                                          className="font-sans text-[10px] text-slate-400 dark:text-slate-500 ml-1"
                                                          title={c.amostra.chave ? `Chave: ${c.amostra.chave}` : undefined}
                                                        >
                                                          (nº {c.amostra.numero || '?'}{c.amostra.serie ? `/${c.amostra.serie}` : ''}, {c.amostra.data.split('-').reverse().join('/')})
                                                        </span>
                                                      </div>
                                                    ))}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Produtos suspeitos: NCM zerado e mistura revenda/produção própria */}
                        {(produtosSuspeitos.ncmZerado.length > 0 || produtosSuspeitos.cfopMisto.length > 0) && (
                          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
                            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                              Produtos Suspeitos
                            </div>

                            {produtosSuspeitos.ncmZerado.length > 0 && (
                              <div className="mb-3">
                                <div className="rounded-lg px-4 py-2.5 text-xs border bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 mb-2">
                                  🔴 {produtosSuspeitos.ncmZerado.length} produto(s) com NCM zerado (00000000) — cadastro incompleto, não é uma classificação tributária válida.
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-1.5 pr-3">cProd</th>
                                        <th className="py-1.5 pr-3">Produto</th>
                                        <th className="py-1.5">Ocorrências</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {produtosSuspeitos.ncmZerado.map((p, i) => (
                                        <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                          <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{p.cProd}</td>
                                          <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.xProd}</td>
                                          <td className="py-1.5 text-slate-600 dark:text-slate-400">{p.ocorrencias}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {produtosSuspeitos.cfopMisto.length > 0 && (
                              <div>
                                <div className="rounded-lg px-4 py-2.5 text-xs border bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 mb-2">
                                  🟡 {produtosSuspeitos.cfopMisto.length} produto(s) vendido(s) ora como produção própria, ora como revenda de mercadoria de terceiros — vale confirmar qual é a origem real.
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-slate-400 dark:text-slate-500 font-bold border-b border-slate-200 dark:border-slate-700">
                                        <th className="py-1.5 pr-3">cProd</th>
                                        <th className="py-1.5 pr-3">Produto</th>
                                        <th className="py-1.5 pr-3">CFOP produção própria</th>
                                        <th className="py-1.5">CFOP revenda</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {produtosSuspeitos.cfopMisto.map((p, i) => (
                                        <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                          <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{p.cProd}</td>
                                          <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.xProd}</td>
                                          <td className="py-1.5 pr-3 font-mono text-slate-600 dark:text-slate-400">{p.cfopsPropria.join(', ')}</td>
                                          <td className="py-1.5 font-mono text-slate-600 dark:text-slate-400">{p.cfopsRevenda.join(', ')}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                    </div>
                  </div>
                );
              })()}

              {/* Card: Auditoria de Pagamento (TEF) — aberto pelo card compacto na lateral direita */}
              {showAuditoriaPagamento && (auditoriaPagamento.totalCartao > 0 || auditoriaPagamento.totalCartaoNaoAplicavel > 0 || auditoriaPagamento.problemas.length > 0 || auditoriaPagamento.breakdownPorTipoPagamento.length > 0) && (() => {
                // Sem Math.round: 464/466 arredondaria pra "100%" e escondia os 2
                // POS manual (mesmo bug já corrigido no card de IBS/CBS).
                const pctNaoIntegrado = auditoriaPagamento.totalCartao > 0
                  ? (auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100
                  : 0;
                const pctIntegrado = auditoriaPagamento.totalCartao > 0
                  ? (auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100
                  : 0;
                const pctFalsoTef = auditoriaPagamento.totalCartao > 0
                  ? (auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100
                  : 0;
                const temProblemasTecnicos = auditoriaPagamento.problemas.length > 0;
                // Regime Normal tem obrigatoriedade de TEF — qualquer POS manual vira alerta real.
                // Simples Nacional não tem essa obrigatoriedade, então fica só informativo.
                const riscoObrigatoriedade = !regimeTributario.isSimples && !regimeTributario.isMei && regimeTributario.label !== null && auditoriaPagamento.totalNaoIntegrado > 0;
                const corBorda = temProblemasTecnicos || riscoObrigatoriedade
                  ? 'border-l-rose-400'
                  : pctNaoIntegrado >= 50 ? 'border-l-amber-400' : 'border-l-blue-400';
                return (
                  <div className={cn("bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 border-l-4 rounded-xl p-6 mb-6", corBorda)}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <CreditCard className="w-5 h-5 text-blue-500" />
                        <div>
                          <div className="flex items-baseline gap-3">
                            <div className="text-sm font-bold text-slate-700 dark:text-slate-200 tracking-wide">Auditoria de Pagamento (TEF)</div>
                            {temProblemasTecnicos && (
                              <div className="text-sm font-bold text-rose-600 dark:text-rose-400">{auditoriaPagamento.problemas.length} problema(s) técnico(s)</div>
                            )}
                            {riscoObrigatoriedade && (
                              <div className="text-sm font-bold text-rose-600 dark:text-rose-400">⚠ obrigatoriedade de TEF ({regimeTributario.label})</div>
                            )}
                            {auditoriaPagamento.totalFalsoTef > 0 && (
                              <div className="text-sm font-bold text-rose-600 dark:text-rose-400">⚠ {auditoriaPagamento.totalFalsoTef} Falso TEF</div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs">
                            <span className="text-slate-500 dark:text-slate-400" title="Vendas em cartão à vista, presenciais e dentro do mesmo estado — únicas sujeitas a TEF">
                              <strong className="text-slate-700 dark:text-slate-200">{auditoriaPagamento.totalCartao}</strong> sujeita(s) a TEF
                            </span>
                            <span className="text-slate-300 dark:text-slate-600">·</span>
                            <span className={auditoriaPagamento.totalIntegrado > 0 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-slate-400 dark:text-slate-500"} title="tpIntegra=1 com código de autorização — pagamento realmente integrado ao sistema (TEF de verdade)">
                              {auditoriaPagamento.totalIntegrado} integrada(s){auditoriaPagamento.totalCartao > 0 && ` (${formatarPct(pctIntegrado)}%)`}{auditoriaPagamento.totalIntegrado > 0 && ' ✓'}
                            </span>
                            <span className="text-slate-300 dark:text-slate-600">·</span>
                            <span className={auditoriaPagamento.totalNaoIntegrado > 0 ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-slate-400 dark:text-slate-500"} title="tpIntegra=2 — pagamento não integrado, digitado manualmente no POS">
                              {auditoriaPagamento.totalNaoIntegrado} POS manual{auditoriaPagamento.totalCartao > 0 && ` (${formatarPct(pctNaoIntegrado)}%)`}{auditoriaPagamento.totalNaoIntegrado > 0 && ' ⚠'}
                            </span>
                            {auditoriaPagamento.totalFalsoTef > 0 && (
                              <>
                                <span className="text-slate-300 dark:text-slate-600">·</span>
                                <span className="text-rose-600 dark:text-rose-400 font-semibold" title="tpIntegra=1 SEM código de autorização — a nota declara integração que os dados não confirmam">
                                  {auditoriaPagamento.totalFalsoTef} Falso TEF ({formatarPct(pctFalsoTef)}%) ⚠
                                </span>
                              </>
                            )}
                            {auditoriaPagamento.totalCartaoNaoAplicavel > 0 && (
                              <>
                                <span className="text-slate-300 dark:text-slate-600">·</span>
                                <button
                                  onClick={() => { setShowAuditoriaPagamento(true); setShowForaDoEscopoDetalhe(true); }}
                                  className="text-slate-400 dark:text-slate-500 underline decoration-dotted hover:text-slate-600 dark:hover:text-slate-300 no-print"
                                  title="Não presencial (e-commerce/teleatendimento) ou interestadual — TEF não se aplica. Clique pra ver quais notas são essas."
                                >
                                  {auditoriaPagamento.totalCartaoNaoAplicavel} fora do escopo
                                </button>
                                <span className="hidden print:inline text-slate-400 dark:text-slate-500">{auditoriaPagamento.totalCartaoNaoAplicavel} fora do escopo</span>
                              </>
                            )}
                          </div>
                          {auditoriaPagamento.totalCartao === 0 && auditoriaPagamento.totalCartaoNaoAplicavel === 0 && (
                            <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                              Os três números acima ficam zerados porque não há nenhuma venda em cartão neste período — não é erro, veja abaixo as formas de pagamento realmente usadas.
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 no-print">
                        <button
                          onClick={copiarResumoTEF}
                          className="flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                          title="Copia um resumo em texto (empresa, período, formas de pagamento, percentuais de TEF/POS) pra colar e enviar ao cliente"
                        >
                          {copiedResumoTEF ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedResumoTEF ? 'Copiado!' : 'Copiar Resumo'}
                        </button>
                        <button
                          onClick={abrirPerfilCliente}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                          title="Baixa o Perfil do Cliente em HTML (clientes, fornecedores, produtos, sazonalidade e Reforma Tributária) — tópicos expansíveis, pra orientar o cliente"
                        >
                          <Download className="w-3 h-3" />
                          Exportar Perfil do Cliente
                        </button>
                        <button
                          onClick={() => setShowAuditoriaPagamento(false)}
                          className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline"
                        >
                          Ocultar
                        </button>
                      </div>
                    </div>

                    <div className="space-y-4">
                        {auditoriaPagamento.breakdownPorTipoPagamento.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                              Por forma de pagamento
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                              {auditoriaPagamento.breakdownPorTipoPagamento.map(b => {
                                const temProblemaNesseTipo = auditoriaPagamento.problemas.some(p => p.tPag === b.tPag);
                                return (
                                  <div
                                    key={b.tPag}
                                    className={cn(
                                      "border rounded-lg px-3 py-2",
                                      temProblemaNesseTipo
                                        ? "bg-rose-50 dark:bg-rose-950 border-rose-200 dark:border-rose-800"
                                        : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                                    )}
                                  >
                                    <div className={cn(
                                      "text-[11px] font-semibold truncate flex items-center gap-1",
                                      temProblemaNesseTipo ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"
                                    )} title={b.tPagNome}>
                                      {temProblemaNesseTipo && '⚠ '}{b.tPagNome}
                                    </div>
                                    <div className={cn(
                                      "text-sm font-bold mt-0.5",
                                      temProblemaNesseTipo ? "text-rose-700 dark:text-rose-300" : "text-slate-800 dark:text-slate-100"
                                    )}>{formatarMoeda(b.valor)}</div>
                                    <div className={cn(
                                      "text-[11px]",
                                      temProblemaNesseTipo ? "text-rose-500 dark:text-rose-400" : "text-slate-400 dark:text-slate-500"
                                    )}>{b.qtd} pagamento{b.qtd !== 1 ? 's' : ''}</div>
                                  </div>
                                );
                              })}
                            </div>
                            {(() => {
                              const somaValores = auditoriaPagamento.breakdownPorTipoPagamento.reduce((s, b) => s + b.valor, 0);
                              const somaPagamentos = auditoriaPagamento.breakdownPorTipoPagamento.reduce((s, b) => s + b.qtd, 0);
                              const diffValor = Math.abs(somaValores - faturamentoTotal);
                              const valorBate = diffValor < 0.05;
                              // "Sem Pagamento indevido" (venda real com vPag=0 no XML) explica a
                              // diferença na maior parte das vezes — sem checar isso, o texto genérico
                              // manda o analista procurar sincronismo/período quando a causa já está
                              // detectada e listada na tabela de problemas técnicos logo abaixo.
                              const valorProblemasTPag90 = auditoriaPagamento.problemas
                                .filter(p => p.motivo.startsWith('Venda normal (finNFe=1)'))
                                .reduce((s, p) => s + (parseFloat(p.xml.valor || '0') || 0), 0);
                              const explicadoPorSemPagamento = !valorBate && valorProblemasTPag90 > 0 && Math.abs(diffValor - valorProblemasTPag90) < diffValor * 0.15;
                              return (
                                <div className="mt-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2.5 text-[11px] text-blue-800 dark:text-blue-200 space-y-1.5">
                                  <div className="font-bold uppercase tracking-wider text-[10px] text-blue-500 dark:text-blue-400">Observação sobre os números acima</div>
                                  <div>
                                    {valorBate ? '✓' : '⚠'} <strong>Valores:</strong> a soma das formas de pagamento ({formatarMoeda(somaValores)}) {valorBate ? 'bate exatamente' : 'diverge'} com o Total de Saídas Auditadas ({formatarMoeda(faturamentoTotal)})
                                    {valorBate
                                      ? <> — confirma que esse resumo usa o mesmo critério de nota válida (com protocolo de autorização, sem cancelamento) do restante do app.</>
                                      : explicadoPorSemPagamento
                                        ? <> — essa diferença de {formatarMoeda(diffValor)} <strong>não é erro de sincronismo</strong>: é explicada pelas notas sinalizadas abaixo como "Sem Pagamento" com valor real ({formatarMoeda(valorProblemasTPag90)} em vendas — o XML declara vPag=0 mesmo tendo vNF real, então esse valor não entra na soma das formas de pagamento, mas continua contando no Total de Saídas). Veja a tabela de problemas técnicos pra identificar as notas.</>
                                        : <> — verifique se há notas fora do período ou cancelamento não sincronizado.</>
                                    }
                                  </div>
                                  <div>
                                    ℹ <strong>Quantidades:</strong> {somaPagamentos} pagamento(s) somados sobre <strong>{auditoriaPagamento.totalNotasVendaLiquida} nota(s) de venda líquida</strong> (recebidas, com protocolo de autorização, descontando cancelamento e devolução)
                                    {auditoriaPagamento.notasComPagamentoDividido > 0
                                      ? <> — a soma dos pagamentos passa desse total porque {auditoriaPagamento.notasComPagamentoDividido} nota(s) tiveram pagamento dividido em mais de uma forma (ex: parte em dinheiro, parte no cartão), contando uma vez em cada tipo usado. Isso é esperado, não é erro.</>
                                      : <>, batendo certinho — nenhuma nota teve pagamento dividido neste período.</>
                                    }
                                    {' '}Se ao somar as formas de pagamento o total vier menor do que você espera, compare com esse número de vendas líquidas (não com o total bruto de notas recebidas, que ainda inclui cancelamento/devolução).
                                  </div>
                                  {auditoriaPagamento.saidaNaoVendaQtd > 0 && (
                                    <div>
                                      ✓ <strong>Saída que não é venda:</strong> {auditoriaPagamento.saidaNaoVendaQtd} nota(s) totalizando {formatarMoeda(auditoriaPagamento.saidaNaoVendaValor)} são remessa/transferência/devolução de compra/consignação (identificadas pelo CFOP) — entram no Total de Saídas normalmente, mas o app NÃO as trata como inconformidade por estarem "Sem Pagamento", porque essas operações legitimamente não têm cobrança. Só é sinalizado como problema quando o CFOP indica venda de verdade.
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {auditoriaPagamento.problemas.some(p => p.tPag === '90') && (
                              <div className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">
                                ⚠ "Sem Pagamento" aqui não significa venda sem valor — são notas de venda normal com valor real declaradas com o código errado (90 é só pra Ajuste/Devolução).
                              </div>
                            )}
                          </div>
                        )}

                        {auditoriaPagamento.totalCartao === 0 ? (
                          <div className="rounded-lg px-4 py-3 text-xs bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 space-y-1">
                            <div>
                              Nenhuma venda em cartão dentro do escopo de obrigatoriedade de TEF nesse período
                              {auditoriaPagamento.totalCartaoNaoAplicavel > 0 && <> — os {auditoriaPagamento.totalCartaoNaoAplicavel} pagamento(s) em cartão encontrados caem em pelo menos um destes motivos:</>}.
                            </div>
                            {auditoriaPagamento.totalCartaoNaoAplicavel > 0 && (
                              <ul className="pl-4 list-disc space-y-0.5">
                                <li className={auditoriaPagamento.foraEscopoNaoPresencial > 0 ? "font-semibold text-slate-700 dark:text-slate-200" : ""}>{auditoriaPagamento.foraEscopoNaoPresencial} não presencial (indPres ≠ 1/5 — e-commerce, teleatendimento, entrega; confira se não é presencial mal marcado no PDV)</li>
                                <li className={auditoriaPagamento.foraEscopoInterestadual > 0 ? "font-semibold text-slate-700 dark:text-slate-200" : ""}>{auditoriaPagamento.foraEscopoInterestadual} interestadual (UF do destinatário ≠ UF do emitente)</li>
                              </ul>
                            )}
                            {auditoriaPagamento.cartaoIndPagSuspeito > 0 && (
                              <div className="mt-1 text-amber-600 dark:text-amber-400">
                                ⚠ {auditoriaPagamento.cartaoIndPagSuspeito} pagamento(s) em cartão vieram com indPag=1 (a prazo) — tratados aqui como à vista pra fins de TEF, porque cartão é sempre recebido à vista pelo lojista (quem parcela é o cliente com a operadora). Mas esse padrão indica que o PDV do cliente pode estar preenchendo esse campo errado — vale confirmar com o suporte do sistema dele.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className={cn(
                            "rounded-lg px-4 py-3 text-xs",
                            riscoObrigatoriedade || auditoriaPagamento.totalFalsoTef > 0 ? "bg-rose-50 dark:bg-rose-950 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800"
                              : pctNaoIntegrado >= 50 ? "bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800"
                              : pctNaoIntegrado === 0 ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
                              : "bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                          )}>
                            {pctNaoIntegrado === 0 && auditoriaPagamento.totalFalsoTef === 0 ? (
                              <span className="font-bold">✓ 100% das vendas em cartão sujeitas a TEF passaram pelo TEF integrado</span>
                            ) : pctNaoIntegrado === 100 ? (
                              <span className="font-bold">⚠ Nenhuma das vendas em cartão sujeitas a TEF passou pelo TEF integrado — todas foram digitadas manualmente no POS (tpIntegra=2)</span>
                            ) : pctNaoIntegrado > 0 ? (
                              <><span className="font-bold">{formatarPct(pctNaoIntegrado)}% ({auditoriaPagamento.totalNaoIntegrado} de {auditoriaPagamento.totalCartao})</span> das vendas em cartão sujeitas a TEF foram digitadas manualmente no POS, sem passar pelo TEF integrado (tpIntegra=2)</>
                            ) : (
                              <><span className="font-bold">{formatarPct(pctIntegrado)}% ({auditoriaPagamento.totalIntegrado} de {auditoriaPagamento.totalCartao})</span> das vendas em cartão sujeitas a TEF passaram pelo TEF integrado de verdade (com código de autorização)</>
                            )}.
                            {auditoriaPagamento.totalFalsoTef > 0 && (
                              <span> <strong>⚠ Alerta grave: {auditoriaPagamento.totalFalsoTef} venda(s) ({formatarPct(pctFalsoTef)}%) dizem ter TEF integrado (tpIntegra=1) mas vieram SEM código de autorização</strong> — uma integração de verdade sempre traz esse código junto. Ou o PDV está configurado errado, ou o sistema está declarando integração que não existiu. Isso é mais grave que POS manual comum: é uma declaração que os próprios dados da nota contradizem. Cobre explicação do suporte do sistema do cliente.</span>
                            )}
                            {riscoObrigatoriedade && (
                              <span> <strong>Alerta: empresa é {regimeTributario.label} — tem obrigatoriedade de TEF.</strong> Esse é o padrão que costuma gerar autuação por falta de integração TEF. Confirme com o cliente se a maquininha realmente não é integrada ao sistema, ou se é falha de configuração.</span>
                            )}
                            {!riscoObrigatoriedade && (regimeTributario.isSimples || regimeTributario.isMei) && auditoriaPagamento.totalNaoIntegrado > 0 && (
                              <span> Empresa é <strong>{regimeTributario.label}</strong>, que não tem obrigatoriedade de TEF — uso de POS manual aqui não é, por si só, uma infração.</span>
                            )}
                            {!riscoObrigatoriedade && !regimeTributario.isSimples && !regimeTributario.isMei && pctNaoIntegrado >= 50 && (
                              <span> Esse é o padrão que costuma gerar autuação por falta de integração TEF — vale confirmar com o cliente se a maquininha realmente não é integrada ao sistema, ou se é falha de configuração.</span>
                            )}
                            {auditoriaPagamento.cartaoIndPagSuspeito > 0 && (
                              <div className="mt-1.5 text-amber-600 dark:text-amber-400">
                                ⚠ {auditoriaPagamento.cartaoIndPagSuspeito} pagamento(s) em cartão vieram com indPag=1 (a prazo) — tratados aqui como à vista pra fins de TEF, porque cartão é sempre recebido à vista pelo lojista. Padrão que indica PDV mal configurado; vale confirmar com o suporte do sistema do cliente.
                              </div>
                            )}
                          </div>
                        )}

                        {auditoriaPagamento.notasNaoIntegradas.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                              Amostra pra levantar prova — pesquise e baixe o XML de uma nota via POS manual
                            </div>
                            <input
                              type="text"
                              value={auditoriaPagamentoBusca}
                              onChange={e => setAuditoriaPagamentoBusca(e.target.value)}
                              placeholder="Buscar por número ou série..."
                              className="w-full max-w-xs mb-2 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
                            />
                            <div className="overflow-x-auto overflow-y-auto max-h-56">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                  <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                    <th className="py-1.5 pr-3">Série</th>
                                    <th className="py-1.5 pr-3">Nº</th>
                                    <th className="py-1.5 pr-3">Data</th>
                                    <th className="py-1.5 pr-3">Forma de Pagamento</th>
                                    <th className="py-1.5 text-right pr-3">Valor</th>
                                    <th className="py-1.5 pr-3">Baixar</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auditoriaPagamento.notasNaoIntegradas
                                    .filter(n => {
                                      const q = auditoriaPagamentoBusca.trim().toLowerCase();
                                      if (!q) return true;
                                      return (n.xml.numero || '').toLowerCase().includes(q) || (n.xml.serie || '').toLowerCase().includes(q);
                                    })
                                    .slice(0, 50)
                                    .map((n, i) => (
                                      <tr key={`${n.xml.chave || i}-${n.tPagNome}`} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                        <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.xml.serie}</td>
                                        <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.xml.numero}</td>
                                        <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.xml.data ? new Date(n.xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                        <td className="py-1.5 pr-3 font-semibold text-amber-700 dark:text-amber-400">{n.tPagNome}</td>
                                        <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(n.xml.valor || '0') || 0)}</td>
                                        <td className="py-1.5 pr-3">
                                          <button
                                            onClick={() => baixarXmlEvidencia(n.xml)}
                                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                          >
                                            <Download className="w-3 h-3" />
                                            XML
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                              {auditoriaPagamento.notasNaoIntegradas.filter(n => {
                                const q = auditoriaPagamentoBusca.trim().toLowerCase();
                                if (!q) return true;
                                return (n.xml.numero || '').toLowerCase().includes(q) || (n.xml.serie || '').toLowerCase().includes(q);
                              }).length > 50 && (
                                <p className="text-[11px] text-slate-400 mt-1.5">Mostrando 50 resultados. Refine a busca por número pra achar uma nota específica.</p>
                              )}
                              {auditoriaPagamento.notasNaoIntegradas.length !== auditoriaPagamento.totalNaoIntegrado && (
                                <p className="text-[11px] text-slate-400 mt-1.5">
                                  ℹ Essa tabela conta por venda; o total de {auditoriaPagamento.totalNaoIntegrado} POS manual no topo do card conta por pagamento — pode diferir se alguma venda teve mais de um pagamento manual na mesma forma. Isso é esperado, não é erro.
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {showForaDoEscopoDetalhe && auditoriaPagamento.notasForaDoEscopo.length > 0 && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">
                                Fora do escopo de TEF — quais notas são essas
                              </div>
                              <button
                                onClick={() => setShowForaDoEscopoDetalhe(false)}
                                className="text-[11px] font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 underline no-print"
                              >
                                Fechar
                              </button>
                            </div>
                            {auditoriaPagamento.totalCartaoNaoAplicavel !== auditoriaPagamento.notasForaDoEscopo.length && (
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">
                                ℹ {auditoriaPagamento.notasForaDoEscopo.length} nota(s) única(s) somando {auditoriaPagamento.totalCartaoNaoAplicavel} pagamento(s) em cartão fora do escopo — a diferença é porque pelo menos uma nota tem pagamento dividido em mais de uma forma no cartão (ex: parte no crédito, parte no débito), contando uma vez em cada linha da tabela abaixo. Isso é esperado, não é erro.
                              </div>
                            )}
                            <div className="overflow-x-auto overflow-y-auto max-h-56">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                  <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                    <th className="py-1.5 pr-3">Série</th>
                                    <th className="py-1.5 pr-3">Nº</th>
                                    <th className="py-1.5 pr-3">Data</th>
                                    <th className="py-1.5 pr-3">Motivo</th>
                                    <th className="py-1.5 text-right pr-3">Valor</th>
                                    <th className="py-1.5 pr-3">Baixar</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auditoriaPagamento.notasForaDoEscopo.map((n, i) => (
                                    <tr key={n.xml.chave || i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.xml.serie}</td>
                                      <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{n.xml.numero}</td>
                                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{n.xml.data ? new Date(n.xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400 capitalize">{n.motivo}</td>
                                      <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300">{formatarMoeda(parseFloat(n.xml.valor || '0') || 0)}</td>
                                      <td className="py-1.5 pr-3">
                                        <button
                                          onClick={() => baixarXmlEvidencia(n.xml)}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-700 dark:hover:bg-slate-600 transition-colors"
                                        >
                                          <Download className="w-3 h-3" />
                                          XML
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {temProblemasTecnicos && (
                          <div className="overflow-x-auto overflow-y-auto max-h-72">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                                <tr className="text-left text-slate-500 dark:text-slate-400 font-bold border-b border-slate-200 dark:border-slate-700">
                                  <th className="py-1.5 pr-3">Série</th>
                                  <th className="py-1.5 pr-3">Nº</th>
                                  <th className="py-1.5 pr-3">Data</th>
                                  <th className="py-1.5 pr-3">Pagamento</th>
                                  <th className="py-1.5 pr-3">tpIntegra</th>
                                  <th className="py-1.5 pr-3">Autorização</th>
                                  <th className="py-1.5 pr-3 text-right">Valor</th>
                                  <th className="py-1.5 pr-3">Motivo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {auditoriaPagamento.problemas.map((p, i) => (
                                  <tr key={i} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                    <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{p.xml.serie}</td>
                                    <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{p.xml.numero}</td>
                                    <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.xml.data ? new Date(p.xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                    <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.tPagNome}</td>
                                    <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">{p.tpIntegra || '—'}</td>
                                    <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400">{p.cardCAut || '—'}</td>
                                    <td className="py-1.5 pr-3 text-right font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">{formatarMoeda(parseFloat(p.xml.valor || '0') || 0)}</td>
                                    <td className="py-1.5 pr-3 text-rose-600 dark:text-rose-400 max-w-[280px]">{p.motivo}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                    </div>

                    {responsavelTecnico.email && (
                      <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
                        Responsável técnico do sistema (XML): {responsavelTecnico.contato && <>{responsavelTecnico.contato} · </>}{responsavelTecnico.email}{responsavelTecnico.foneFormatado && <> · {responsavelTecnico.foneFormatado}</>}{responsavelTecnico.cnpjFormatado && <> · CNPJ {responsavelTecnico.cnpjFormatado}</>}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Nota de homologação/teste (tpAmb=2) no meio da produção: não tem
                  validade fiscal e infla o faturamento auditado sem ninguém notar. */}
              {notasHomologacao.total > 0 && (
                <div className="bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800 rounded-xl p-4 text-sm text-rose-800 dark:text-rose-300">
                  <span className="font-bold">⚠ {notasHomologacao.total} nota(s) de AMBIENTE DE HOMOLOGAÇÃO (teste) misturada(s) no movimento.</span>{' '}
                  Nota emitida com tpAmb=2 não tem validade fiscal — não é venda de verdade e não deveria estar no lote. Confira a configuração do sistema emissor.
                  <span className="block mt-1 text-xs opacity-80">
                    {notasHomologacao.amostra.map(n => `${n.serie}/${n.numero}`).join(', ')}{notasHomologacao.total > notasHomologacao.amostra.length ? ` e mais ${notasHomologacao.total - notasHomologacao.amostra.length}…` : ''}
                  </span>
                </div>
              )}

              {(() => {
                // Portal buttons only show up automatically while the whole analysis found
                // zero matching inutilizações (once any is found, XML or manual, the
                // per-série boxes already cover it). The manual form, likewise, must
                // stay available as long as ANY série still has real faltantes —
                // otherwise confirming just one hides the panel and blocks the rest.
                // forcarPainelInutilizacao lets the analyst override both rules and pull
                // up the panel anyway, e.g. to double-check a série that already matched
                // some inutilizações elsewhere.
                const nenhumaInutilizacaoEncontrada = analysis.every(s => s.faltantesInutilizados.length === 0);
                const seriePendenteNfce = analysis.find(s => s.modelo === '65' && s.faltantes.length > 0);
                const seriePendenteNfe = analysis.find(s => s.modelo === '55' && s.faltantes.length > 0);
                const mostrarBotoesAuto = nenhumaInutilizacaoEncontrada && (seriePendenteNfce || seriePendenteNfe);
                const aindaHaFaltantes = analysis.some(s => s.faltantes.length > 0);
                const mostrarFormularioAuto = portalConsultado && aindaHaFaltantes;

                const exibirBotoes = mostrarBotoesAuto || (forcarPainelInutilizacao && !!(seriePendenteNfce || seriePendenteNfe));
                const exibirFormulario = mostrarFormularioAuto || (forcarPainelInutilizacao && aindaHaFaltantes);

                if (!exibirBotoes && !exibirFormulario) {
                  if (!aindaHaFaltantes) return null;
                  return (
                    <button
                      onClick={() => setForcarPainelInutilizacao(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100 text-xs font-bold transition-all no-print w-fit"
                    >
                      <Search className="w-3.5 h-3.5" />
                      Consultar/confirmar inutilização manualmente
                    </button>
                  );
                }

                const modelosComFaltante = Array.from(new Set(analysis.filter(s => s.faltantes.length > 0).map(s => s.modelo)));

                return (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col gap-3 no-print">
                    {exibirBotoes && (
                      <>
                        <div className="text-sm text-amber-800">
                          <span className="font-bold">Números faltantes sem inutilização correspondente.</span> Pode valer a pena conferir no portal da SEFAZ antes de fechar a análise.
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {seriePendenteNfce && (
                            <button
                              onClick={() => consultarInutilizadasNoPortal(seriePendenteNfce.cnpj, -1, PORTAL_INUTILIZADAS_NFCE_PE, '65')}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-all shrink-0"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              {copiedCnpjIdx === -1 ? 'CNPJ copiado! Abrindo portal...' : 'Consultar Inutilizações NFC-e no Portal'}
                            </button>
                          )}
                          {seriePendenteNfe && (
                            <button
                              onClick={() => consultarInutilizadasNoPortal(seriePendenteNfe.cnpj, -2, PORTAL_INUTILIZADAS_NFE_PE, '55')}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-all shrink-0"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              {copiedCnpjIdx === -2 ? 'CNPJ copiado! Abrindo portal...' : 'Consultar Inutilizações NF-e no Portal'}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    {exibirFormulario && (
                      <div className={cn("flex flex-wrap items-end gap-3", exibirBotoes && "pt-3 border-t border-amber-200")}>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Modelo</label>
                          <select
                            value={manualInutModelo}
                            onChange={(e) => setManualInutModelo(e.target.value)}
                            className="px-3 py-2 rounded-lg border border-amber-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                          >
                            {(modelosComFaltante.length > 0 ? modelosComFaltante : ['65', '55']).map(m => (
                              <option key={m} value={m}>{m === '55' ? 'NF-e (55)' : 'NFC-e (65)'}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Série</label>
                          <input
                            type="text"
                            value={manualInutSerie}
                            onChange={(e) => setManualInutSerie(e.target.value)}
                            placeholder="Ex: 101"
                            className="w-24 px-3 py-2 rounded-lg border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Nº Inicial</label>
                          <input
                            type="number"
                            value={manualInutIni}
                            onChange={(e) => setManualInutIni(e.target.value)}
                            className="w-28 px-3 py-2 rounded-lg border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Nº Final</label>
                          <input
                            type="number"
                            value={manualInutFim}
                            onChange={(e) => setManualInutFim(e.target.value)}
                            className="w-28 px-3 py-2 rounded-lg border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Data (no portal)</label>
                          <input
                            type="date"
                            value={manualInutData}
                            onChange={(e) => setManualInutData(e.target.value)}
                            className="px-3 py-2 rounded-lg border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <button
                          onClick={confirmarInutilizacaoManual}
                          className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-700 transition-all"
                        >
                          Confirmar Inutilização
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Filters */}
              <div className="bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-nowrap items-center gap-2 no-print">
                <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-bold text-xs px-1 shrink-0">
                  <Filter className="w-3.5 h-3.5" />
                  FILTROS:
                </div>
                <select
                  value={filterModelo}
                  onChange={(e) => setFilterModelo(e.target.value)}
                  className="bg-slate-50 dark:bg-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-none shrink-0"
                >
                  <option value="Todos">Todos os Modelos</option>
                  <option value="55">Modelo 55 (NF-e)</option>
                  <option value="65">Modelo 65 (NFC-e)</option>
                </select>
                <select
                  value={filterMes}
                  onChange={(e) => setFilterMes(e.target.value)}
                  className="bg-slate-50 dark:bg-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-none shrink-0"
                >
                  <option value="Todos">Todos os Meses</option>
                  {mesesDisponiveis.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <div className="relative shrink-0">
                  <button
                    onClick={() => setShowExportXmlMenu(v => !v)}
                    className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Exportar XMLs ({filterMes === 'Todos' ? 'Todos' : filterMes})
                  </button>
                  {showExportXmlMenu && (
                    <div className="absolute left-0 top-full mt-2 z-20 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden w-52">
                      <div className="px-4 py-2 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800">Dividir em quantos arquivos?</div>
                      {([1, 2, 3] as const).map(n => (
                        <button
                          key={n}
                          onClick={() => { setExportPartes(n); setShowExportXmlMenu(false); exportFilteredXmls(n); }}
                          className="w-full text-left px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2"
                        >
                          <span className="w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-black flex items-center justify-center">{n}</span>
                          {n === 1 ? '1 arquivo (padrão)' : `${n} arquivos`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative shrink-0">
                  <button
                    onClick={() => setShowExportOptions(!showExportOptions)}
                    className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Planilha Detalhada
                    <ChevronRight className={cn("w-3 h-3 transition-transform duration-300", showExportOptions && "rotate-90")} />
                  </button>
                  {showExportOptions && (
                    <div className="absolute left-0 top-full mt-2 z-20 w-72 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden">
                      <button
                        onClick={() => { exportarPlanilhaDetalhadaCompleta(); setShowExportOptions(false); }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all border-b border-slate-100 dark:border-slate-800"
                      >
                        <div className="text-sm font-bold text-slate-900 dark:text-slate-100">Completo</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Layout igual ao Questor, com todas as 46 colunas (ICMS, IPI, ISS, ST, etc).</div>
                      </button>
                      <button
                        onClick={() => { exportarPlanilhaDetalhadaSimples(); setShowExportOptions(false); }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all border-b border-slate-100 dark:border-slate-800"
                      >
                        <div className="text-sm font-bold text-slate-900 dark:text-slate-100">Confronto Simples</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Só Natureza, NCM, Item e Valor Contábil, mais Desconto em diante quando tiver valor.</div>
                      </button>
                      <button
                        onClick={() => { exportarPlanilhaCompletaXML(); setShowExportOptions(false); }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                      >
                        <div className="text-sm font-bold text-slate-900 dark:text-slate-100">XML → Excel (12 abas)</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Todos os campos do XML, um por coluna, divididos em Identificação/Emitente/Destinatário/Itens/Total/Pagamento/etc — igual a um conversor de XML dedicado.</div>
                      </button>
                    </div>
                  )}
                </div>
                <input
                  ref={auditoriaInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) runAuditoriaXml(file);
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => auditoriaInputRef.current?.click()}
                  disabled={auditoriaLoading}
                  className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 shrink-0 whitespace-nowrap"
                >
                  {auditoriaLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />}
                  {auditoriaLoading ? 'Comparando...' : 'Auditoria de XML'}
                </button>
                {analysis && (
                  <div className="relative shrink-0">
                    <button
                      onClick={() => setShowPrintMenu(v => !v)}
                      className="flex items-center gap-1 text-white px-2.5 py-1.5 rounded-lg transition-all shrink-0"
                      style={{background: '#17150F'}}
                      title={window.self !== window.top
                        ? 'Imprimir Relatório / Exportar PDF — se não abrir, use o ícone "Abrir em nova aba" no topo.'
                        : 'Imprimir Relatório / Exportar PDF'}
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <ChevronRight className={cn("w-3 h-3 transition-transform duration-300", showPrintMenu && "rotate-90")} />
                    </button>
                    {showPrintMenu && (
                      <div className="absolute right-0 top-full mt-2 z-20 w-80 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden">
                        <button
                          onClick={() => { setTipoRelatorioPDF('resumido'); setShowPrintMenu(false); setTimeout(() => window.print(), 50); }}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all border-b border-slate-100 dark:border-slate-800"
                        >
                          <div className="text-sm font-bold text-slate-900 dark:text-slate-100">Resumido</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Resumo de integridade e detalhamento de faltantes, do jeito que já sai hoje.</div>
                        </button>
                        <button
                          onClick={() => { setTipoRelatorioPDF('completo'); setShowPrintMenu(false); setTimeout(() => window.print(), 50); }}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                        >
                          <div className="text-sm font-bold text-slate-900 dark:text-slate-100">Completo</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Faltantes + CFOP, Anomalias, Auditoria de Regime, IBS/CBS e TEF, com legenda dos termos técnicos.</div>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Auditoria de XML — resultado do confronto */}
              {auditoriaErro && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-start gap-3 no-print">
                  <XCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                  <div className="flex-1 text-sm text-rose-700 font-medium">{auditoriaErro}</div>
                  <button onClick={() => setAuditoriaErro(null)} className="text-rose-400 hover:text-rose-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {auditoriaResultado && (() => {
                const contagens = auditoriaResultado.reduce((acc, d) => {
                  acc[d.tipo] = (acc[d.tipo] || 0) + 1;
                  return acc;
                }, {} as Record<string, number>);
                const tipos: ('Todas' | TipoDiferencaAuditoria)[] = ['Todas', 'NCM', 'Nome', 'Nome e NCM', 'Sequência', 'Planilha'];
                const listaFiltrada = auditoriaFiltroTipo === 'Todas'
                  ? auditoriaResultado
                  : auditoriaResultado.filter(d => d.tipo === auditoriaFiltroTipo);

                return (
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden no-print">
                    <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <GitCompare className="w-5 h-5 text-amber-600" />
                        <div>
                          <h4 className="font-serif font-semibold text-slate-800">Auditoria de XML — Divergências</h4>
                          <div className="text-xs text-slate-400 font-medium">Comparado com: {auditoriaNomeArquivo}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {auditoriaResultado.length > 0 && (
                          <button
                            onClick={exportarAuditoriaXml}
                            className="flex items-center gap-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Exportar
                          </button>
                        )}
                        <button
                          onClick={() => { setAuditoriaResultado(null); setAuditoriaFiltroTipo('Todas'); }}
                          className="text-slate-400 hover:text-slate-600"
                          title="Fechar auditoria"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {auditoriaResultado.length === 0 ? (
                      <div className="p-8 text-center text-emerald-600 font-bold flex flex-col items-center gap-2">
                        <CheckCircle2 className="w-8 h-8" />
                        Nenhuma divergência encontrada. Nome e NCM batem 100% com a planilha anexada.
                      </div>
                    ) : (
                      <>
                        <div className="p-4 flex flex-wrap gap-2 border-b border-slate-100">
                          {tipos.map(t => {
                            const count = t === 'Todas' ? auditoriaResultado.length : (contagens[t] || 0);
                            if (t !== 'Todas' && count === 0) return null;
                            return (
                              <button
                                key={t}
                                onClick={() => setAuditoriaFiltroTipo(t)}
                                className={cn(
                                  "px-3 py-1.5 rounded-full text-xs font-bold border transition-all",
                                  auditoriaFiltroTipo === t
                                    ? "bg-amber-500 text-white border-amber-500"
                                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                                )}
                              >
                                {t} ({count})
                              </button>
                            );
                          })}
                        </div>
                        <div className="overflow-x-auto overflow-y-auto max-h-[500px]">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-slate-50 text-left text-[10px] font-black uppercase tracking-wider text-slate-400">
                                <th className="px-4 py-3">Tipo</th>
                                <th className="px-4 py-3">Item (Sequência Fiscal)</th>
                                <th className="px-4 py-3">Item (Planilha)</th>
                                <th className="px-4 py-3">NCM (Sequência Fiscal)</th>
                                <th className="px-4 py-3">NCM (Planilha)</th>
                                <th className="px-4 py-3">Notas (Sequência Fiscal)</th>
                                <th className="px-4 py-3">Notas (Planilha)</th>
                                <th className="px-4 py-3 text-right">Ocorr.</th>
                                <th className="px-4 py-3 text-right">Valor</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {listaFiltrada.map((d, i) => (
                                <tr key={i} className="hover:bg-slate-50/50">
                                  <td className="px-4 py-2.5">
                                    <span className={cn(
                                      "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border",
                                      d.tipo === 'NCM' && "bg-blue-50 text-blue-700 border-blue-200",
                                      d.tipo === 'Nome' && "bg-purple-50 text-purple-700 border-purple-200",
                                      d.tipo === 'Nome e NCM' && "bg-rose-50 text-rose-700 border-rose-200",
                                      (d.tipo === 'Sequência' || d.tipo === 'Planilha') && "bg-slate-100 text-slate-600 border-slate-200"
                                    )}>
                                      {d.tipo}
                                    </span>
                                    {d.outrosTipos && (
                                      <div className="mt-1 text-[9px] text-amber-600 font-bold leading-tight max-w-[120px]">
                                        ⚠ nota também em: {d.outrosTipos}
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 font-medium text-slate-800">{d.itemSequencia || '—'}</td>
                                  <td className="px-4 py-2.5 font-medium text-slate-800">{d.itemPlanilha || '—'}</td>
                                  <td className="px-4 py-2.5 font-mono text-slate-500">{d.ncmSequencia || '—'}</td>
                                  <td className="px-4 py-2.5 font-mono text-slate-500">{d.ncmPlanilha || '—'}</td>
                                  <td className="px-4 py-2.5 text-xs text-slate-500">
                                    {d.notasSequencia.length > 0
                                      ? formatarNotasAgrupadas(d.notasSequencia).map((linha, li) => <div key={li}>{linha}</div>)
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-xs text-slate-500">
                                    {d.notasPlanilha.length > 0
                                      ? formatarNotasAgrupadas(d.notasPlanilha).map((linha, li) => <div key={li}>{linha}</div>)
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-slate-500">{d.ocorrencias}</td>
                                  <td className="px-4 py-2.5 text-right font-bold text-slate-800">{formatarMoeda(d.valor)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Series List */}
              <div className="space-y-4">
                {filteredAnalysis.map((serie, idx) => (
                  <div key={idx} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden transition-all hover:shadow-md">
                    <div
                      className="p-6 cursor-pointer flex items-center gap-6"
                      onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                    >
                      <div className={cn(
                        "w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg",
                        serie.faltantes.length > 0 ? "bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400" : "bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400"
                      )}>
                        {serie.faltantes.length > 0 ? "!" : "✓"}
                      </div>

                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-semibold text-slate-800 dark:text-slate-200 text-lg">{serie.razaoSocial}</h3>
                          <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px] font-semibold rounded uppercase tracking-wider border border-amber-200 dark:border-amber-800">
                            {serie.mesReferencia}
                          </span>
                          {mesesFaltantesPorSerie.has(idx) && (
                            <span
                              className="px-2 py-0.5 bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 text-[10px] font-semibold rounded uppercase tracking-wider border border-rose-200 dark:border-rose-800"
                              title="Essa série tem nota em outros meses do período, mas não nesse(s) — pode ser série nova, descontinuada, ou realmente sem nenhum movimento nesse mês."
                            >
                              ⚠ Sem nota em: {mesesFaltantesPorSerie.get(idx)!.join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="text-slate-400 dark:text-slate-500 text-sm font-medium">
                          Mod {serie.modelo} • Série {serie.serie} • CNPJ {serie.cnpj} • IE {serie.ie}
                        </div>
                      </div>

                      <div className="flex gap-8 items-center">
                        <div className="text-center">
                          <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">Recebidos</div>
                          <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{serie.recebidos}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">Faltantes</div>
                          <div className={cn(
                            "text-xl font-bold",
                            serie.faltantes.length > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
                          )}>
                            {serie.faltantes.length}
                          </div>
                        </div>
                        <ChevronRight className={cn(
                          "w-6 h-6 text-slate-300 dark:text-slate-600 transition-transform duration-300",
                          expandedIdx === idx && "rotate-90"
                        )} />
                      </div>
                    </div>

                    {expandedIdx === idx && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-8 space-y-6"
                      >
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                            <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Menor Número</div>
                            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.min}</div>
                          </div>
                          <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                            <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Maior Número</div>
                            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.max}</div>
                          </div>
                          <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                            <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Esperados</div>
                            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.esperados}</div>
                          </div>
                          <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                            <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Situação</div>
                            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.situacao}</div>
                          </div>
                        </div>

                        {serie.faltantesInutilizados.length > 0 && (
                          <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 text-emerald-800 dark:text-emerald-200 text-sm space-y-2">
                            <div className="font-bold flex items-center gap-2">
                              <Check className="w-4 h-4" />
                              Inutilizações Identificadas ({serie.faltantesInutilizados.length})
                            </div>
                            {(() => {
                              const doXml = serie.faltantesInutilizados.filter(n => !serie.faltantesInutilizadosManual.includes(n));
                              return (
                                <>
                                  {doXml.length > 0 && (
                                    <div>Da XML: {formatarFaixas(agruparFaixas(doXml))}</div>
                                  )}
                                  {serie.faltantesInutilizadosOutroMes.length > 0 && (
                                    <div className="flex items-start gap-2 bg-white/60 dark:bg-slate-900/60 border border-amber-300 dark:border-amber-700 rounded-lg p-2 no-print">
                                      <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                                      <span>
                                        <strong>Inutilização recebida em mês diferente do filtro atual ({serie.faltantesInutilizadosOutroMes.length}):</strong> {formatarFaixas(agruparFaixas(serie.faltantesInutilizadosOutroMes))} — vale confirmar se a data faz sentido.
                                      </span>
                                    </div>
                                  )}
                                  {serie.faltantesInutilizadosManual.length > 0 && (
                                    <div className="flex items-start gap-2 bg-white/60 dark:bg-slate-900/60 border border-emerald-300 dark:border-emerald-700 rounded-lg p-2 no-print">
                                      <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                                      <span>
                                        <strong>Confirmadas manualmente, sem XML ({serie.faltantesInutilizadosManual.length}):</strong> {formatarFaixas(agruparFaixas(serie.faltantesInutilizadosManual))}
                                      </span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}

                        {serie.cancelados && serie.cancelados.length > 0 && (
                          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-amber-800 dark:text-amber-200 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1">
                              <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                              Cancelamentos Identificados ({serie.cancelados.length})
                            </div>
                            Números: {formatarFaixas(agruparFaixas(serie.cancelados))}
                          </div>
                        )}

                        {serie.faltantes.length === 0 && serie.todasInutilizacoes.length > 0 && (
                          <div className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 text-slate-600 dark:text-slate-300 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1 text-slate-700 dark:text-slate-200">
                              <FileSearch className="w-4 h-4" />
                              Inutilizações Registradas nessa Série ({serie.todasInutilizacoes.length})
                            </div>
                            Números: {formatarFaixas(agruparFaixas(serie.todasInutilizacoes))}
                          </div>
                        )}

                        {serie.faltantes.length > 0 && (
                          <div className="bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800 rounded-lg p-4 text-rose-800 dark:text-rose-200 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1">
                              <AlertCircle className="w-4 h-4" />
                              Números Ausentes ({serie.faltantes.length})
                            </div>
                            {formatarFaixas(agruparFaixas(serie.faltantes))}
                          </div>
                        )}

                        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-blue-800 dark:text-blue-200 text-sm">
                          <div className="font-bold flex items-center gap-2 mb-1">
                            <Search className="w-4 h-4" />
                            Verificação de Abrangência
                          </div>
                          Foram anexadas todas as notas (Autorizadas, Canceladas, Inutilizadas e em Contingência)?
                        </div>
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>

              {/* Series List — NFS-e (auditoria de sequência isolada, ver nfseAnalysis) */}
              {nfseAnalysis.length > 0 && (
                <div className="space-y-4">
                  {nfseAnalysis.map((serie, idx) => (
                    <div key={`nfse_${serie.cnpj}_${serie.serie}_${idx}`} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden transition-all hover:shadow-md">
                      <div
                        className="p-6 cursor-pointer flex items-center gap-6"
                        onClick={() => setExpandedNfseIdx(expandedNfseIdx === idx ? null : idx)}
                      >
                        <div className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg",
                          serie.faltantes.length > 0 ? "bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400" : "bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400"
                        )}>
                          {serie.faltantes.length > 0 ? "!" : "✓"}
                        </div>

                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <h3 className="font-semibold text-slate-800 dark:text-slate-200 text-lg">{serie.razaoSocial}</h3>
                            <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-[10px] font-semibold rounded uppercase tracking-wider border border-blue-200 dark:border-blue-800">
                              NFS-e
                            </span>
                          </div>
                          <div className="text-slate-400 dark:text-slate-500 text-sm font-medium">
                            Série {serie.serie} • CNPJ {serie.cnpj} (prestador) • nDPS
                          </div>
                        </div>

                        <div className="flex gap-8 items-center">
                          <div className="text-center">
                            <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">Recebidos</div>
                            <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{serie.recebidos}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">Faltantes</div>
                            <div className={cn(
                              "text-xl font-bold",
                              serie.faltantes.length > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
                            )}>
                              {serie.faltantes.length}
                            </div>
                          </div>
                          <ChevronRight className={cn(
                            "w-6 h-6 text-slate-300 dark:text-slate-600 transition-transform duration-300",
                            expandedNfseIdx === idx && "rotate-90"
                          )} />
                        </div>
                      </div>

                      {expandedNfseIdx === idx && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-8 space-y-6"
                        >
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                              <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Menor nDPS</div>
                              <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.min}</div>
                            </div>
                            <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                              <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Maior nDPS</div>
                              <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.max}</div>
                            </div>
                            <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                              <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Esperados</div>
                              <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.esperados}</div>
                            </div>
                            <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                              <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Duplicados</div>
                              <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{serie.duplicados}</div>
                            </div>
                          </div>

                          {serie.cancelados.length > 0 && (
                            <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-amber-800 dark:text-amber-200 text-sm">
                              <div className="font-bold flex items-center gap-2 mb-1">
                                <Ban className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                Cancelamentos Identificados ({serie.cancelados.length})
                              </div>
                              nDPS: {formatarFaixas(agruparFaixas(serie.cancelados))}
                            </div>
                          )}

                          {serie.suspeitasCanceladas.length > 0 && (
                            <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-amber-800 dark:text-amber-200 text-sm">
                              <div className="font-bold flex items-center gap-2 mb-1">
                                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                Suspeita de Cancelamento/Reemissão ({serie.suspeitasCanceladas.length})
                              </div>
                              Mesmo tomador, valor e data, nDPS consecutivo — não é uma confirmação, o sistema do prestador não expõe o evento de cancelamento. nDPS: {formatarFaixas(agruparFaixas(serie.suspeitasCanceladas))}
                            </div>
                          )}

                          {serie.faltantes.length > 0 && (
                            <div className="bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800 rounded-lg p-4 text-rose-800 dark:text-rose-200 text-sm">
                              <div className="font-bold flex items-center gap-2 mb-1">
                                <AlertCircle className="w-4 h-4" />
                                nDPS Ausentes ({serie.faltantes.length})
                              </div>
                              {formatarFaixas(agruparFaixas(serie.faltantes))}
                            </div>
                          )}
                        </motion.div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Consolidated Message */}
              {analysis.some(s => s.faltantes.length > 0) && (
                <div className="bg-white rounded-2xl border-2 border-blue-600 p-8 shadow-xl no-print">
                  <div className="flex justify-between items-center mb-6">
                    <div>
                      <h2 className="font-serif text-2xl font-semibold text-slate-900">Relatório Consolidado</h2>
                      <p className="text-slate-500 mt-1">Edite a mensagem completa abaixo antes de enviar.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col items-end">
                        <button 
                          onClick={() => window.print()}
                          className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-6 py-4 rounded-xl font-bold transition-all"
                        >
                          <Printer className="w-5 h-5" />
                          Imprimir
                        </button>
                        {window.self !== window.top && (
                          <span className="text-[9px] text-slate-500 mt-1 font-bold">
                            Dica: Use "Abrir em nova aba" no topo.
                          </span>
                        )}
                      </div>
                      <button 
                        onClick={() => copyToClipboard(consolidatedMessage, 999)}
                        className={cn(
                          "px-10 py-4 rounded-xl font-bold text-lg transition-all shadow-lg",
                          copiedIdx === 999 ? "bg-slate-900 text-white" : "bg-blue-600 text-white hover:bg-blue-700"
                        )}
                      >
                        {copiedIdx === 999 ? "Copiado!" : "Copiar Mensagem Completa"}
                      </button>
                    </div>
                  </div>
                  <textarea 
                    value={consolidatedMessage}
                    onChange={(e) => setConsolidatedMessage(e.target.value)}
                    className="w-full h-96 bg-slate-50 p-6 rounded-xl text-sm text-slate-700 font-mono border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  />
                </div>
              )}
              {analysis.every(s => s.faltantes.length === 0) && nfseAnalysis.every(s => s.faltantes.length === 0) && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-10 text-center space-y-4">
                  <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
                    <CheckCircle2 className="w-10 h-10" />
                  </div>
                  <h2 className="font-serif text-3xl font-semibold text-emerald-900">Sequência Totalmente Íntegra</h2>
                  <p className="text-emerald-700 font-medium max-w-xl mx-auto text-lg">
                    Parabéns! Todos os documentos fiscais foram identificados e a sequência numérica está completa para todas as séries analisadas.
                  </p>
                </div>
              )}
              </div>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Formal Audit Report - Visible only during printing */}
      {analysis && (() => {
        const empresaPrincipal = analysis[0]?.razaoSocial || 'N/A';
        const cnpjPrincipal = analysis[0]?.cnpj || 'N/A';
        const periodosUnicos = Array.from(new Set(analysis.map(a => a.mesReferencia).filter(Boolean)));
        const periodoLabel = periodosUnicos.length <= 1 ? (periodosUnicos[0] || 'N/A') : periodosUnicos.join(', ');

        return (
        <div className="hidden print:block print:px-3">
          <div className="print-header">
            <div className="flex items-baseline justify-between gap-6">
              <div className="print-title font-serif" style={{color: '#17150F'}}>Relatório de Auditoria de Sequência (Vendas/Saídas)</div>
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full whitespace-nowrap" style={{background: '#f1f5f9', color: '#475569'}}>Cópia de Auditoria</span>
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-1 text-[11px]">
              <span>
                <span className="font-bold uppercase tracking-widest" style={{color: '#94a3b8'}}>Empresa </span>
                <span className="font-bold" style={{color: '#1e293b'}}>{empresaPrincipal}</span>
              </span>
              <span>
                <span className="font-bold uppercase tracking-widest" style={{color: '#94a3b8'}}>CNPJ </span>
                <span className="font-mono font-bold" style={{color: '#1e293b'}}>{cnpjPrincipal}</span>
              </span>
              <span>
                <span className="font-bold uppercase tracking-widest" style={{color: '#94a3b8'}}>Período </span>
                <span className="font-bold" style={{color: '#1e293b'}}>{periodoLabel}</span>
              </span>
            </div>
          </div>

          <div className="print-section">
            <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Resumo da Integridade</h3>
            <table>
              <thead>
                <tr>
                  <th>Empresa / CNPJ</th>
                  <th>Mês</th>
                  <th>Mod/Série</th>
                  <th>Recebidos</th>
                  <th>Faltantes</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {analysis.map((s, idx) => (
                    <tr key={idx}>
                      <td className="font-medium">
                        {s.razaoSocial}<br/>
                        <span className="text-[9px] font-mono opacity-60">{s.cnpj}</span>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex flex-col">
                          <span>{s.mesReferencia}</span>
                          <span className={cn(
                            "text-[8px] font-black uppercase px-1 rounded-sm border w-fit",
                            s.direcao === 'saida' ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"
                          )}>
                            {s.direcao === 'saida' ? 'Saída' : 'Entrada'}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap font-mono">{s.modelo} - Ser {s.serie}</td>
                    <td className="text-center font-bold">{s.recebidos}</td>
                    <td className={cn("text-center font-bold", s.faltantes.length > 0 ? "text-red-600" : "text-green-600")}>
                      {s.faltantes.length}
                    </td>
                    <td className="font-bold">{s.situacao}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="print-section">
            <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Detalhamento de Faltantes</h3>
            {analysis.some(s => s.faltantes.length > 0) ? (
              <div className="space-y-6">
                {analysis.filter(s => s.faltantes.length > 0).map((s, idx) => (
                    <div key={idx} className="border border-slate-200 rounded-lg p-4 bg-slate-50/20">
                      <div className="font-black border-b border-slate-200 pb-2 mb-3 flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[8px] px-1.5 py-0.5 rounded border uppercase",
                            s.direcao === 'saida' ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"
                          )}>
                            {s.direcao === 'saida' ? 'Saída' : 'Entrada'}
                          </span>
                          <span>Série {s.serie} - {s.modelo === '55' ? 'NF-e' : 'NFC-e'}</span>
                        </div>
                        <span className="text-xs uppercase text-slate-400">Total Faltante: {s.faltantes.length}</span>
                      </div>
                      <div className="text-sm border-b border-slate-100 pb-3 mb-3 text-slate-500 italic">
                        {s.direcao === 'saida' ? 'Destinatário: ' : 'Emitente: '}
                        <span className="font-bold uppercase">{s.partnerNome}</span>
                      </div>
                      <div className="text-sm leading-relaxed font-mono">
                        {formatarFaixas(agruparFaixas(s.faltantes))}
                      </div>
                    </div>
                ))}
              </div>
            ) : (
              <div className="p-10 border-2 border-dashed border-slate-200 text-center rounded-xl">
                <div className="font-bold text-slate-400">Nenhuma quebra de sequência identificada.</div>
              </div>
            )}
          </div>

          {tipoRelatorioPDF === 'completo' && (
            <>
              {breakdownPorCfop.length > 0 && (
                <div className="print-section">
                  <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Totais por Natureza da Operação (CFOP)</h3>
                  <table>
                    <thead>
                      <tr><th>CFOP</th><th>Natureza</th><th>Valor Contábil</th></tr>
                    </thead>
                    <tbody>
                      {breakdownPorCfop.map(({ cfop, descricao, valor }) => (
                        <tr key={cfop}>
                          <td className="font-mono font-bold">{cfop}</td>
                          <td>{descricao}</td>
                          <td className="font-bold">{formatarMoeda(valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2} className="font-black uppercase text-xs">Total de Saídas</td>
                        <td className="font-black">{formatarMoeda(faturamentoTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {(notasAnomalias.semProtocolo.length > 0 || notasAnomalias.numeroDuplicado.length > 0 || notasAnomalias.semAutorizacaoNaoContingencia.length > 0 || notasAnomalias.foraDoPrazo.length > 0) && (
                <div className="print-section">
                  <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Anomalias Identificadas</h3>

                  {notasAnomalias.semProtocolo.length > 0 && (
                    <div className="mb-4">
                      <div className="text-sm font-bold text-slate-700 mb-2">
                        Emitidas offline sem autorização SEFAZ ({notasAnomalias.semProtocolo.length}) — {formatarMoeda(notasAnomalias.semProtocolo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                      </div>
                      <table>
                        <thead><tr><th>Série</th><th>Nº</th><th>Data</th><th>Valor</th></tr></thead>
                        <tbody>
                          {notasAnomalias.semProtocolo.slice(0, 25).map((xml, i) => (
                            <tr key={xml.chave || i}>
                              <td>{xml.serie}</td><td>{xml.numero}</td>
                              <td>{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                              <td>{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {notasAnomalias.semProtocolo.length > 25 && (
                        <div className="text-[10px] text-slate-400 mt-1">Mostrando 25 de {notasAnomalias.semProtocolo.length}.</div>
                      )}
                    </div>
                  )}

                  {notasAnomalias.numeroDuplicado.length > 0 && (
                    <div className="mb-4">
                      <div className="text-sm font-bold text-slate-700 mb-2">Números com chave duplicada ({notasAnomalias.numeroDuplicado.length} grupo(s))</div>
                      <table>
                        <thead><tr><th>Série</th><th>Número</th><th>Quantas chaves diferentes</th></tr></thead>
                        <tbody>
                          {notasAnomalias.numeroDuplicado.slice(0, 25).map((grupo, i) => (
                            <tr key={i}><td>{grupo[0].serie}</td><td>{grupo[0].numero}</td><td>{grupo.length}</td></tr>
                          ))}
                        </tbody>
                      </table>
                      {notasAnomalias.numeroDuplicado.length > 25 && (
                        <div className="text-[10px] text-slate-400 mt-1">Mostrando 25 de {notasAnomalias.numeroDuplicado.length}.</div>
                      )}
                    </div>
                  )}

                  {notasAnomalias.semAutorizacaoNaoContingencia.length > 0 && (
                    <div className="mb-4">
                      <div className="text-sm font-bold text-slate-700 mb-2">
                        Sem protocolo SEFAZ e sem contingência — excluídas do total válido ({notasAnomalias.semAutorizacaoNaoContingencia.length}) — {formatarMoeda(notasAnomalias.semAutorizacaoNaoContingencia.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                      </div>
                      <div className="text-xs text-slate-600 mb-2">Por que caiu aqui: o XML não tem o bloco &lt;protNFe&gt; (nProt/cStat) — só o pedido de emissão, sem a resposta de autorização do SEFAZ anexada. Confirme baixando o XML completo do portal do SEFAZ antes de considerar a nota irregular.</div>
                      <table>
                        <thead><tr><th>Série</th><th>Nº</th><th>Data</th><th>Valor</th></tr></thead>
                        <tbody>
                          {notasAnomalias.semAutorizacaoNaoContingencia.slice(0, 25).map((xml, i) => (
                            <tr key={xml.chave || i}>
                              <td>{xml.serie}</td><td>{xml.numero}</td>
                              <td>{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                              <td>{formatarMoeda(parseFloat(xml.valor || '0') || 0)}{xml.temInutilizacao ? ' ⚠ (série/nº inutilizado)' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {notasAnomalias.semAutorizacaoNaoContingencia.length > 25 && (
                        <div className="text-[10px] text-slate-400 mt-1">Mostrando 25 de {notasAnomalias.semAutorizacaoNaoContingencia.length}.</div>
                      )}
                      {notasAnomalias.semAutorizacaoNaoContingencia.some(x => x.temInutilizacao) && (
                        <div className="mt-2 text-xs text-slate-600">⚠ Atenção: uma ou mais notas acima têm o mesmo série/número de uma inutilização registrada. Verifique se a numeração foi reaproveitada indevidamente.</div>
                      )}
                    </div>
                  )}

                  {notasAnomalias.foraDoPrazo.length > 0 && (
                    <div>
                      <div className="text-sm font-bold text-slate-700 mb-2">
                        Emitidas offline e autorizadas com atraso superior a 30 minutos ({notasAnomalias.foraDoPrazo.length}) — {formatarMoeda(notasAnomalias.foraDoPrazo.reduce((s, x) => s + (parseFloat(x.valor || '0') || 0), 0))}
                      </div>
                      <table>
                        <thead><tr><th>Série</th><th>Nº</th><th>Data</th><th>Valor</th></tr></thead>
                        <tbody>
                          {notasAnomalias.foraDoPrazo.slice(0, 25).map((xml, i) => (
                            <tr key={xml.chave || i}>
                              <td>{xml.serie}</td><td>{xml.numero}</td>
                              <td>{xml.data ? new Date(xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                              <td>{formatarMoeda(parseFloat(xml.valor || '0') || 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {notasAnomalias.foraDoPrazo.length > 25 && (
                        <div className="text-[10px] text-slate-400 mt-1">Mostrando 25 de {notasAnomalias.foraDoPrazo.length}.</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {auditoriaRegime.totalNotas > 0 && (
                <div className="print-section">
                  <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Auditoria de Regime Tributário</h3>
                  <div className="text-sm mb-3">
                    Regime predominante no período: <strong>{auditoriaRegime.crtPredominanteLabel}</strong> ({auditoriaRegime.totalNotas} nota(s) analisada(s)).
                    {auditoriaRegime.mudouNoPeriodo && <> O CRT declarado mudou dentro do período analisado — veja a tabela abaixo.</>}
                  </div>
                  <table>
                    <thead><tr><th>CRT</th><th>Regime Declarado</th><th>Qtd. Notas</th><th>Primeira</th><th>Última</th></tr></thead>
                    <tbody>
                      {auditoriaRegime.crtCounts.map(c => (
                        <tr key={c.crt}>
                          <td className="font-mono">{c.crt}</td><td>{c.label}</td>
                          <td className="font-bold">{c.qtd}</td><td>{c.primeira}</td><td>{c.ultima}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-3">
                    {auditoriaRegime.consistente ? (
                      <div className="text-sm font-bold text-green-700">✓ Nenhuma inconsistência entre o CRT declarado e o código de ICMS (CSOSN/CST) usado nos itens.</div>
                    ) : (
                      <>
                        <div className="text-sm font-bold text-red-700 mb-2">⚠ {auditoriaRegime.inconsistencias.length} nota(s) com inconsistência entre o CRT declarado e o CSOSN/CST usado nos itens:</div>
                        <table>
                          <thead><tr><th>Série</th><th>Nº</th><th>Data</th><th>Motivo</th></tr></thead>
                          <tbody>
                            {auditoriaRegime.inconsistencias.slice(0, 20).map((inc, i) => (
                              <tr key={i}>
                                <td>{inc.xml.serie}</td><td>{inc.xml.numero}</td>
                                <td>{inc.xml.data ? new Date(inc.xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td>{inc.motivo}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {auditoriaRegime.inconsistencias.length > 20 && (
                          <div className="text-[10px] text-slate-400 mt-1">Mostrando 20 de {auditoriaRegime.inconsistencias.length} — o mesmo padrão se repete nas demais.</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {auditoriaIbsCbs.totalNotas > 0 && (
                <div className="print-section">
                  <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Auditoria de IBS/CBS (Reforma Tributária)</h3>
                  <div className="text-sm mb-3">
                    <strong>{auditoriaIbsCbs.notasComGrupo} de {auditoriaIbsCbs.totalNotas} nota(s) ({formatarPct(auditoriaIbsCbs.pctComGrupo)}%)</strong> já trazem o grupo IBS/CBS preenchido.
                    {auditoriaIbsCbs.pctComGrupo === 0 && ' Nenhuma nota desse período traz o grupo IBSCBS preenchido — 2026 é o período de teste da Reforma Tributária; vale confirmar com o suporte do sistema do cliente antes de virar obrigatório de verdade.'}
                    {auditoriaIbsCbs.pctComGrupo === 100 && ' Sistema do cliente parece adaptado à Reforma Tributária.'}
                    {auditoriaIbsCbs.pctComGrupo > 0 && auditoriaIbsCbs.pctComGrupo < 100 && ' Pode ser uma atualização de sistema no meio do período ou inconsistência a esclarecer com o suporte do sistema.'}
                  </div>
                  {auditoriaIbsCbs.amostraSemGrupo.length > 0 && (
                    <div>
                      <div className="text-sm font-bold text-slate-700 mb-2">Amostra sem o grupo IBS/CBS</div>
                      <table>
                        <thead><tr><th>Série</th><th>Nº</th><th>Data</th></tr></thead>
                        <tbody>
                          {auditoriaIbsCbs.amostraSemGrupo.slice(0, 15).map((n, i) => (
                            <tr key={n.chave || i}>
                              <td>{n.serie}</td><td>{n.numero}</td>
                              <td>{n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {auditoriaIbsCbs.amostraSemGrupo.length > 15 && (
                        <div className="text-[10px] text-slate-400 mt-1">Mostrando 15 de {auditoriaIbsCbs.amostraSemGrupo.length}.</div>
                      )}
                    </div>
                  )}

                  {auditoriaClassTrib.totalItens > 0 && (
                    <div className="mt-4">
                      <div className="text-sm font-bold text-slate-700 mb-1">Validação cClassTrib × Tabela Oficial ({CCLASSTRIB_VERSAO})</div>
                      <div className="text-xs text-slate-500 mb-2">
                        {auditoriaClassTrib.totalItens} item(ns) em {auditoriaClassTrib.totalNotas} nota(s) verificados — formato, prefixo CST, existência, vigência, modelo e redução.
                        {auditoriaClassTrib.problemas.length === 0
                          ? ' Nenhuma inconsistência estrutural encontrada.'
                          : ` ${auditoriaClassTrib.problemas.length} inconsistência(s) encontrada(s):`}
                      </div>
                      {auditoriaClassTrib.problemas.length > 0 && (
                        <ul className="text-xs text-slate-600 mb-2 list-disc pl-4">
                          {auditoriaClassTrib.problemas.map((p, i) => (
                            <li key={i}>{p.nivel === 'erro' ? '🔴' : '🟡'} <strong>{p.code}</strong> — {p.motivo} ({p.itens} item(ns) em {p.notas.size} nota(s), ex: nota {p.exemplo})</li>
                          ))}
                        </ul>
                      )}
                      {auditoriaClassTrib.cclassTribUnicoSuspeito && (
                        <div className="text-xs text-amber-700 mb-2">
                          🟡 Só <strong>{auditoriaClassTrib.codigosUsados[0]?.code}</strong> foi usado no período inteiro, apesar de {auditoriaClassTrib.ncmsDistintos} NCMs distintos — vale confirmar se o sistema do cliente classifica produto a produto ou aplica um valor fixo/padrão pra tudo.
                        </div>
                      )}
                      <table>
                        <thead><tr><th>cClassTrib</th><th>Descrição oficial</th><th>Red. IBS</th><th>Red. CBS</th><th>Itens</th><th>Notas</th><th>Valor (vProd)</th><th>IBS+CBS destacado</th></tr></thead>
                        <tbody>
                          {auditoriaClassTrib.codigosUsados.map(c => (
                            <tr key={c.code}>
                              <td>{c.code}</td>
                              <td>{c.nome}</td>
                              <td>{c.naTabela ? `${c.redIBS}%` : '—'}</td>
                              <td>{c.naTabela ? `${c.redCBS}%` : '—'}</td>
                              <td>{c.itens}</td>
                              <td>{c.notas.size}</td>
                              <td>{formatarMoeda(c.valor)}</td>
                              <td>{formatarMoeda(c.vIBS + c.vCBS)}</td>
                            </tr>
                          ))}
                          <tr>
                            <td colSpan={6}><strong>Total do período</strong></td>
                            <td><strong>{formatarMoeda(auditoriaClassTrib.codigosUsados.reduce((s, c) => s + c.valor, 0))}</strong></td>
                            <td><strong>{formatarMoeda(auditoriaClassTrib.totalIBS + auditoriaClassTrib.totalCBS)}</strong></td>
                          </tr>
                        </tbody>
                      </table>
                      <div className="text-[10px] text-slate-400 mt-1">
                        "IBS+CBS destacado" = soma do vIBS + vCBS que o sistema do cliente calculou nos itens (2026: período de teste, valores compensáveis). A lista completa de produtos por código sai no Laudo IBS/CBS específico (botão "Exportar Laudo" no card da auditoria).
                      </div>
                    </div>
                  )}
                </div>
              )}

              {(auditoriaPagamento.totalCartao > 0 || auditoriaPagamento.totalCartaoNaoAplicavel > 0 || auditoriaPagamento.problemas.length > 0 || auditoriaPagamento.breakdownPorTipoPagamento.length > 0) && (() => {
                // Sem Math.round: arredondar pra "100%" esconderia POS manual/Falso TEF residual.
                const pctIntegradoPrint = auditoriaPagamento.totalCartao > 0 ? (auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100 : 0;
                const pctNaoIntegradoPrint = auditoriaPagamento.totalCartao > 0 ? (auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100 : 0;
                const pctFalsoTefPrint = auditoriaPagamento.totalCartao > 0 ? (auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100 : 0;
                const riscoObrigatoriedadePrint = !regimeTributario.isSimples && !regimeTributario.isMei && regimeTributario.label !== null && auditoriaPagamento.totalNaoIntegrado > 0;
                return (
                  <div className="print-section">
                    <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Auditoria de Pagamento (TEF)</h3>
                    <div className="text-sm mb-3">
                      {auditoriaPagamento.totalCartao} venda(s) em cartão sujeita(s) a TEF: <strong>{auditoriaPagamento.totalIntegrado} integrada(s) de verdade ({formatarPct(pctIntegradoPrint)}%)</strong>, {auditoriaPagamento.totalNaoIntegrado} via POS manual ({formatarPct(pctNaoIntegradoPrint)}%){auditoriaPagamento.totalFalsoTef > 0 && <>, {auditoriaPagamento.totalFalsoTef} em Falso TEF ({formatarPct(pctFalsoTefPrint)}%)</>}{auditoriaPagamento.totalCartaoNaoAplicavel > 0 && <>, {auditoriaPagamento.totalCartaoNaoAplicavel} fora do escopo de TEF</>}.
                      {auditoriaPagamento.totalFalsoTef > 0 && <> <strong className="text-red-700">Alerta grave: {auditoriaPagamento.totalFalsoTef} venda(s) dizem ter TEF integrado (tpIntegra=1) mas vieram sem código de autorização — uma integração de verdade sempre traz esse código. É uma declaração que os próprios dados da nota contradizem, mais grave que POS manual comum.</strong></>}
                      {riscoObrigatoriedadePrint && <> <strong className="text-red-700">Alerta: empresa é {regimeTributario.label} — tem obrigatoriedade de TEF, e esse padrão costuma gerar autuação por falta de integração.</strong></>}
                      {!riscoObrigatoriedadePrint && (regimeTributario.isSimples || regimeTributario.isMei) && auditoriaPagamento.totalNaoIntegrado > 0 && <> Empresa é {regimeTributario.label}, que não tem obrigatoriedade de TEF.</>}
                    </div>
                    {auditoriaPagamento.breakdownPorTipoPagamento.length > 0 && (
                      <table>
                        <thead><tr><th>Forma de Pagamento</th><th>Valor</th><th>Qtd.</th></tr></thead>
                        <tbody>
                          {auditoriaPagamento.breakdownPorTipoPagamento.map(b => (
                            <tr key={b.tPag}><td>{b.tPagNome}</td><td className="font-bold">{formatarMoeda(b.valor)}</td><td>{b.qtd}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {auditoriaPagamento.problemas.length > 0 && (
                      <div className="mt-3">
                        <div className="text-sm font-bold text-red-700 mb-2">⚠ {auditoriaPagamento.problemas.length} problema(s) técnico(s) identificado(s)</div>
                        <table>
                          <thead><tr><th>Série</th><th>Nº</th><th>Data</th><th>Valor</th><th>Motivo</th></tr></thead>
                          <tbody>
                            {auditoriaPagamento.problemas.slice(0, 20).map((p, i) => (
                              <tr key={i}>
                                <td>{p.xml.serie}</td><td>{p.xml.numero}</td>
                                <td>{p.xml.data ? new Date(p.xml.data).toLocaleDateString('pt-BR') : '—'}</td>
                                <td>{formatarMoeda(parseFloat(p.xml.valor || '0') || 0)}</td>
                                <td>{p.motivo}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {auditoriaPagamento.problemas.length > 20 && (
                          <div className="text-[10px] text-slate-400 mt-1">Mostrando 20 de {auditoriaPagamento.problemas.length}.</div>
                        )}
                      </div>
                    )}
                    {responsavelTecnico.email && (
                      <div className="mt-3 text-[10px] text-slate-400">
                        Responsável técnico do sistema (XML): {responsavelTecnico.contato && <>{responsavelTecnico.contato} · </>}{responsavelTecnico.email}{responsavelTecnico.foneFormatado && <> · {responsavelTecnico.foneFormatado}</>}{responsavelTecnico.cnpjFormatado && <> · CNPJ {responsavelTecnico.cnpjFormatado}</>}
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="print-section">
                <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Legenda de Termos Técnicos</h3>
                <table>
                  <tbody>
                    <tr><td className="font-bold" style={{width: '160px'}}>TEF</td><td>Transferência Eletrônica de Fundos — integração automática entre a maquininha de cartão e o sistema/PDV, sem digitação manual.</td></tr>
                    <tr><td className="font-bold">tpIntegra</td><td>Campo do XML que indica se o pagamento em cartão foi integrado (1) ou digitado manualmente no PDV, ou seja, "POS manual" (2).</td></tr>
                    <tr><td className="font-bold">cAut</td><td>Código de autorização que a operadora do cartão devolve confirmando a transação. Uma integração TEF de verdade sempre traz esse código.</td></tr>
                    <tr><td className="font-bold">Falso TEF</td><td>Pagamento com tpIntegra=1 (afirma ser integrado) mas sem código de autorização (cAut) — contradição que os próprios dados da nota revelam, indicando PDV mal configurado ou declaração de integração que não ocorreu de fato.</td></tr>
                    <tr><td className="font-bold">CRT</td><td>Código de Regime Tributário declarado pelo emitente: 1 e 2 = Simples Nacional; 3 = Regime Normal (Lucro Presumido ou Real).</td></tr>
                    <tr><td className="font-bold">CSOSN</td><td>Código de Situação da Operação — Simples Nacional. Código de ICMS usado por item quando o emitente é optante pelo Simples (CRT 1 ou 2).</td></tr>
                    <tr><td className="font-bold">CST</td><td>Código de Situação Tributária do ICMS. Usado por item quando o emitente é do Regime Normal (CRT 3).</td></tr>
                    <tr><td className="font-bold">IBS / CBS</td><td>Novos tributos da Reforma Tributária do Consumo (EC 132/2023 + LC 214/2025): IBS (estadual/municipal) substitui ICMS/ISS; CBS (federal) substitui PIS/COFINS. 2026 é o período de teste, com alíquotas simbólicas de 0,1% (IBS) + 0,9% (CBS), compensáveis.</td></tr>
                    <tr><td className="font-bold">Grupo IBSCBS</td><td>Bloco de campos do XML, informado por item, onde o sistema do emitente registra os valores de IBS e CBS calculados.</td></tr>
                    <tr><td className="font-bold">CFOP</td><td>Código Fiscal de Operações e Prestações — identifica a natureza da operação (venda, devolução, remessa, etc).</td></tr>
                    <tr><td className="font-bold">indPres</td><td>Indicador de presença do comprador — usado para saber se a venda foi presencial (sujeita a TEF) ou não (e-commerce, teleatendimento).</td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        );
      })()}

      <footer className="p-8 text-center no-print" style={{background: '#17150F'}}>
        <img src="/simbolo.png" alt="Contador de Padarias" className="h-8 object-contain mx-auto opacity-70" />
      </footer>
    </div>
  );
}
