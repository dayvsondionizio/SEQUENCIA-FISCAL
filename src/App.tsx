/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useMemo, useEffect } from 'react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { CCLASSTRIB_TABELA, CCLASSTRIB_VERSAO } from './cclasstribTabela';
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
  Briefcase
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
  if (resto >= 410 && resto <= 413) return false;
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

  const [copiedResumoTEF, setCopiedResumoTEF] = useState(false);

  // Monta um resumo em texto do card de Auditoria de Pagamento (TEF) pra
  // copiar e enviar direto pro cliente — empresa, período, formas de
  // pagamento e os percentuais de TEF/POS que hoje só existem visualmente.
  const copiarResumoTEF = () => {
    const empresa = analysis?.[0]?.razaoSocial || '';
    const cnpj = analysis?.[0]?.cnpj || '';
    const ie = analysis?.[0]?.ie || '';
    const periodo = filterMes !== 'Todos' ? filterMes : mesesDisponiveis.join(', ');
    const pctIntegrado = auditoriaPagamento.totalCartao > 0
      ? Math.round((auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100)
      : 0;
    const pctNaoIntegrado = auditoriaPagamento.totalCartao > 0
      ? Math.round((auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100)
      : 0;
    const pctFalsoTef = auditoriaPagamento.totalCartao > 0
      ? Math.round((auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100)
      : 0;

    let texto = `RESUMO — AUDITORIA DE PAGAMENTO (TEF)\n`;
    texto += `Empresa: ${empresa}\n`;
    texto += `CNPJ: ${cnpj}\n`;
    texto += `IE: ${ie}\n`;
    if (regimeTributario.label) texto += `Regime: ${regimeTributario.label}\n`;
    texto += `Período: ${periodo}\n\n`;

    texto += `Vendas em cartão sujeitas a TEF: ${auditoriaPagamento.totalCartao}\n`;
    texto += `  • Integradas (TEF de verdade, com autorização): ${auditoriaPagamento.totalIntegrado} (${pctIntegrado}%)\n`;
    texto += `  • POS manual (sem TEF): ${auditoriaPagamento.totalNaoIntegrado} (${pctNaoIntegrado}%)\n`;
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
      texto += `  • ⚠ Falso TEF (declara integração mas sem autorização): ${auditoriaPagamento.totalFalsoTef} (${pctFalsoTef}%)\n`;
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
  const [showNfse, setShowNfse] = useState(false);
  const [nfseBusca, setNfseBusca] = useState('');
  const [auditoriaRegimeBusca, setAuditoriaRegimeBusca] = useState('');
  const [auditoriaPagamentoBusca, setAuditoriaPagamentoBusca] = useState('');
  const [showForaDoEscopoDetalhe, setShowForaDoEscopoDetalhe] = useState(false);
  const [showForaDoPrazo, setShowForaDoPrazo] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [tipoRelatorioPDF, setTipoRelatorioPDF] = useState<'resumido' | 'completo'>('resumido');
  const [exportProgress, setExportProgress] = useState<{ atual: number; total: number; etapa: string; titulo?: string } | null>(null);
  const [showExportXmlMenu, setShowExportXmlMenu] = useState(false);
  const [exportPartes, setExportPartes] = useState(1);
  const [notaSearchQuery, setNotaSearchQuery] = useState('');
  const [notaSearchCampo, setNotaSearchCampo] = useState<'Numero' | 'Chave' | 'Cliente' | 'Item' | 'Data' | 'Valor'>('Numero');
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

  const parsedXmlCache = useMemo(() => {
    const cache = new Map<string, Document>();
    xmlList.forEach(xml => {
      // Eventos (Manifestação do Destinatário — Ciência/Confirmação/Desconhecimento
      // da Operação, e também o próprio cancelamento) referenciam o chNFe da NOTA
      // ORIGINAL, não uma chave própria — se entrassem aqui, sobrescreveriam no
      // cache o documento certo da nota (que tem <emit>/<CRT>/etc.) pelo do
      // evento (que não tem nada disso), corrompendo toda auditoria que depende
      // desse cache pra essa chave. Só nota fiscal de fato deve ser cacheada aqui.
      if (xml.tipo !== 'nfe' || !xml.rawXml || !xml.chave) return;
      cache.set(xml.chave, parser.parseFromString(xml.rawXml, 'text/xml'));
    });
    return cache;
  }, [xmlList]);

  // Notas sem chave são raríssimas (só aconteceria em XML malformado) — nesse
  // caso raro faz o parse na hora em vez de quebrar, sem custo perceptível.
  const getParsedXml = (xml: XmlData): Document | null => {
    if (xml.chave && parsedXmlCache.has(xml.chave)) return parsedXmlCache.get(xml.chave)!;
    if (!xml.rawXml) return null;
    return parser.parseFromString(xml.rawXml, 'text/xml');
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
        const doc = getParsedXml(nota);
        const valor = doc?.getElementsByTagName('emit')[0]?.getElementsByTagName('CRT')[0]?.textContent?.trim();
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
      const doc = getParsedXml(xml)!;
      const crt = doc.getElementsByTagName('emit')[0]?.getElementsByTagName('CRT')[0]?.textContent?.trim() || '';
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
      const dets = Array.from(doc.getElementsByTagName('det'));
      let temCsosn = false, temCst = false;
      dets.forEach(det => {
        const icmsGroup = det.getElementsByTagName('imposto')[0]?.getElementsByTagName('ICMS')[0];
        const icmsNode = icmsGroup ? Array.from(icmsGroup.childNodes).find(c => c.nodeType === 1) as Element | undefined : undefined;
        if (icmsNode?.getElementsByTagName('CSOSN')[0]) temCsosn = true;
        if (icmsNode?.getElementsByTagName('CST')[0]) temCst = true;
      });
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
    // se 3 de 491 notas não trouxerem o campo, isso já não é "100%".
    const pctPredominante = saidas.length > 0 ? Math.round(((crtCounts[0]?.qtd || 0) / saidas.length) * 100) : 0;
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
      const doc = getParsedXml(xml)!;
      const temGrupo = Array.from(doc.getElementsByTagName('det')).some(det =>
        !!det.getElementsByTagName('imposto')[0]?.getElementsByTagName('IBSCBS')[0]
      );
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
    const vazio = { totalItens: 0, totalNotas: 0, itensOk: 0, problemas: [] as Problema[], codigosUsados: [] as CodigoUsado[], totalIBS: 0, totalCBS: 0 };
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
    let totalItens = 0;
    let itensComProblema = 0;

    saidas.forEach(xml => {
      const doc = getParsedXml(xml);
      if (!doc) return;
      const dataEmissao = (xml.data || '').slice(0, 10); // YYYY-MM-DD, comparável como string
      const idNota = xml.chave || `${xml.serie}/${xml.numero}`;
      Array.from(doc.getElementsByTagName('det')).forEach(det => {
        const ibscbs = det.getElementsByTagName('imposto')[0]?.getElementsByTagName('IBSCBS')[0];
        if (!ibscbs) return; // ausência do grupo já é coberta pela auditoria IBS/CBS acima
        totalItens++;
        notasComItemVerificado.add(idNota);
        // Valor do item pra dar ao analista a noção de quanto da venda cai em
        // cada classificação (vProd bruto do item, sem rateio de desconto da nota).
        const vProd = parseFloat(det.getElementsByTagName('prod')[0]?.getElementsByTagName('vProd')[0]?.textContent || '0') || 0;
        // IBS/CBS já calculados pelo sistema do cliente e destacados no próprio
        // item (vIBS soma UF+Município; vCBS dentro de gCBS) — nenhum cálculo
        // nosso, só leitura do que o XML declara. Monofásico (gIBSCBSMono) tem
        // outra estrutura e fica de fora dessa soma.
        const gIbsCbsDoItem = ibscbs.getElementsByTagName('gIBSCBS')[0];
        const lerValor = (tag: string, escopo: Element | undefined) => {
          const el = escopo ? Array.from(escopo.children).find(e => e.tagName === tag) : undefined;
          return parseFloat(el?.textContent || '0') || 0;
        };
        const vIBSItem = lerValor('vIBS', gIbsCbsDoItem);
        const vCBSItem = lerValor('vCBS', gIbsCbsDoItem?.getElementsByTagName('gCBS')[0]);
        // Nome e NCM do produto COMO O CLIENTE CADASTROU — vão pro laudo pra o
        // analista enxergar qual produto caiu em qual classificação; o app não
        // julga se a classificação é adequada, só lista.
        const prodEl = det.getElementsByTagName('prod')[0];
        const xProdItem = prodEl?.getElementsByTagName('xProd')[0]?.textContent?.trim() || '(sem descrição)';
        const ncmItem = prodEl?.getElementsByTagName('NCM')[0]?.textContent?.trim() || '';
        // CST e cClassTrib são filhos DIRETOS de <IBSCBS> — getElementsByTagName
        // desce em todos os níveis e pegaria CSTReg/cClassTribReg de gTribRegular.
        const filhoDireto = (tag: string) =>
          Array.from(ibscbs.children).find(el => el.tagName === tag)?.textContent?.trim() ?? '';
        const cst = filhoDireto('CST');
        const code = filhoDireto('cClassTrib');
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
            const gIbsCbs = ibscbs.getElementsByTagName('gIBSCBS')[0];
            if (gIbsCbs) {
              const pRed = (grupo: string): number | null => {
                const g = gIbsCbs.getElementsByTagName(grupo)[0];
                const v = g?.getElementsByTagName('gRed')[0]?.getElementsByTagName('pRedAliq')[0]?.textContent;
                return v != null ? parseFloat(v) : null;
              };
              const conferir = (rotulo: string, xmlRed: number | null, tabRed: number) => {
                if (tabRed > 0) {
                  if (xmlRed === null) alerta(code, `tabela prevê redução de ${tabRed}% no ${rotulo}, mas o XML não traz o grupo de redução (gRed)`);
                  else if (Math.abs(xmlRed - tabRed) > 0.001) erro(code, `redução de ${rotulo} divergente: XML informa ${xmlRed}%, tabela oficial prevê ${tabRed}%`);
                } else if (xmlRed !== null && xmlRed > 0) {
                  erro(code, `XML informa redução de ${xmlRed}% no ${rotulo}, mas a tabela oficial não prevê redução pra esse código`);
                }
              };
              conferir('IBS (UF)', pRed('gIBSUF'), entry.redIBS);
              conferir('IBS (Município)', pRed('gIBSMun'), entry.redIBS);
              conferir('CBS', pRed('gCBS'), entry.redCBS);
            }
          }
        }

        if (temProblema) itensComProblema++;
      });
    });

    const lista = Array.from(problemas.values())
      .sort((a, b) => (a.nivel === b.nivel ? b.itens - a.itens : a.nivel === 'erro' ? -1 : 1));
    const codigos = Array.from(usados.values()).sort((a, b) => b.itens - a.itens);
    return {
      totalItens,
      totalNotas: notasComItemVerificado.size,
      itensOk: totalItens - itensComProblema,
      problemas: lista,
      codigosUsados: codigos,
      totalIBS: codigos.reduce((s, c) => s + c.vIBS, 0),
      totalCBS: codigos.reduce((s, c) => s + c.vCBS, 0),
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
        const doc = getParsedXml(nota);
        const infRespTec = doc?.getElementsByTagName('infRespTec')[0];
        const cnpj = infRespTec?.getElementsByTagName('CNPJ')[0]?.textContent?.trim() || '';
        const email = infRespTec?.getElementsByTagName('email')[0]?.textContent?.trim() || '';
        if (cnpj || email) {
          return {
            cnpj,
            contato: infRespTec?.getElementsByTagName('xContato')[0]?.textContent?.trim() || '',
            email,
            fone: infRespTec?.getElementsByTagName('fone')[0]?.textContent?.trim() || '',
          };
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
      const doc = getParsedXml(xml)!;
      if (doc.getElementsByTagName('detPag').length > 1) notasComPagamentoDividido++;
      // Troco (vTroco) é o valor devolvido ao cliente no pagamento em dinheiro —
      // entra no vPag do detPag de Dinheiro mas NÃO faz parte do valor da venda
      // (vNF), senão a soma do breakdown por forma de pagamento ultrapassa o
      // Total de Saídas Auditadas sempre que há troco.
      let vTrocoRestante = parseFloat(doc.getElementsByTagName('vTroco')[0]?.textContent?.trim() || '0') || 0;
      const indPres = doc.getElementsByTagName('indPres')[0]?.textContent?.trim() || '';
      const isPresencial = indPres === '' || indPres === '1' || indPres === '5';
      const ufEmit = doc.getElementsByTagName('enderEmit')[0]?.getElementsByTagName('UF')[0]?.textContent?.trim() || '';
      const ufDest = doc.getElementsByTagName('enderDest')[0]?.getElementsByTagName('UF')[0]?.textContent?.trim() || '';
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
      const finNFe = doc.getElementsByTagName('finNFe')[0]?.textContent?.trim() || '';
      const vNF = parseFloat(doc.getElementsByTagName('vNF')[0]?.textContent?.trim() || '0') || 0;
      const cfopMap: Record<string, number> = xml.cfopValores || {};
      const cfopPredominante = Object.entries(cfopMap).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const isSaidaVenda = !cfopPredominante || isCfopVenda(cfopPredominante);

      const detPags = Array.from(doc.getElementsByTagName('detPag'));
      detPags.forEach(detPag => {
        const tPag = detPag.getElementsByTagName('tPag')[0]?.textContent?.trim() || '';
        const indPag = detPag.getElementsByTagName('indPag')[0]?.textContent?.trim() || '0';
        const isAVista = indPag !== '1';
        const isCartao = tPag === '03' || tPag === '04';
        const card = detPag.getElementsByTagName('card')[0];
        const tpIntegra = card?.getElementsByTagName('tpIntegra')[0]?.textContent?.trim() || '';
        const cardCnpj = card?.getElementsByTagName('CNPJ')[0]?.textContent?.trim() || '';
        const cardTBand = card?.getElementsByTagName('tBand')[0]?.textContent?.trim() || '';
        const cardCAut = card?.getElementsByTagName('cAut')[0]?.textContent?.trim() || '';
        // xPag é o campo de descrição livre que o próprio layout da NF-e prevê
        // pra quando o código de tPag não é um dos catalogados aqui — mostra
        // isso em vez de só o número cru quando não reconhecemos o código.
        const xPag = detPag.getElementsByTagName('xPag')[0]?.textContent?.trim() || '';
        const tPagNome = tPagLabel[tPag] || (xPag ? `${xPag} (código ${tPag})` : `Código ${tPag} (não catalogado)`);
        const vPagBruto = parseFloat(detPag.getElementsByTagName('vPag')[0]?.textContent?.trim() || '0') || 0;
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
        const doc = getParsedXml(nota);
        if (!doc) return false;
        return Array.from(doc.getElementsByTagName('xProd')).some(el => (el.textContent || '').toLowerCase().includes(query));
      };

      // Campo específico selecionado: busca só ali, pra não trazer resultado de
      // outro campo que por acaso tem o mesmo número/trecho (ex: valor == número da nota).
      if (notaSearchCampo === 'Numero') return (nota.numero || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Chave') return (nota.chave || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Cliente') return [nota.destNome, nota.destCnpj].some(c => c && c.toLowerCase().includes(query));
      if (notaSearchCampo === 'Data') return (nota.data || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Valor') return (nota.valor || '').toLowerCase().includes(query);
      if (notaSearchCampo === 'Item') return buscaItem();
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
      const name = xml.fileName || `${xml.chave || xml.numero}.xml`;
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      allFiles.push({ name: safeName, content: xml.rawXml });
    });

    filteredInuts.forEach(inut => {
      if (!inut.rawXml) return;
      const name = inut.fileName || `inutilizacao_${inut.serie}_${inut.nNFIni}_${inut.nNFFin}.xml`;
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
  const [extractionErrors, setExtractionErrors] = useState<string[]>([]);

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
    const extractionErrorsLocal: string[] = [];
    const registrarExtractionError = (msg: string) => {
      extractionErrorsLocal.push(msg);
      setExtractionErrors(prev => [...prev, msg]);
    };

        const checkMagicBytes = (buffer: ArrayBuffer | Uint8Array) => {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
      if (bytes.length >= 6 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1A && bytes[5] === 0x07) return 'rar';
      return 'unknown';
    };


    
    
    
    
    
    const processArchiveRecursively = async (archiveData: ArrayBuffer | Uint8Array, results: any, containerName: string, archivePath: string = '') => {
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
          for (const name of Object.keys(zip.files)) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            const uniqueName = `${currentPath}::${name}`;
            const baseName = name.split('/').pop() || name;
            
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
                registrarExtractionError(`${currentPath}/${innerArchiveName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
              }
            }
          }
          return;
        } catch (e) {
          console.error('Erro ZIP:', e);
          registrarExtractionError(`${currentPath} — falha ao ler ZIP: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }

      if (type === 'rar' || type === 'unknown') {
        try {
          if (typeof (window as any).Archive === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/libarchive.js/dist/libarchive.js';
            document.head.appendChild(script);
            await new Promise(r => script.onload = r);
            (window as any).Archive.init({ workerUrl: 'https://unpkg.com/libarchive.js/dist/worker-bundle.js' });
          }
          const uint8 = archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);
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
              await processArchiveRecursively(new Uint8Array(await fileData.arrayBuffer()), results, baseName, currentPath);
              if (results.localTotalCount === antesCount) {
                registrarExtractionError(`${currentPath}/${baseName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
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
          const uint8 = archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);
          const cleanBuffer = new ArrayBuffer(uint8.length + 1024*1024);
          new Uint8Array(cleanBuffer).set(uint8);
          let currentWasm = wasmBinary || await loadWasm();
          if (currentWasm) {
            // Pre-scan: list entries without decompressing, so the user sees the
            // real nesting/volume before we commit to extracting it (and so very
            // large nested archives get a heads-up instead of a silent freeze).
            const listExtractor = await createExtractorFromData({ data: new Uint8Array(cleanBuffer), wasmBinary: currentWasm });
            const headers = [...listExtractor.getFileList().fileHeaders].filter(h => !h.flags.directory);
            const nestedArchives = headers.filter(h => /\.(zip|rar)$/i.test(h.name));
            const totalUnpSize = headers.reduce((s, h) => s + h.unpSize, 0);
            if (nestedArchives.length > 0 || totalUnpSize > 20 * 1024 * 1024) {
              setExtractionStatus(`Extraindo ${containerName} (${headers.length} arquivo(s), ${(totalUnpSize / 1024 / 1024).toFixed(0)}MB, ${nestedArchives.length} aninhado(s))...`);
            }

            const extractor = await createExtractorFromData({ data: new Uint8Array(cleanBuffer), wasmBinary: currentWasm });
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
                const antesCount = results.localTotalCount;
                await processArchiveRecursively(file.extraction, results, baseName, currentPath);
                if (results.localTotalCount === antesCount) {
                  registrarExtractionError(`${currentPath}/${baseName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
                }
              } else if (isProvavelmenteNaoFiscal(baseName, file.fileHeader.unpSize)) {
                results.localNonXmlCount++;
              } else {
                const xmlText = new TextDecoder().decode(file.extraction);
                if (xmlText.trimStart().startsWith('|0000|')) {
                  const sped = parseSped(xmlText, baseName);
                  if (sped) results.localSpeds.push(sped);
                  continue;
                }
                if (xmlText.trim().startsWith('<') || name.toLowerCase().endsWith('.xml')) {
                  const data = parseXML(xmlText, name);
                  if (data.tipo !== 'outro') {
                    const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                    ensureSourceInMap(displaySource, true);
                    
                    results.localTotalCount++; data.sourceName = displaySource;
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
          }
        } catch (rarErr) {
          console.error('Erro RAR final:', rarErr);
          const msg = rarErr instanceof Error ? rarErr.message : String(rarErr);
          registrarExtractionError(`${currentPath} — parou no meio da extração (${msg}). Pode haver notas faltando desse arquivo — geralmente por RAR muito grande/aninhado consumindo toda a memória disponível.`);
        }
        setExtractionStatus(null);
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
                  registrarExtractionError(`${currentPath} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
                }
              }
              if (res.localTotalCount === antesCount) {
                registrarExtractionError(`${file.name} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
              }
            } catch (err) {
              console.error('Erro no worker de ZIP:', err);
              registrarExtractionError(`${file.name} — falha ao processar ZIP: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else if (nameLower.endsWith('.rar')) {
            const zipData = await file.arrayBuffer();
            const antesCount = res.localTotalCount;
            await processArchiveRecursively(zipData, res, file.name);
            if (res.localTotalCount === antesCount) {
              registrarExtractionError(`${file.name} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
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
          return res;
        }));

        results.forEach(res => {
          if (!res) return;
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

      if (foundSpeds.length > 0) setSpedEntries(prev => mergeSpedBatch(prev, foundSpeds));
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
    setXmlList([]);
    setInutilizacoes([]);
    setOtherXmlsList([]);
    setNfseList([]);
    setExtractionErrors([]);
    setStats({
      totalFiles: 0,
      totalXmls: 0,
      validNf: 0,
      inutilizations: 0,
      cancellations: 0,
      nonXmlCount: 0
    });
    setAnalysis(null);
    setExpandedIdx(null);
    setIsConfirmed(false);
    setConsolidatedMessage('');
    setAttachedSources([]);
    setProcessedFileNames(new Set());
    setEntradaCount(0);
    setFornecedorEntradaInfo(null);
    setSpedEntries({});
    setSpedCardFiltro('Todas');
    setSpedCardOpen(false);
    setSpedSearch('');
    setFilterMes('Todos');
    setFilterModelo('Todos');
    setShowDaysDetail(false);
    setPortalConsultado(false);
    setForcarPainelInutilizacao(false);
    setNotaSearchQuery('');
    setFilterNotaModelo('Todos');
    setFilterNotaSituacao('Todas');
    setNotasSelecionadas(new Set());
    setShowSelecionadas(false);
    setManualInutSerie('');
    setManualInutIni('');
    setManualInutFim('');
    setManualInutData('');
  };

  const filteredAnalysis = useMemo(() => {
    if (!analysis) return [];
    return analysis.filter(serie => {
      const modeloMatch = filterModelo === 'Todos' || serie.modelo === filterModelo;
      return modeloMatch;
    });
  }, [analysis, filterModelo]);

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
    const zip = new JSZip();
    selecionadas.forEach(nota => {
      const name = nota.fileName || `${nota.chave}.xml`;
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      zip.file(safeName, nota.rawXml!);
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
              {exportProgress.etapa} — {exportProgress.atual} de {exportProgress.total} notas
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
                        ⚠ {auditoriaRegime.crtCounts[0]?.qtd} de {auditoriaRegime.totalNotas} nota(s) ({auditoriaRegime.pctPredominante}%) declaram CRT={auditoriaRegime.crtPredominante} — as outras {auditoriaRegime.semCrt.length} não trazem o campo CRT no XML (veja a amostra abaixo). Os XMLs deveriam seguir um padrão único; confirme com o cliente/sistema por que essas notas saíram diferentes.
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                        ✓ {auditoriaRegime.crtCounts[0]?.qtd} de {auditoriaRegime.totalNotas} nota(s) ({auditoriaRegime.pctPredominante}%) declaram o mesmo CRT de forma consistente nesse período — não é uma nota isolada, é sistemático.
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
            <img src="/logo-sf.png" alt="Contador de Padarias" className="h-16 print:h-14 object-contain" />
            <div className="hidden md:block w-px h-12 print:h-10 bg-white/15" />
            <div>
              <h1 className="font-serif text-3xl print:text-2xl font-semibold tracking-tight text-white mb-0.5 print:mb-0.5">Sequência Fiscal</h1>
              <p className="font-medium text-[0.95rem] print:text-sm" style={{color: 'rgba(201,162,39,0.8)'}}>Auditoria de Sequência de Vendas e Saídas</p>
            </div>
          </div>

          {analysis && (
            <div className="flex flex-col items-end gap-3 no-print">
              <div className="flex items-center gap-3 no-print">
                <ThemeToggle />
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
                            title={`Atenção: ${auditoriaRegime.semCrt.length > 0 ? `${auditoriaRegime.semCrt.length} nota(s) sem CRT declarado` : ''}${auditoriaRegime.semCrt.length > 0 && auditoriaRegime.mudouNoPeriodo ? ' e ' : ''}${auditoriaRegime.mudouNoPeriodo ? 'o CRT declarado mudou dentro do período' : ''} — só ${auditoriaRegime.pctPredominante}% das notas confirmam o regime predominante. Veja a Auditoria de Regime.`}
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
                  Pode haver notas fiscais faltando na análise abaixo por causa disso. Peça ao cliente para reenviar esses arquivos, de preferência divididos em partes menores (evite RAR com outros RARs aninhados dentro).
                </div>
                <ul className="space-y-1">
                  {extractionErrors.map((err, i) => (
                    <li key={i} className="text-xs font-mono text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2 break-words">
                      {err}
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
                      onClick={() => setShowAuditoriaIbsCbs(!showAuditoriaIbsCbs)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAuditoriaIbsCbs(!showAuditoriaIbsCbs); } }}
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
                  const pctIntegradoResumo = auditoriaPagamento.totalCartao > 0
                    ? Math.round((auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100)
                    : 0;
                  const pctNaoIntegradoResumo = auditoriaPagamento.totalCartao > 0
                    ? Math.round((auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100)
                    : 0;
                  const temProblemasTecnicos = auditoriaPagamento.problemas.length > 0;
                  const riscoObrigatoriedade = !regimeTributario.isSimples && !regimeTributario.isMei && regimeTributario.label !== null && auditoriaPagamento.totalNaoIntegrado > 0;
                  const corTef = temProblemasTecnicos || riscoObrigatoriedade
                    ? 'text-rose-600 dark:text-rose-400'
                    : pctNaoIntegradoResumo >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
                  return (
                    <div
                      onClick={() => setShowAuditoriaPagamento(!showAuditoriaPagamento)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAuditoriaPagamento(!showAuditoriaPagamento); } }}
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
                      <div className={cn("text-3xl font-bold mt-2", corTef)}>{pctIntegradoResumo}%</div>
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

              {/* Corpo em duas colunas: filtros/utilitários à esquerda, auditoria ao centro */}
              <div className="flex flex-col lg:flex-row gap-8 items-start">
                <aside className="w-full lg:w-72 shrink-0 lg:sticky lg:top-6 space-y-6">
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
                        placeholder={`Buscar por ${notaSearchCampo === 'Item' ? 'produto' : notaSearchCampo.toLowerCase()}...`}
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
                      if (sped) {
                        setSpedEntries(prev => upsertSpedManual(prev, sped));
                        setSpedCardFiltro('Todas');
                        setSpedSearch('');
                        setSpedCardOpen(true);
                      }
                      e.target.value = '';
                    }}
                  />
                </div>
              </aside>

              {/* Main content */}
              <div className="flex-1 min-w-0 space-y-8">

              {/* SPED Fiscal — card expandido (abre para a direita) */}
              {spedCardOpen && spedData && spedCrossRef && (() => {
                const formatValorSped = (v: string) => {
                  const n = parseFloat(v.replace(',', '.'));
                  return isNaN(n) ? v : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                };
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
                              {rows.map((x, i) => (
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
                            {spedRowsFiltradas.map((c, i) => {
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
                          {count} registro{count !== 1 ? 's' : ''}
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
                      Baixar XMLs (.zip)
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
                      <button
                        onClick={() => setShowAuditoriaIbsCbs(false)}
                        className="text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline no-print"
                      >
                        Ocultar
                      </button>
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
                    </div>
                  </div>
                );
              })()}

              {/* Card: Auditoria de Pagamento (TEF) — aberto pelo card compacto na lateral direita */}
              {showAuditoriaPagamento && (auditoriaPagamento.totalCartao > 0 || auditoriaPagamento.totalCartaoNaoAplicavel > 0 || auditoriaPagamento.problemas.length > 0 || auditoriaPagamento.breakdownPorTipoPagamento.length > 0) && (() => {
                const pctNaoIntegrado = auditoriaPagamento.totalCartao > 0
                  ? Math.round((auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100)
                  : 0;
                const pctIntegrado = auditoriaPagamento.totalCartao > 0
                  ? Math.round((auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100)
                  : 0;
                const pctFalsoTef = auditoriaPagamento.totalCartao > 0
                  ? Math.round((auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100)
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
                              {auditoriaPagamento.totalIntegrado} integrada(s){auditoriaPagamento.totalCartao > 0 && ` (${pctIntegrado}%)`}{auditoriaPagamento.totalIntegrado > 0 && ' ✓'}
                            </span>
                            <span className="text-slate-300 dark:text-slate-600">·</span>
                            <span className={auditoriaPagamento.totalNaoIntegrado > 0 ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-slate-400 dark:text-slate-500"} title="tpIntegra=2 — pagamento não integrado, digitado manualmente no POS">
                              {auditoriaPagamento.totalNaoIntegrado} POS manual{auditoriaPagamento.totalCartao > 0 && ` (${pctNaoIntegrado}%)`}{auditoriaPagamento.totalNaoIntegrado > 0 && ' ⚠'}
                            </span>
                            {auditoriaPagamento.totalFalsoTef > 0 && (
                              <>
                                <span className="text-slate-300 dark:text-slate-600">·</span>
                                <span className="text-rose-600 dark:text-rose-400 font-semibold" title="tpIntegra=1 SEM código de autorização — a nota declara integração que os dados não confirmam">
                                  {auditoriaPagamento.totalFalsoTef} Falso TEF ({pctFalsoTef}%) ⚠
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
                              <><span className="font-bold">{pctNaoIntegrado}% ({auditoriaPagamento.totalNaoIntegrado} de {auditoriaPagamento.totalCartao})</span> das vendas em cartão sujeitas a TEF foram digitadas manualmente no POS, sem passar pelo TEF integrado (tpIntegra=2)</>
                            ) : (
                              <><span className="font-bold">{pctIntegrado}% ({auditoriaPagamento.totalIntegrado} de {auditoriaPagamento.totalCartao})</span> das vendas em cartão sujeitas a TEF passaram pelo TEF integrado de verdade (com código de autorização)</>
                            )}.
                            {auditoriaPagamento.totalFalsoTef > 0 && (
                              <span> <strong>⚠ Alerta grave: {auditoriaPagamento.totalFalsoTef} venda(s) ({pctFalsoTef}%) dizem ter TEF integrado (tpIntegra=1) mas vieram SEM código de autorização</strong> — uma integração de verdade sempre traz esse código junto. Ou o PDV está configurado errado, ou o sistema está declarando integração que não existiu. Isso é mais grave que POS manual comum: é uma declaração que os próprios dados da nota contradizem. Cobre explicação do suporte do sistema do cliente.</span>
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
                const pctIntegradoPrint = auditoriaPagamento.totalCartao > 0 ? Math.round((auditoriaPagamento.totalIntegrado / auditoriaPagamento.totalCartao) * 100) : 0;
                const pctNaoIntegradoPrint = auditoriaPagamento.totalCartao > 0 ? Math.round((auditoriaPagamento.totalNaoIntegrado / auditoriaPagamento.totalCartao) * 100) : 0;
                const pctFalsoTefPrint = auditoriaPagamento.totalCartao > 0 ? Math.round((auditoriaPagamento.totalFalsoTef / auditoriaPagamento.totalCartao) * 100) : 0;
                const riscoObrigatoriedadePrint = !regimeTributario.isSimples && !regimeTributario.isMei && regimeTributario.label !== null && auditoriaPagamento.totalNaoIntegrado > 0;
                return (
                  <div className="print-section">
                    <h3 className="font-serif text-lg font-semibold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Auditoria de Pagamento (TEF)</h3>
                    <div className="text-sm mb-3">
                      {auditoriaPagamento.totalCartao} venda(s) em cartão sujeita(s) a TEF: <strong>{auditoriaPagamento.totalIntegrado} integrada(s) de verdade ({pctIntegradoPrint}%)</strong>, {auditoriaPagamento.totalNaoIntegrado} via POS manual ({pctNaoIntegradoPrint}%){auditoriaPagamento.totalFalsoTef > 0 && <>, {auditoriaPagamento.totalFalsoTef} em Falso TEF ({pctFalsoTefPrint}%)</>}{auditoriaPagamento.totalCartaoNaoAplicavel > 0 && <>, {auditoriaPagamento.totalCartaoNaoAplicavel} fora do escopo de TEF</>}.
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
