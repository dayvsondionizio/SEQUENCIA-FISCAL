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
  Download
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

function getMonthYear(dateStr?: string) {
  if (!dateStr || dateStr.length < 7) return '';
  const parts = dateStr.split('-');
  if (parts.length < 2) return '';
  const year = parts[0];
  const month = parts[1];
  const months = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const mIdx = parseInt(month) - 1;
  if (mIdx >= 0 && mIdx < 12) {
    return `${months[mIdx]}/${year}`;
  }
  return '';
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
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
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
  }, [filterMes]);

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
      inutSerie.forEach(inut => {
        for (let i = inut.nNFIni!; i <= inut.nNFFin!; i++) {
          numerosInutilizadosSet.add(i);
        }
      });

      const faltantesReais = faltantes.filter(num => !numerosInutilizadosSet.has(num));
      const faltantesInutilizados = faltantes.filter(num => numerosInutilizadosSet.has(num));

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
    setShowDaysDetail(false);
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
    <div className="min-h-screen font-sans text-slate-900 relative" style={{background: '#f0f4f8'}}>
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
      <header className="text-white shadow-2xl" style={{background: 'linear-gradient(135deg, #0f1340 0%, #1a1e6b 60%, #0f1340 100%)'}}>
        {/* Top brand bar */}
        <div className="border-b" style={{borderColor: 'rgba(240,180,41,0.2)'}}>
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
            <img src="/logo-sf.png" alt="Contador de Padarias" className="h-10 object-contain" />
            <div className="text-xs font-bold uppercase tracking-widest" style={{color: 'rgba(240,180,41,0.7)'}}>Sistema de Auditoria Fiscal</div>
          </div>
        </div>

        {/* Main header content */}
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex items-center gap-5">
            <div className="p-3 rounded-2xl shadow-xl" style={{background: 'rgba(240,180,41,0.15)', border: '1px solid rgba(240,180,41,0.3)'}}>
              <img src="/simbolo.png" alt="" className="w-10 h-10 object-contain" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white mb-0.5">Sequência Fiscal</h1>
              <p className="font-medium" style={{color: 'rgba(240,180,41,0.8)', fontSize: '0.95rem'}}>Auditoria de Sequência de Vendas e Saídas</p>
            </div>
          </div>

          {analysis && analysis.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="backdrop-blur-md rounded-2xl p-4 flex flex-col gap-1 min-w-[320px] shadow-2xl"
              style={{background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(240,180,41,0.2)'}}
            >
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] mb-1" style={{color: '#F0B429'}}>
                <span className="w-2 h-2 rounded-full animate-pulse" style={{background: '#F0B429', boxShadow: '0 0 8px rgba(240,180,41,0.6)'}} />
                Dados Identificados
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <span className="font-bold uppercase text-[10px] self-center" style={{color: 'rgba(255,255,255,0.4)'}}>Empresa:</span>
                <span className="text-white font-bold truncate max-w-[280px]">{analysis[0].razaoSocial}</span>
                
                <span className="font-bold uppercase text-[10px] self-center" style={{color: 'rgba(255,255,255,0.4)'}}>CNPJ:</span>
                <span className="font-mono text-xs" style={{color: 'rgba(255,255,255,0.7)'}}>{analysis[0].cnpj}</span>
                
                <span className="font-bold uppercase text-[10px] self-center" style={{color: 'rgba(255,255,255,0.4)'}}>IE:</span>
                <span className="font-mono text-xs" style={{color: 'rgba(255,255,255,0.7)'}}>{analysis[0].ie}</span>
                
                <span className="font-bold uppercase text-[10px] self-center" style={{color: 'rgba(255,255,255,0.4)'}}>Meses:</span>
                <span className="font-bold text-sm leading-none" style={{color: '#F0B429'}}>{mesesDisponiveis.join(', ') || 'N/A'}</span>
              </div>
            </motion.div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 lg:p-8 no-print">
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
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-1">Faturamento Estimado</div>
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
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Fontes Anexadas</div>
                      <div className="flex flex-wrap gap-2">
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
                      style={{background: 'linear-gradient(135deg, #1a1e6b, #2a2fa0)', boxShadow: '0 8px 32px rgba(26,30,107,0.4)'}}
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
                      style={{background: 'linear-gradient(135deg, #0f1340, #1a1e6b)'}}
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
              className="space-y-8"
            >
              {/* Dashboard Stats */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm md:col-span-2">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Faturamento Auditado (Saídas Válidas)</div>
                  <div className="text-4xl font-black text-emerald-600 mt-2">
                    {formatarMoeda(faturamentoTotal)}
                  </div>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm transition-all">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Período Analisado</div>
                  <div className="text-xl font-black text-slate-900 mt-2">
                    {periodoAnalise.inicio ? `${periodoAnalise.inicio} a ${periodoAnalise.fim}` : 'N/A'}
                  </div>
                  <div className="flex flex-col gap-1 mt-1">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
                      <span>{periodoAnalise.totalDias} dias com movimentação</span>
                      {periodoAnalise.diasDetalhados && periodoAnalise.diasDetalhados.length > 0 && (
                        <button 
                          onClick={() => setShowDaysDetail(!showDaysDetail)}
                          className="text-blue-600 hover:text-blue-700 underline font-bold cursor-pointer transition-all"
                        >
                          {showDaysDetail ? 'Ocultar' : 'Ver detalhes'}
                        </button>
                      )}
                    </div>
                    {showDaysDetail && periodoAnalise.diasDetalhados && (
                      <div className="mt-2 text-[11px] text-slate-600 max-h-24 overflow-y-auto bg-slate-50 p-2 rounded-xl border border-slate-100 font-mono leading-relaxed">
                        {periodoAnalise.diasDetalhados.join(', ')}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Total Faltantes</div>
                  <div className="text-4xl font-black text-rose-600 mt-2">
                    {analysis.reduce((acc, s) => acc + s.faltantes.length, 0)}
                  </div>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Total Recebidos</div>
                  <div className="text-4xl font-black text-blue-600 mt-2">
                    {analysis.reduce((acc, s) => acc + s.recebidos, 0)}
                  </div>
                </div>
              </div>

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
                      style={{background: 'linear-gradient(135deg, #1a1e6b, #2a2fa0)'}}
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
                          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-emerald-800 text-sm">
                            <div className="font-bold flex items-center gap-2 mb-1">
                              <Check className="w-4 h-4" />
                              Inutilizações Identificadas ({serie.faltantesInutilizados.length})
                            </div>
                            Números: {formatarFaixas(agruparFaixas(serie.faltantesInutilizados))}
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
                <div className="print-title" style={{color: '#0f1340'}}>Relatório de Auditoria de Sequência (Vendas/Saídas)</div>
                <div className="text-sm font-bold mt-1 uppercase tracking-widest" style={{color: '#888'}}>Documentos Emitidos pela Empresa</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-black border-2 px-3 py-1 uppercase text-sm" style={{color: '#0f1340', borderColor: '#0f1340'}}>Cópia de Auditoria</div>
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

      <footer className="p-8 text-center text-sm font-medium no-print" style={{background: '#0f1340'}}>
        <img src="/logo-sf.png" alt="Contador de Padarias" className="h-8 object-contain mx-auto mb-3 opacity-70" />
        <p style={{color: 'rgba(255,255,255,0.35)'}}>Sequência Fiscal • v2.0 • Contador de Padarias</p>
      </footer>
    </div>
  );
}
