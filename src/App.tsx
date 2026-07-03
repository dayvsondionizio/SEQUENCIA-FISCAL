/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useMemo, useEffect } from 'react';
import JSZip from 'jszip';
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
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

interface XmlData {
  tipo: 'nfe' | 'inutilizacao' | 'evento' | 'consulta' | 'outro';
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
  // Value of the note's items (vProd), grouped by CFOP — used to break down
  // the total faturamento by natureza da operação (venda, devolução, etc.)
  cfopValores?: Record<string, number>;
  // True only for inutilizações typed in by the analyst after checking the SEFAZ
  // portal — distinguishes them from inutilizações that came from an XML the
  // client actually sent.
  origemManual?: boolean;
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
  cancelados?: number[];
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

// --- Helpers ---

const parser = new DOMParser();

function parseXML(xmlText: string, fileName: string): XmlData {
  const lowerText = xmlText.toLowerCase();
  
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
    return element ? element.textContent : '';
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
    // tpEvento: 110111 = Cancelamento; outros = carta de correção, etc.
    const tpEvento = getTextContent('tpEvento');
    const isCancelamentoEvento = tpEvento === '110111';
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

  // Check for Consultation results
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
    const destCnpj = dest?.getElementsByTagName('CNPJ')[0]?.textContent || '';
    const destNome = dest?.getElementsByTagName('xNome')[0]?.textContent || '';

    // Group each item's value (vProd) by its CFOP, so the note's total can later be
    // split by natureza da operação even when a single note mixes more than one CFOP
    const cfopValores: Record<string, number> = {};
    Array.from(doc.getElementsByTagName('det')).forEach(det => {
      const cfop = det.getElementsByTagName('CFOP')[0]?.textContent || '';
      const vProd = parseFloat(det.getElementsByTagName('vProd')[0]?.textContent || '0') || 0;
      if (cfop) cfopValores[cfop] = (cfopValores[cfop] || 0) + vProd;
    });

    if (numero && serie && modelo) {
      if (tpNF === '0') {
        return { tipo: 'outro', fileName };
      }
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
        tpNF,
        cfopValores,
        fileName,
        rawXml: xmlText
      };
    }
  }
  
  return { tipo: 'outro', fileName };
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
  const seen = new Set<string>();
  return list.filter(xml => {
    // Include tipo in the key so an 'evento' and an 'nfe' with the same chave are NOT considered duplicates
    const baseKey = xml.chave || `${xml.cnpj || ''}_${xml.modelo || ''}_${xml.serie || ''}_${xml.numero || ''}`;
    const key = `${xml.tipo}::${baseKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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

export default function App() {
  const [xmlList, setXmlList] = useState<XmlData[]>([]);
  const [inutilizacoes, setInutilizacoes] = useState<XmlData[]>([]);
  const [otherXmlsList, setOtherXmlsList] = useState<XmlData[]>([]);
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
  const [manualInutModelo, setManualInutModelo] = useState('65');
  const [manualInutSerie, setManualInutSerie] = useState('');
  const [manualInutIni, setManualInutIni] = useState('');
  const [manualInutFim, setManualInutFim] = useState('');
  const [manualInutData, setManualInutData] = useState('');
  const [portalConsultado, setPortalConsultado] = useState(false);
  const [forcarPainelInutilizacao, setForcarPainelInutilizacao] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedHeaderField, setCopiedHeaderField] = useState<string | null>(null);

  const copiarCampoHeader = (campo: string, valor: string) => {
    navigator.clipboard.writeText(valor);
    setCopiedHeaderField(campo);
    setTimeout(() => setCopiedHeaderField(null), 1500);
  };
  const [analystName, setAnalystName] = useState('');
  const [attachedSources, setAttachedSources] = useState<SourceMetadata[]>([]);
  const [processedFileNames, setProcessedFileNames] = useState<Set<string>>(new Set());
  const [entradaCount, setEntradaCount] = useState(0);
  
  // Editable messages state
  const [consolidatedMessage, setConsolidatedMessage] = useState('');

  // Filters
  const [filterModelo, setFilterModelo] = useState('Todos');
  const [filterMes, setFilterMes] = useState('Todos');
  const [showDaysDetail, setShowDaysDetail] = useState(false);
  const [showCfopBreakdown, setShowCfopBreakdown] = useState(false);
  const [notaSearchQuery, setNotaSearchQuery] = useState('');
  const [filterNotaModelo, setFilterNotaModelo] = useState('Todos');
  const [filterNotaSituacao, setFilterNotaSituacao] = useState('Todas');
  const [downloadingDanfeChave, setDownloadingDanfeChave] = useState<string | null>(null);
  const [notasSelecionadas, setNotasSelecionadas] = useState<Set<string>>(new Set());
  const [showSelecionadas, setShowSelecionadas] = useState(false);
  const [baixandoLote, setBaixandoLote] = useState<{ tipo: 'danfe' | 'xml'; atual: number; total: number } | null>(null);
  const [copiedCnpjIdx, setCopiedCnpjIdx] = useState<number | null>(null);

  const formatarMoeda = (valor: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(valor);
  };

  const faturamentoTotal = useMemo(() => {
    // Identify the Main Client Company CNPJ (the most frequent overall)
    const cnpjCounts: { [cnpj: string]: number } = {};
    xmlList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });

    const mainCnpj = Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!mainCnpj) return 0;

    // Build a set of note keys that have a genuine cancellation event (tpEvento === '110111')
    const chavesCanceladas = new Set<string>(
      xmlList
        .filter(xml => xml.tipo === 'evento' && xml.isCancelamento && xml.chave)
        .map(xml => xml.chave!)
    );

    return xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj)
      .reduce((acc, xml) => {
        // If the note's key appears in cancellation events set, treat its value as R$ 0,00
        if (xml.chave && chavesCanceladas.has(xml.chave)) return acc;
        return acc + (parseFloat(xml.valor || '0') || 0);
      }, 0);
  }, [xmlList]);

  // Breaks faturamentoTotal down by natureza da operação (CFOP), mirroring the
  // "Totais ICMS por Natureza" report from the fiscal system.
  const breakdownPorCfop = useMemo(() => {
    const cnpjCounts: { [cnpj: string]: number } = {};
    xmlList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });
    const mainCnpj = Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!mainCnpj) return [];

    const chavesCanceladas = new Set<string>(
      xmlList
        .filter(xml => xml.tipo === 'evento' && xml.isCancelamento && xml.chave)
        .map(xml => xml.chave!)
    );

    const totalPorCfop: Record<string, number> = {};
    xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj)
      .forEach(xml => {
        if (xml.chave && chavesCanceladas.has(xml.chave)) return;
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
  }, [xmlList]);

  // All saída notes of the main company, plus inutilizações (XML-sourced or
  // manually confirmed), flagged with cancellation status — the searchable
  // pool for "pesquisar notas de saída".
  const notasSaida = useMemo(() => {
    const cnpjCounts: { [cnpj: string]: number } = {};
    xmlList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });
    const mainCnpj = Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!mainCnpj) return [];

    const chavesCanceladas = new Set<string>(
      xmlList
        .filter(xml => xml.tipo === 'evento' && xml.isCancelamento && xml.chave)
        .map(xml => xml.chave!)
    );

    const notas = xmlList
      .filter(xml => xml.tipo === 'nfe' && xml.emitCnpj === mainCnpj)
      .map(xml => ({ ...xml, isCancelada: !!(xml.chave && chavesCanceladas.has(xml.chave)) }));

    const inuts = inutilizacoes
      .filter(inut => inut.cnpj === mainCnpj)
      .map(inut => ({
        ...inut,
        numero: inut.nNFIni === inut.nNFFin ? String(inut.nNFIni) : `${inut.nNFIni} a ${inut.nNFFin}`,
        isCancelada: false
      }));

    return [...notas, ...inuts];
  }, [xmlList, inutilizacoes]);

  const modelosDisponiveis = useMemo(() => {
    return Array.from(new Set(notasSaida.map(n => n.modelo).filter((m): m is string => !!m))).sort();
  }, [notasSaida]);

  const notasSaidaFiltradas = useMemo(() => {
    const query = notaSearchQuery.trim().toLowerCase();
    const temFiltroAtivo = query || filterNotaModelo !== 'Todos' || filterNotaSituacao !== 'Todas';
    if (!temFiltroAtivo) return [];

    return notasSaida.filter(nota => {
      if (filterNotaModelo !== 'Todos' && nota.modelo !== filterNotaModelo) return false;
      if (filterNotaSituacao === 'Válidas' && (nota.isCancelada || nota.tipo === 'inutilizacao')) return false;
      if (filterNotaSituacao === 'Canceladas' && (!nota.isCancelada || nota.tipo === 'inutilizacao')) return false;
      if (filterNotaSituacao === 'Inutilizadas' && nota.tipo !== 'inutilizacao') return false;
      if (!query) return true;

      const campos = [
        nota.chave, nota.numero, nota.serie, nota.modelo,
        nota.destNome, nota.destCnpj, nota.valor, nota.data,
        nota.natureza, nota.protocolo
      ];
      return campos.some(campo => campo && campo.toLowerCase().includes(query));
    });
  }, [notasSaida, notaSearchQuery, filterNotaModelo, filterNotaSituacao]);

  const periodoAnalise = useMemo(() => {
    // Identify the Main Client Company CNPJ (the most frequent overall)
    const cnpjCounts: { [cnpj: string]: number } = {};
    xmlList.forEach(xml => {
      if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
      if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
    });

    const mainCnpj = Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

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

    const uniqueDays = Array.from(new Set(datas));
    const epochDays = uniqueDays.map(getEpochDay).sort((a, b) => a - b);
    const groupedEpochs = agruparFaixas(epochDays);
    
    const diasDetalhados = groupedEpochs.map(faixa => {
      if (faixa.length === 1) {
        return fromEpochDay(faixa[0]);
      } else {
        return `${fromEpochDay(faixa[0])} a ${fromEpochDay(faixa[faixa.length - 1])}`;
      }
    });
    
    return {
      inicio: formatarDataBR(datas[0]),
      fim: formatarDataBR(datas[datas.length - 1]),
      totalDias: uniqueDays.length,
      diasDetalhados
    };
  }, [xmlList]);

  const mesesDisponiveis = useMemo(() => {
    const months = new Set<string>();
    xmlList.forEach(xml => {
      const my = getMonthYear(xml.data);
      if (my) months.add(my);
    });
    return Array.from(months).sort();
  }, [xmlList]);

  useEffect(() => {
    if (analysis) {
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMes, inutilizacoes]);

  const exportFilteredXmls = async () => {
    let filteredXmls = xmlList;
    if (filterMes !== 'Todos') {
      filteredXmls = xmlList.filter(xml => getMonthYear(xml.data) === filterMes);
    }

    if (filteredXmls.length === 0) {
      alert("Nenhum XML de nota fiscal encontrado para exportar.");
      return;
    }

    const zip = new JSZip();
    
    filteredXmls.forEach(xml => {
      const name = xml.fileName || `${xml.chave || xml.numero}.xml`;
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      if (xml.rawXml) {
        zip.file(safeName, xml.rawXml);
      }
    });

    let filteredInuts = inutilizacoes;
    if (filterMes !== 'Todos') {
      filteredInuts = inutilizacoes.filter(inut => getMonthYear(inut.data) === filterMes);
    }
    
    filteredInuts.forEach(inut => {
      const name = inut.fileName || `inutilizacao_${inut.serie}_${inut.nNFIni}_${inut.nNFFin}.xml`;
      const safeName = name.toLowerCase().endsWith('.xml') ? name : `${name}.xml`;
      if (inut.rawXml) {
        zip.file(`inutilizacoes/${safeName}`, inut.rawXml);
      }
    });

    try {
      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      const suffix = filterMes === 'Todos' ? 'todos_meses' : filterMes.replace('/', '_');
      link.download = `xmls_filtrados_${suffix}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("Erro ao gerar arquivo ZIP:", err);
      alert("Erro ao exportar arquivos XML.");
    }
  };

  const [wasmBinary, setWasmBinary] = useState<ArrayBuffer | null>(null);
  const [extractionStatus, setExtractionStatus] = useState<string | null>(null);

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
              try {
                const xmlText = await entry.async('text');
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
                    } else {
                      results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                    }
                  } else { results.localNonXmlCount++; }
                } else { results.localNonXmlCount++; }
              } catch (e) { results.localNonXmlCount++; }
            } else {
              const innerArchiveName = baseName;
              const innerArchiveData = await entry.async('uint8array');
              await processArchiveRecursively(innerArchiveData, results, innerArchiveName, currentPath);
            }
          }
          return;
        } catch (e) { console.error('Erro ZIP:', e); return; }
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
            const fileData = await entry.extract();
            const baseName = name.split('/').pop() || name;
            
            if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
              await processArchiveRecursively(new Uint8Array(await fileData.arrayBuffer()), results, baseName, currentPath);
            } else {
              const xmlText = await fileData.text();
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
            const extractor = await createExtractorFromData({ data: new Uint8Array(cleanBuffer), wasmBinary: currentWasm });
            const extracted = extractor.extract();
            for (const file of extracted.files) {
              if (!file.extraction || file.extraction.length === 0) continue;
              const name = file.fileHeader.name;
              const baseName = name.split('/').pop() || name;
              if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
                await processArchiveRecursively(file.extraction, results, baseName, currentPath);
              } else {
                const xmlText = new TextDecoder().decode(file.extraction);
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
                    } else {
                      results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                    }
                  } else { results.localNonXmlCount++; }
                } else { results.localNonXmlCount++; }
              }
            }
          }
        } catch (rarErr) { console.error('Erro RAR final:', rarErr); }
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
            localTotalCount: 0, 
            localCancellations: 0,
            localValidNfCount: 0,
            localInutsCount: 0,
            localNonXmlCount: 0
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
              } else {
                res.localOthers.push({ fileName: file.name, subTipo: data.subTipo, tipo: data.tipo } as any);
              }
            } catch (e) {
              console.error('Erro ao processar XML:', file.name, e);
            }
          } else if (nameLower.endsWith('.zip') || nameLower.endsWith('.rar')) {
            const zipData = await file.arrayBuffer();
            await processArchiveRecursively(zipData, res, file.name);
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

      // Check CNPJ consistency (prevent loading different clients, but allow multiple suppliers on purchases/entradas)
      const cnpjCounts: Record<string, number> = {};
      mergedXmls.forEach(xml => {
        if (xml.emitCnpj) cnpjCounts[xml.emitCnpj] = (cnpjCounts[xml.emitCnpj] || 0) + 1;
        if (xml.destCnpj) cnpjCounts[xml.destCnpj] = (cnpjCounts[xml.destCnpj] || 0) + 1;
      });
      mergedInuts.forEach(inut => {
        if (inut.cnpj) cnpjCounts[inut.cnpj] = (cnpjCounts[inut.cnpj] || 0) + 1;
      });

      // The main company CNPJ is the most frequent CNPJ overall (as emitter or receiver)
      const mainCnpj = Object.entries(cnpjCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      // Chaves (chNFe) of notes that belong to the main company, used to validate events below
      const mainCnpjChaves = new Set<string>(
        mergedXmls
          .filter(xml => xml.tipo === 'nfe' && (xml.emitCnpj === mainCnpj || xml.destCnpj === mainCnpj) && xml.chave)
          .map(xml => xml.chave!)
      );

      // Identify XMLs that do not involve the main company (neither as emitter nor as receiver)
      const conflictingXmls: XmlData[] = [];
      if (mainCnpj) {
        mergedXmls.forEach(xml => {
          let involvesMain: boolean;
          if (xml.tipo === 'evento') {
            // Events (cancelamento, manifestação do destinatário, etc.) can legitimately be
            // authored by a third party (e.g. the customer manifesting receipt), so the event's
            // own CNPJ isn't a reliable company match. What matters is whether it references
            // (via chNFe) a note that already belongs to the main company.
            involvesMain = (xml.chave ? mainCnpjChaves.has(xml.chave) : false) || xml.cnpj === mainCnpj;
          } else {
            involvesMain = xml.emitCnpj === mainCnpj || xml.destCnpj === mainCnpj || xml.cnpj === mainCnpj;
          }
          if (!involvesMain) {
            conflictingXmls.push(xml);
          }
        });
        mergedInuts.forEach(inut => {
          if (inut.cnpj !== mainCnpj) {
            conflictingXmls.push(inut);
          }
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
          
          alert(`⚠️ Erro de Importação: Múltiplas Empresas Detectadas!\n\nForam encontrados XMLs de outra empresa que não pertencem à empresa principal sob auditoria:\n${conflictList.join('\n')}\n\nPara evitar inconsistências, envie apenas arquivos de uma única empresa por vez.`);
          
          setIsProcessing(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
          if (folderInputRef.current) folderInputRef.current.value = '';
          return;
        }
      }

      setAttachedSources(Array.from(sourceMap.values()));
      setProcessedFileNames(updatedProcessedNames);
      setXmlList(mergedXmls);
      setInutilizacoes(mergedInuts);
      setOtherXmlsList(mergedOthers);

      setStats(prev => ({
        ...prev,
        totalXmls: mergedXmls.length + mergedInuts.length + mergedOthers.length
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
    if (xmlList.length === 0) return;

    let filteredXmlsList = xmlList;
    let filteredInutsList = inutilizacoes;

    if (filterMes !== 'Todos') {
      filteredXmlsList = xmlList.filter(xml => getMonthYear(xml.data) === filterMes);
      filteredInutsList = inutilizacoes.filter(inut => getMonthYear(inut.data) === filterMes);
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
      
      // Como já filtramos tpNF === '0' no parse e garantimos que emitCnpj === mainCnpj
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
          situacao: 'Íntegra',
          mesReferencia: ''
        };
      }
      groups[key].xmls.push(xml);
    });

    setEntradaCount(localEntradaCount);
    const result = Object.values(groups).map(group => {
      const numeros = group.xmls.map(x => parseInt(x.numero!)).sort((a, b) => a - b);
      const min = numeros[0];
      const max = numeros[numeros.length - 1];
      const esperados = max - min + 1;
      const recebidos = numeros.length;

      // Optimized missing number detection
      let faltantes: number[] = [];
      if (esperados > recebidos) {
        const numerosSet = new Set(numeros);
        // If the gap is huge, we might still hang, but Set.has is O(1)
        // For extremely large gaps, we might want to limit this or use a different approach
        for (let i = min; i <= max; i++) {
          if (!numerosSet.has(i)) {
            faltantes.push(i);
            // Safety break to avoid memory crash if millions are missing
            if (faltantes.length > 10000) break;
          }
        }
      }

      const inutSerie = filteredInutsList.filter(inut => 
        inut.cnpj === group.cnpj && 
        inut.modelo === group.modelo && 
        inut.serie === group.serie
      );

      const numerosInutilizadosSet = new Set<number>();
      const numerosInutilizadosManualSet = new Set<number>();
      inutSerie.forEach(inut => {
        for (let i = inut.nNFIni!; i <= inut.nNFFin!; i++) {
          numerosInutilizadosSet.add(i);
          if (inut.origemManual) numerosInutilizadosManualSet.add(i);
        }
      });

      const faltantesReais = faltantes.filter(num => !numerosInutilizadosSet.has(num));
      const faltantesInutilizados = faltantes.filter(num => numerosInutilizadosSet.has(num));
      const faltantesInutilizadosManual = faltantesInutilizados.filter(num => numerosInutilizadosManualSet.has(num));

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
        faltantes: faltantesReais,
        faltantesInutilizados,
        faltantesInutilizadosManual,
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
    <div className="min-h-screen flex flex-col font-sans text-slate-900 relative" style={{background: '#f0f4f8'}}>
      {/* Loading Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] backdrop-blur-sm flex flex-col items-center justify-center text-white p-6"
            style={{background: 'rgba(10,14,35,0.88)'}}
          >
            <div className="relative w-24 h-24 mb-8">
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 rounded-full"
                style={{border: '4px solid rgba(240,180,41,0.25)', borderTopColor: '#F0B429'}}
              />
              <motion.div 
                animate={{ rotate: -360 }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                className="absolute inset-4 rounded-full"
                style={{border: '4px solid rgba(255,255,255,0.1)', borderTopColor: 'rgba(255,255,255,0.6)'}}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <img src="/simbolo.png" alt="" className="w-9 h-9 object-contain animate-pulse" />
              </div>
            </div>
            <h2 className="text-2xl font-bold mb-2">Processando Arquivos</h2>
            <div className="w-64 h-2 rounded-full overflow-hidden mb-4" style={{background: 'rgba(255,255,255,0.1)'}}>
              <motion.div 
                className="h-full"
                style={{background: 'linear-gradient(90deg, #F0B429, #f5d060)'}}
                initial={{ width: 0 }}
                animate={{ width: `${(processingProgress.current / processingProgress.total) * 100}%` }}
              />
            </div>
            <p className="text-center max-w-md" style={{color: 'rgba(255,255,255,0.6)'}}>
              Lendo {processingProgress.current} de {processingProgress.total} arquivos...
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="text-white shadow-2xl" style={{background: '#020D2F'}}>
        <div className="max-w-[1650px] mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex items-center gap-5">
            <img src="/logo-sf.png" alt="Contador de Padarias" className="h-16 object-contain" />
            <div className="hidden md:block w-px h-12 bg-white/15" />
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white mb-0.5">Sequência Fiscal</h1>
              <p className="font-medium" style={{color: 'rgba(240,180,41,0.8)', fontSize: '0.95rem'}}>Auditoria de Sequência de Vendas e Saídas</p>
            </div>
          </div>

          {analysis && analysis.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="backdrop-blur-md rounded-2xl p-5 flex flex-col gap-1 min-w-[360px] shadow-2xl"
              style={{background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(240,180,41,0.2)'}}
            >
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Empresa:</span>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-white font-bold text-base truncate min-w-0">{analysis[0].razaoSocial}</span>
                  <button
                    onClick={() => copiarCampoHeader('empresa', analysis[0].razaoSocial)}
                    className="shrink-0 transition-colors"
                    style={{color: copiedHeaderField === 'empresa' ? '#F0B429' : 'rgba(255,255,255,0.3)'}}
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
                    style={{color: copiedHeaderField === 'cnpj' ? '#F0B429' : 'rgba(255,255,255,0.3)'}}
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
                    style={{color: copiedHeaderField === 'ie' ? '#F0B429' : 'rgba(255,255,255,0.3)'}}
                    title="Copiar Inscrição Estadual"
                  >
                    {copiedHeaderField === 'ie' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>

                <span className="font-bold uppercase text-[11px] self-center tracking-wide" style={{color: 'rgba(255,255,255,0.55)'}}>Meses:</span>
                <span className="font-bold text-sm leading-snug" style={{color: '#F0B429'}}>
                  {mesesDisponiveis.length === 0 && 'N/A'}
                  {mesesDisponiveis.length > 0 && mesesDisponiveis.length <= 3 && mesesDisponiveis.join(', ')}
                  {mesesDisponiveis.length > 3 && `${mesesDisponiveis.slice(0, 3).join(', ')} +${mesesDisponiveis.length - 3}`}
                </span>
              </div>
            </motion.div>
          )}
        </div>
      </header>

      <main className="max-w-[1650px] mx-auto p-6 lg:p-8 no-print flex-1 w-full">
        <AnimatePresence mode="wait">
          {!analysis ? (
            <motion.div 
              key="upload"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* Stats Summary - Now at the top for better visibility */}
              {stats.totalFiles > 0 && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden"
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

                  {attachedSources.length > 0 && (
                    <div className="p-6 border-t border-slate-100/50">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Fontes Anexadas ({attachedSources.length})</div>
                      <div className="flex flex-wrap gap-2 max-h-[360px] overflow-y-auto custom-scrollbar pr-1">
                        {attachedSources.map((source, sIdx) => {
                          // Somar todos os tipos de documentos fiscais identificados nesta fonte
                          const countNfe = xmlList.filter(x => x.sourceName === source.name).length;
                          const countInut = inutilizacoes.filter(x => x.sourceName === source.name).length;
                          const countOther = otherXmlsList.filter(x => x.sourceName === source.name).length;
                          const totalFiscalInSource = countNfe + countInut + countOther;
                          
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
                        disabled={xmlList.length === 0}
                        className="flex items-center gap-2 px-10 py-5 text-white rounded-2xl font-bold text-xl transition-all shadow-lg disabled:opacity-50 disabled:grayscale scale-105 active:scale-100"
                      style={{background: '#020D2F', boxShadow: '0 8px 32px rgba(2,13,47,0.4)'}}
                      >
                        <CheckCircle2 className="w-7 h-7" />
                        Iniciar Auditoria Agora
                      </button>
                      <button 
                        onClick={reset}
                        className="flex items-center gap-2 px-8 py-5 bg-white border border-slate-200 text-slate-600 rounded-2xl font-bold hover:bg-slate-50 transition-all active:scale-95"
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
                  "relative group bg-white border-4 border-dashed border-slate-200 rounded-3xl transition-all duration-500",
                  stats.totalFiles > 0 ? "p-8 opacity-60 hover:opacity-100" : "p-12 text-center",
                  "hover:border-blue-400 hover:bg-blue-50/30 cursor-pointer"
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
                      "p-5 bg-slate-100 rounded-full text-slate-400 group-hover:text-blue-500 group-hover:bg-blue-100 transition-colors",
                      stats.totalFiles > 0 && "scale-75"
                    )}>
                      <Upload className="w-8 h-8" />
                    </div>
                    <div className={stats.totalFiles === 0 ? "text-center" : "text-left"}>
                      <h3 className={cn(
                        "font-bold text-slate-800",
                        stats.totalFiles === 0 ? "text-xl" : "text-lg"
                      )}>
                        {stats.totalFiles === 0 ? "Arraste seus arquivos aqui" : "Deseja adicionar mais arquivos?"}
                      </h3>
                    <p className="text-slate-500 text-sm mt-1">Suporta XMLs individuais, pastas ou arquivos ZIP</p>
                  </div>
                </div>

                {extractionStatus && (
                  <div className="flex items-center gap-3 text-emerald-600 bg-emerald-50 px-6 py-3 rounded-2xl border border-emerald-100 animate-pulse mb-6 shadow-sm">
                    <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-bounce"></div>
                    <span className="text-sm font-black uppercase tracking-wider">{extractionStatus}</span>
                  </div>
                )}
                
                <div className="flex flex-col items-center">
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-3 px-10 py-5 text-white rounded-2xl font-bold transition-all active:scale-95 hover:scale-[1.02] shadow-xl"
                      style={{background: '#020D2F'}}
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
              className="flex flex-col lg:flex-row gap-8 items-start"
            >
              {/* Sidebar — summary + search, stays in view while the main content scrolls */}
              <aside className="w-full lg:w-80 shrink-0 lg:sticky lg:top-6 space-y-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Total de Saídas Auditadas (Válidas)</div>
                  <div className="text-3xl font-black text-emerald-600 mt-2">
                    {formatarMoeda(faturamentoTotal)}
                  </div>
                  {breakdownPorCfop.length > 0 && (
                    <button
                      onClick={() => setShowCfopBreakdown(!showCfopBreakdown)}
                      title="Ver totais por natureza (CFOP)"
                      className="inline-flex items-center justify-center cursor-pointer mt-3 no-print"
                    >
                      <ChevronRight className={cn("w-6 h-6 text-slate-300 hover:text-slate-500 transition-all duration-300", showCfopBreakdown && "rotate-90")} />
                    </button>
                  )}
                </div>
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm transition-all">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Período Analisado</div>
                  <div className="text-xl font-black text-slate-900 mt-2">
                    {periodoAnalise.inicio ? `${periodoAnalise.inicio} a ${periodoAnalise.fim}` : 'N/A'}
                  </div>
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mt-2">
                    <span>{periodoAnalise.totalDias} dias com movimentação</span>
                    {periodoAnalise.diasDetalhados && periodoAnalise.diasDetalhados.length > 0 && (
                      <button
                        onClick={() => setShowDaysDetail(!showDaysDetail)}
                        title="Ver detalhes"
                        className="inline-flex items-center justify-center cursor-pointer shrink-0"
                      >
                        <ChevronRight className={cn("w-6 h-6 text-slate-300 hover:text-slate-500 transition-all duration-300", showDaysDetail && "rotate-90")} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">Pesquisar Notas de Saída</div>
                  <div className="flex flex-col gap-2">
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={notaSearchQuery}
                        onChange={(e) => setNotaSearchQuery(e.target.value)}
                        placeholder="Número, chave, cliente, data, valor..."
                        className="w-full pl-11 pr-4 py-3 rounded-2xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                      />
                    </div>
                    <select
                      value={filterNotaModelo}
                      onChange={(e) => setFilterNotaModelo(e.target.value)}
                      className="px-3 py-2.5 rounded-2xl border border-slate-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
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
                      className="px-3 py-2.5 rounded-2xl border border-slate-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <option value="Todas">Todas as situações</option>
                      <option value="Válidas">Somente válidas</option>
                      <option value="Canceladas">Somente canceladas</option>
                      <option value="Inutilizadas">Somente inutilizadas</option>
                    </select>
                  </div>
                </div>
              </aside>

              {/* Main content */}
              <div className="flex-1 min-w-0 space-y-8">
              {/* Selection bar — always visible regardless of the current search/filter, since
                  selections made across earlier searches must stay reachable and downloadable. */}
              {notasSelecionadas.size > 0 && (
                <div className="bg-white p-4 rounded-3xl border border-slate-200 shadow-sm no-print">
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold disabled:opacity-40 hover:bg-slate-700 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {baixandoLote?.tipo === 'danfe' ? `Gerando ${baixandoLote.atual}/${baixandoLote.total}...` : 'Baixar DANFEs (.zip)'}
                    </button>
                    <button
                      onClick={() => baixarXmlsSelecionados()}
                      disabled={!!baixandoLote}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold disabled:opacity-40 hover:bg-slate-50 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Baixar XMLs (.zip)
                    </button>
                    <button
                      onClick={() => setNotasSelecionadas(new Set())}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-slate-500 text-xs font-bold hover:text-slate-700 transition-all ml-auto"
                    >
                      <X className="w-3.5 h-3.5" />
                      Limpar seleção
                    </button>
                  </div>
                  {showSelecionadas && (
                    <div className="mt-3 pt-3 border-t border-slate-100 max-h-64 overflow-y-auto custom-scrollbar space-y-1.5">
                      {notasSaida.filter(n => n.chave && notasSelecionadas.has(n.chave)).map(nota => (
                        <div key={nota.chave} className="flex items-center justify-between gap-3 text-xs bg-slate-50 rounded-lg px-3 py-2">
                          <span className="font-semibold text-slate-900">Nº {nota.numero}</span>
                          <span className="text-slate-500 truncate flex-1">{nota.destNome || '—'}</span>
                          <span className="font-semibold text-slate-700">{formatarMoeda(parseFloat(nota.valor || '0') || 0)}</span>
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
              {(notaSearchQuery.trim() || filterNotaModelo !== 'Todos' || filterNotaSituacao !== 'Todas') && (
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="overflow-x-auto overflow-y-auto max-h-[520px] custom-scrollbar">
                    {notasSaidaFiltradas.length === 0 ? (
                      <p className="text-sm text-slate-400 py-4 text-center">Nenhuma nota encontrada com os filtros atuais.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white z-10">
                          <tr className="text-left text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-200">
                            <th className="py-2 pr-2 w-8"></th>
                            <th className="py-2 pr-4">Número</th>
                            <th className="py-2 pr-4">Série/Modelo</th>
                            <th className="py-2 pr-4">Cliente</th>
                            <th className="py-2 pr-4">Data</th>
                            <th className="py-2 pr-4 text-right">Valor</th>
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
                              <tr key={nota.chave || `${nota.cnpj}-${nota.modelo}-${nota.serie}-${nota.nNFIni}-${idx}`} className="border-b border-slate-100 last:border-0">
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
                                <td className="py-2 pr-4 font-semibold text-slate-900">{nota.numero}</td>
                                <td className="py-2 pr-4 text-slate-500">{nota.serie}/{nota.modelo}</td>
                                <td className="py-2 pr-4 text-slate-700">{isInutilizacao ? '—' : (nota.destNome || '—')}</td>
                                <td className="py-2 pr-4 text-slate-500">{nota.data ? nota.data.substring(0, 10).split('-').reverse().join('/') : '—'}</td>
                                <td className="py-2 pr-4 text-right font-semibold text-slate-900">{isInutilizacao ? '—' : formatarMoeda(parseFloat(nota.valor || '0') || 0)}</td>
                                <td className="py-2 pr-4 text-slate-400 font-mono text-xs">{isInutilizacao ? '—' : nota.chave}</td>
                                <td className="py-2 pr-4">
                                  {isInutilizacao ? (
                                    nota.origemManual ? (
                                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-bold">Inutilizada (Manual)</span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-xs font-bold">Inutilizada (XML)</span>
                                    )
                                  ) : nota.isCancelada ? (
                                    <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 text-xs font-bold">Cancelada</span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-xs font-bold">Válida</span>
                                  )}
                                </td>
                                <td className="py-2 pr-4">
                                  {!isInutilizacao && (
                                    <button
                                      onClick={() => baixarDanfe(nota)}
                                      disabled={downloadingDanfeChave === nota.chave || !nota.rawXml}
                                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700 transition-all"
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

              {showDaysDetail && periodoAnalise.diasDetalhados && periodoAnalise.diasDetalhados.length > 0 && (
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Dias com Movimentação Detalhados</div>
                  <div className="flex flex-wrap gap-2">
                    {periodoAnalise.diasDetalhados.map((dia, idx) => (
                      <span key={idx} className="font-mono text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                        {dia}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {showCfopBreakdown && breakdownPorCfop.length > 0 && (
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm mb-6">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Totais por Natureza da Operação (CFOP)</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-200">
                          <th className="py-2 pr-4">CFOP</th>
                          <th className="py-2 pr-4">Natureza</th>
                          <th className="py-2 pr-4 text-right whitespace-nowrap">Vlr Contábil</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPorCfop.map(({ cfop, descricao, valor }) => (
                          <tr key={cfop} className="border-b border-slate-100 last:border-0">
                            <td className="py-2 pr-4 font-mono text-slate-500">{cfop}</td>
                            <td className="py-2 pr-4 text-slate-700">{descricao}</td>
                            <td className="py-2 pr-4 text-right font-semibold text-slate-900">{formatarMoeda(valor)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={2} className="py-3 pr-4 font-black text-slate-900 uppercase text-xs tracking-wider">Total de Saídas</td>
                          <td className="py-3 pr-4 text-right font-black text-emerald-600">
                            {formatarMoeda(breakdownPorCfop.reduce((acc, item) => acc + item.valor, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {(() => {
                const faltantesLiquidos = analysis.reduce((acc, s) => acc + s.faltantes.length, 0);
                const totalManual = analysis.reduce((acc, s) => acc + s.faltantesInutilizadosManual.length, 0);
                const faltantesBrutos = faltantesLiquidos + totalManual;

                return (
                  <div className={cn("grid grid-cols-2 gap-4", totalManual > 0 ? "md:grid-cols-3 lg:grid-cols-6" : "md:grid-cols-4")}>
                    <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                      <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Séries</div>
                      <div className="text-4xl font-black text-slate-900 mt-2">{analysis.length}</div>
                    </div>
                    <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                      <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Com Quebra</div>
                      <div className="text-4xl font-black text-amber-500 mt-2">
                        {analysis.filter(s => s.faltantes.length > 0).length}
                      </div>
                    </div>
                    {totalManual > 0 ? (
                      <>
                        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm no-print">
                          <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Faltante Bruto (XML)</div>
                          <div className="text-4xl font-black text-rose-600 mt-2">{faltantesBrutos}</div>
                        </div>
                        <div className="bg-white p-6 rounded-3xl border border-amber-200 shadow-sm no-print">
                          <div className="text-sm font-bold text-amber-600 uppercase tracking-widest">Inutilizadas Sem XML</div>
                          <div className="text-4xl font-black text-amber-600 mt-2">{totalManual}</div>
                        </div>
                        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                          <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Faltante Líquido</div>
                          <div className="text-4xl font-black text-slate-500 mt-2">{faltantesLiquidos}</div>
                        </div>
                      </>
                    ) : (
                      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                        <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Total Faltantes</div>
                        <div className="text-4xl font-black text-rose-600 mt-2">{faltantesLiquidos}</div>
                      </div>
                    )}
                    <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                      <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Total Recebidos</div>
                      <div className="text-4xl font-black text-blue-600 mt-2">
                        {analysis.reduce((acc, s) => acc + s.recebidos, 0)}
                      </div>
                    </div>
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
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-col gap-3 no-print">
                    {exibirBotoes && (
                      <>
                        <div className="text-sm text-amber-800">
                          <span className="font-bold">Números faltantes sem inutilização correspondente.</span> Pode valer a pena conferir no portal da SEFAZ antes de fechar a análise.
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {seriePendenteNfce && (
                            <button
                              onClick={() => consultarInutilizadasNoPortal(seriePendenteNfce.cnpj, -1, PORTAL_INUTILIZADAS_NFCE_PE, '65')}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-all shrink-0"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              {copiedCnpjIdx === -1 ? 'CNPJ copiado! Abrindo portal...' : 'Consultar Inutilizações NFC-e no Portal'}
                            </button>
                          )}
                          {seriePendenteNfe && (
                            <button
                              onClick={() => consultarInutilizadasNoPortal(seriePendenteNfe.cnpj, -2, PORTAL_INUTILIZADAS_NFE_PE, '55')}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-all shrink-0"
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
                            className="px-3 py-2 rounded-xl border border-amber-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
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
                            className="w-24 px-3 py-2 rounded-xl border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Nº Inicial</label>
                          <input
                            type="number"
                            value={manualInutIni}
                            onChange={(e) => setManualInutIni(e.target.value)}
                            className="w-28 px-3 py-2 rounded-xl border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Nº Final</label>
                          <input
                            type="number"
                            value={manualInutFim}
                            onChange={(e) => setManualInutFim(e.target.value)}
                            className="w-28 px-3 py-2 rounded-xl border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Data (no portal)</label>
                          <input
                            type="date"
                            value={manualInutData}
                            onChange={(e) => setManualInutData(e.target.value)}
                            className="px-3 py-2 rounded-xl border border-amber-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                          />
                        </div>
                        <button
                          onClick={confirmarInutilizacaoManual}
                          className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-700 transition-all"
                        >
                          Confirmar Inutilização
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Filters */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center gap-4 no-print">
                <div className="flex items-center gap-2 text-slate-500 font-bold text-sm px-2">
                  <Filter className="w-4 h-4" />
                  FILTROS:
                </div>
                <select 
                  value={filterModelo} 
                  onChange={(e) => setFilterModelo(e.target.value)}
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="Todos">Todos os Modelos</option>
                  <option value="55">Modelo 55 (NF-e)</option>
                  <option value="65">Modelo 65 (NFC-e)</option>
                </select>
                <select 
                  value={filterMes} 
                  onChange={(e) => setFilterMes(e.target.value)}
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="Todos">Todos os Meses</option>
                  {mesesDisponiveis.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  onClick={exportFilteredXmls}
                  className="flex items-center gap-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  Exportar XMLs ({filterMes === 'Todos' ? 'Todos' : filterMes})
                </button>
                <div className="flex-1" />
                
                {analysis && (
                  <div className="flex flex-col items-end">
                    <button 
                      onClick={() => window.print()}
                      className="flex items-center gap-2 text-white px-5 py-2 rounded-xl text-sm font-black transition-all shadow-lg"
                      style={{background: '#020D2F'}}
                    >
                      <Printer className="w-4 h-4" />
                      Imprimir Relatório
                    </button>
                    {window.self !== window.top && (
                      <span className="text-[9px] text-slate-400 mt-1 font-bold">
                        Dica: Se não abrir, use o ícone "Abrir em nova aba" no topo.
                      </span>
                    )}
                  </div>
                )}

                <button 
                  onClick={reset}
                  className="text-sm font-bold text-blue-600 hover:text-blue-700 px-4 py-2"
                >
                  Nova Análise
                </button>
              </div>

              {/* Series List */}
              <div className="space-y-4">
                {filteredAnalysis.map((serie, idx) => (
                  <div key={idx} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden transition-all hover:shadow-md">
                    <div 
                      className="p-6 cursor-pointer flex items-center gap-6"
                      onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                    >
                      <div className={cn(
                        "w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg",
                        serie.faltantes.length > 0 ? "bg-rose-100 text-rose-600" : "bg-emerald-100 text-emerald-600"
                      )}>
                        {serie.faltantes.length > 0 ? "!" : "✓"}
                      </div>
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-bold text-slate-800 text-lg">{serie.razaoSocial}</h3>
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded uppercase tracking-wider border border-slate-200">
                            {serie.mesReferencia}
                          </span>
                        </div>
                        <div className="text-slate-400 text-sm font-medium">
                          Mod {serie.modelo} • Série {serie.serie} • CNPJ {serie.cnpj} • IE {serie.ie}
                        </div>
                      </div>

                      <div className="flex gap-8 items-center">
                        <div className="text-center">
                          <div className="text-xs font-bold text-slate-400 uppercase tracking-tighter">Recebidos</div>
                          <div className="text-xl font-black text-slate-900">{serie.recebidos}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-xs font-bold text-slate-400 uppercase tracking-tighter">Faltantes</div>
                          <div className={cn(
                            "text-xl font-black",
                            serie.faltantes.length > 0 ? "text-rose-600" : "text-emerald-600"
                          )}>
                            {serie.faltantes.length}
                          </div>
                        </div>
                        <ChevronRight className={cn(
                          "w-6 h-6 text-slate-300 transition-transform duration-300",
                          expandedIdx === idx && "rotate-90"
                        )} />
                      </div>
                    </div>

                    {expandedIdx === idx && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        className="border-t border-slate-100 bg-slate-50/50 p-8 space-y-6"
                      >
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="bg-white p-4 rounded-xl border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Menor Número</div>
                            <div className="text-lg font-bold text-slate-900">{serie.min}</div>
                          </div>
                          <div className="bg-white p-4 rounded-xl border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Maior Número</div>
                            <div className="text-lg font-bold text-slate-900">{serie.max}</div>
                          </div>
                          <div className="bg-white p-4 rounded-xl border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Esperados</div>
                            <div className="text-lg font-bold text-slate-900">{serie.esperados}</div>
                          </div>
                          <div className="bg-white p-4 rounded-xl border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Situação</div>
                            <div className="text-lg font-bold text-slate-900">{serie.situacao}</div>
                          </div>
                        </div>

                        {serie.faltantesInutilizados.length > 0 && (
                          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-emerald-800 text-sm space-y-2">
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
                                  {serie.faltantesInutilizadosManual.length > 0 && (
                                    <div className="flex items-start gap-2 bg-white/60 border border-emerald-300 rounded-lg p-2 no-print">
                                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
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
                          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-800 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1">
                              <AlertCircle className="w-4 h-4 text-amber-600" />
                              Cancelamentos Identificados ({serie.cancelados.length})
                            </div>
                            Números: {formatarFaixas(agruparFaixas(serie.cancelados))}
                          </div>
                        )}

                        {serie.faltantes.length > 0 && (
                          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-800 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1">
                              <AlertCircle className="w-4 h-4" />
                              Números Ausentes ({serie.faltantes.length})
                            </div>
                            {formatarFaixas(agruparFaixas(serie.faltantes))}
                          </div>
                        )}

                        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-blue-800 text-sm">
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

              {/* Consolidated Message */}
              {analysis.some(s => s.faltantes.length > 0) && (
                <div className="bg-white rounded-3xl border-2 border-blue-600 p-8 shadow-xl no-print">
                  <div className="flex justify-between items-center mb-6">
                    <div>
                      <h2 className="text-2xl font-bold text-slate-900">Relatório Consolidado</h2>
                      <p className="text-slate-500 mt-1">Edite a mensagem completa abaixo antes de enviar.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col items-end">
                        <button 
                          onClick={() => window.print()}
                          className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-6 py-4 rounded-2xl font-bold transition-all"
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
                          "px-10 py-4 rounded-2xl font-bold text-lg transition-all shadow-lg",
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
                    className="w-full h-96 bg-slate-50 p-6 rounded-2xl text-sm text-slate-700 font-mono border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  />
                </div>
              )}
              {analysis.every(s => s.faltantes.length === 0) && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-3xl p-10 text-center space-y-4 shadow-sm">
                  <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
                    <CheckCircle2 className="w-10 h-10" />
                  </div>
                  <h2 className="text-3xl font-black text-emerald-900">Sequência Totalmente Íntegra</h2>
                  <p className="text-emerald-700 font-medium max-w-xl mx-auto text-lg">
                    Parabéns! Todos os documentos fiscais foram identificados e a sequência numérica está completa para todas as séries analisadas.
                  </p>
                </div>
              )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Formal Audit Report - Visible only during printing */}
      {analysis && (
        <div className="hidden print:block p-0">
          <div className="print-header flex justify-between items-end">
            <div className="flex items-end gap-6">
              <img src="/logo-cf.png" alt="Contador de Padarias" style={{height: '52px', objectFit: 'contain'}} />
              <div>
                <div className="print-title" style={{color: '#020D2F'}}>Relatório de Auditoria de Sequência (Vendas/Saídas)</div>
                <div className="text-sm font-bold mt-1 uppercase tracking-widest" style={{color: '#888'}}>Documentos Emitidos pela Empresa</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-black border-2 px-3 py-1 uppercase text-sm" style={{color: '#020D2F', borderColor: '#020D2F'}}>Cópia de Auditoria</div>
            </div>
          </div>

          <div className="print-section">
            <h3 className="text-lg font-bold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Resumo da Integridade</h3>
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
            <h3 className="text-lg font-bold text-slate-800 mb-4 border-l-4 border-slate-900 pl-3">Detalhamento de Faltantes</h3>
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
              <div className="p-10 border-2 border-dashed border-slate-200 text-center rounded-2xl">
                <div className="font-bold text-slate-400">Nenhuma quebra de sequência identificada.</div>
              </div>
            )}
          </div>

          <div className="mt-20 border-t border-slate-100 pt-10 flex justify-between text-[10px] text-slate-400 font-bold uppercase tracking-widest">
            <div>Sequência Fiscal v2.0</div>
            <div>Página 1 de 1</div>
          </div>
        </div>
      )}

      <footer className="p-8 text-center no-print" style={{background: '#020D2F'}}>
        <img src="/simbolo.png" alt="Contador de Padarias" className="h-8 object-contain mx-auto opacity-70" />
      </footer>
    </div>
  );
}
