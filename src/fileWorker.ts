// Web Worker: descompacta ZIPs e faz o parse de XML/SPED fora da thread principal,
// pra lotes grandes não travarem a aba ("página não responde"). Só ZIP (JSZip) e
// XML/TXT entram aqui — RAR e tipo desconhecido são devolvidos como "pendingArchives"
// pra thread principal processar do jeito que já funciona hoje (libarchive.js precisa
// de document/window, que não existe num worker; node-unrar-js também fica de fora
// aqui de propósito, pra não duplicar o fallback chain que já existe).
//
// Toda a lógica de parseXML/parseSped/checkMagicBytes/isProvavelmenteNaoFiscal abaixo
// é uma cópia literal do que já existe em App.tsx — não mude uma sem mudar a outra.

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type { XmlData, SpedData, SourceMetadata } from './App';

// Worker global scope não tem o DOMParser nativo do navegador (confirmado ao
// testar neste ambiente) — @xmldom/xmldom é um parser puro-JS com a MESMA API
// (parseFromString/getElementsByTagName/textContent/getAttribute), então o
// parseXML/parseSped abaixo continuam usando exatamente as mesmas chamadas de
// sempre; só a instância que cria `doc` é diferente da usada em App.tsx.
const parser = new DOMParser();

const EXTENSOES_NAO_FISCAIS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff',
  '.mp4', '.mp3', '.avi', '.mov', '.wmv', '.exe', '.msi', '.dll',
]);
const TAMANHO_MINIMO_PARA_PULAR_POR_EXTENSAO = 512 * 1024;
function isProvavelmenteNaoFiscal(nomeArquivo: string, tamanhoBytes?: number): boolean {
  if (tamanhoBytes !== undefined && tamanhoBytes < TAMANHO_MINIMO_PARA_PULAR_POR_EXTENSAO) return false;
  const lower = nomeArquivo.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return EXTENSOES_NAO_FISCAIS.has(lower.slice(dot));
}

function checkMagicBytes(buffer: ArrayBuffer | Uint8Array): 'zip' | 'rar' | 'unknown' {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 6 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1A && bytes[5] === 0x07) return 'rar';
  return 'unknown';
}

function parseXML(xmlText: string, fileName: string): XmlData {
  const lowerText = xmlText.toLowerCase();

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
      nfseNumeroDPS: getTxt(doc, 'nDPS'),
      nfseNumeroDFSe: getTxt(doc, 'nDFSe'),
      chave: infNFSe?.getAttribute('Id') || '',
      modelo: 'NFS-e',
      rawXml: xmlText,
    };
  }

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

  const cStats = getAllTextContent('cStat');
  const xMotivos = getAllTextContent('xMotivo');
  const descEventos = getAllTextContent('descEvento');

  const hasCancelStat = cStats.some(stat => stat === '101' || stat === '135' || stat === '155');
  const hasCancelMotivo = xMotivos.some(motivo => motivo.toLowerCase().includes('cancel'));
  const hasCancelEvento = descEventos.some(desc => desc.toLowerCase().includes('cancel'));
  const hasCancelTag = doc.getElementsByTagName('retCancNFe').length > 0 || doc.getElementsByTagName('procCancNFe').length > 0;

  const isCancel = hasCancelStat || hasCancelMotivo || hasCancelEvento || hasCancelTag;

  const isEvento = doc.getElementsByTagName('procEventoNFe').length > 0 || doc.getElementsByTagName('eventoNFe').length > 0;
  if (isEvento) {
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

  const isNfe = doc.getElementsByTagName('infNFe').length > 0;
  if (isNfe) {
    const numero = getTextContent('nNF');
    const serie = getTextContent('serie');
    const modelo = getTextContent('mod');
    const tpEmis = getTextContent('tpEmis');
    const tpNF = getTextContent('tpNF');

    const emit = doc.getElementsByTagName('emit')[0];
    const dest = doc.getElementsByTagName('dest')[0];

    const emitCnpj = emit?.getElementsByTagName('CNPJ')[0]?.textContent || '';
    const emitNome = emit?.getElementsByTagName('xNome')[0]?.textContent || '';
    let destCnpj = dest?.getElementsByTagName('CNPJ')[0]?.textContent || '';
    let destNome = dest?.getElementsByTagName('xNome')[0]?.textContent || '';
    if (!destCnpj) {
      const m = xmlText.match(/<dest[\s>][\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
      if (m) destCnpj = m[1];
    }
    if (!destNome) {
      const m = xmlText.match(/<dest[\s>][\s\S]*?<xNome>([^<]+)<\/xNome>/);
      if (m) destNome = m[1];
    }

    const cfopValores: Record<string, number> = {};
    Array.from(doc.getElementsByTagName('det')).forEach(det => {
      const cfop = det.getElementsByTagName('CFOP')[0]?.textContent || '';
      const num = (tag: string) => parseFloat(det.getElementsByTagName(tag)[0]?.textContent || '0') || 0;
      const valorNetoItem = num('vProd') - num('vDesc') + num('vOutro') + num('vFrete') + num('vSeg');
      if (cfop) cfopValores[cfop] = (cfopValores[cfop] || 0) + valorNetoItem;
    });

    if (numero && serie && modelo) {
      return {
        tipo: 'nfe',
        cnpj: emitCnpj,
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

// Cópia literal de extrairAuditoria de App.tsx — não mude uma sem mudar a
// outra. Usa childNodes+nodeType (não .children) de propósito: o @xmldom/xmldom
// daqui não implementa .children, e o DOM nativo do App.tsx aceita os dois.
function extrairAuditoria(doc: any): any {
  const filhos = (el: any): any[] => el ? Array.from(el.childNodes).filter((n: any) => n.nodeType === 1) : [];
  const filho = (el: any, tag: string): any => filhos(el).find((e: any) => e.tagName === tag);
  const txt = (el: any): string => el?.textContent?.trim() ?? '';
  const num = (el: any): number | null => {
    const t = txt(el);
    if (!t) return null;
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  };
  const primeiro = (tag: string) => doc.getElementsByTagName(tag)[0];

  const emit = primeiro('emit');
  const ide = primeiro('ide');
  const infRespTec = primeiro('infRespTec');

  const parcela = (grupo: any, pTag: string, vTag: string) => {
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

  const dets = Array.from(doc.getElementsByTagName('det')).map((det: any) => {
    const prod = det.getElementsByTagName('prod')[0];
    const imposto = det.getElementsByTagName('imposto')[0];
    const icmsGroup = imposto?.getElementsByTagName('ICMS')[0];
    const icmsNode = icmsGroup ? filhos(icmsGroup)[0] : undefined;
    const ibscbs = imposto?.getElementsByTagName('IBSCBS')[0];
    const g = ibscbs ? filho(ibscbs, 'gIBSCBS') : undefined;
    return {
      cProd: txt(filho(prod, 'cProd')),
      xProd: txt(filho(prod, 'xProd')),
      ncm: txt(filho(prod, 'NCM')),
      cest: txt(filho(prod, 'CEST')),
      vProd: num(filho(prod, 'vProd')) ?? 0,
      icmsTemCst: !!icmsNode?.getElementsByTagName('CST')[0],
      icmsTemCsosn: !!icmsNode?.getElementsByTagName('CSOSN')[0],
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

  const detPags = Array.from(doc.getElementsByTagName('detPag')).map((detPag: any) => {
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

function parseSped(text: string, fileName: string): SpedData | null {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('|0000|')) return null;
  const h = lines[0].split('|');
  const dtIni = h[4] || '';
  const dtFin = h[5] || '';
  const razaoSocial = h[6] || '';
  const cnpj = h[7] || '';
  const c100: SpedData['c100'] = [];
  for (const line of lines) {
    if (!line.startsWith('|C100|')) continue;
    const f = line.split('|');
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

interface WorkerResults {
  localXmls: XmlData[];
  localInuts: XmlData[];
  localOthers: XmlData[];
  localNfse: XmlData[];
  localTotalCount: number;
  localCancellations: number;
  localValidNfCount: number;
  localInutsCount: number;
  localNonXmlCount: number;
  localSpeds: SpedData[];
}

export interface PendingArchive {
  data: ArrayBuffer;
  containerName: string;
  archivePath: string;
}

// Espelha exatamente o ramo ZIP de processArchiveRecursively em App.tsx — a única
// diferença é que RAR/tipo-desconhecido encontrado (no topo ou aninhado) não é
// processado aqui: vai pra pendingArchives, pra thread principal tratar do jeito
// que já funciona (libarchive.js + fallback node-unrar-js, sem mudar nada disso).
async function processZipRecursively(
  archiveData: ArrayBuffer | Uint8Array,
  results: WorkerResults,
  containerName: string,
  archivePath: string,
  sourceMap: Map<string, SourceMetadata>,
  processedNames: Set<string>,
  extractionErrors: string[],
  pendingArchives: PendingArchive[],
): Promise<void> {
  const type = checkMagicBytes(archiveData);
  const currentPath = archivePath ? `${archivePath}/${containerName}` : containerName;

  if (type !== 'zip') {
    const asArrayBuffer = archiveData instanceof Uint8Array
      ? archiveData.buffer.slice(archiveData.byteOffset, archiveData.byteOffset + archiveData.byteLength)
      : archiveData;
    pendingArchives.push({ data: asArrayBuffer as ArrayBuffer, containerName, archivePath });
    return;
  }

  const ensureSourceInMap = (name: string, isArchive: boolean) => {
    if (!sourceMap.has(name)) {
      sourceMap.set(name, { name, isZip: isArchive, totalXmls: 0, saidaCount: 0, entradaCount: 0 });
    }
  };

  try {
    const zip = await JSZip.loadAsync(archiveData);
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      const uniqueName = `${currentPath}::${name}`;
      const baseName = name.split('/').pop() || name;

      if (!name.toLowerCase().endsWith('.zip') && !name.toLowerCase().endsWith('.rar')) {
        if (processedNames.has(uniqueName)) continue;
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
              processedNames.add(uniqueName);
              const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0, -1).join('/')}` : containerName;
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
        const antesCount = results.localTotalCount;
        const antesPending = pendingArchives.length;
        await processZipRecursively(innerArchiveData, results, innerArchiveName, currentPath, sourceMap, processedNames, extractionErrors, pendingArchives);
        // Só reporta "não gerou nota" se não ficou pendente pra thread principal
        // processar depois — senão o aviso seria falso (a nota pode aparecer
        // quando o pendingArchive for resolvido).
        if (results.localTotalCount === antesCount && pendingArchives.length === antesPending) {
          extractionErrors.push(`${currentPath}/${innerArchiveName} — não gerou nenhuma nota fiscal (pode ter falhado ao extrair ou realmente estar vazio; confira manualmente)`);
        }
      }
    }
  } catch (e) {
    console.error('Erro ZIP (worker):', e);
    extractionErrors.push(`${currentPath} — falha ao ler ZIP: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface WorkerRequest {
  archiveData: ArrayBuffer;
  containerName: string;
}

export interface WorkerResponse {
  results: WorkerResults;
  sourceEntries: [string, SourceMetadata][];
  extractionErrors: string[];
  pendingArchives: PendingArchive[];
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { archiveData, containerName } = e.data;
  const results: WorkerResults = {
    localXmls: [], localInuts: [], localOthers: [], localNfse: [],
    localTotalCount: 0, localCancellations: 0, localValidNfCount: 0,
    localInutsCount: 0, localNonXmlCount: 0, localSpeds: [],
  };
  const sourceMap = new Map<string, SourceMetadata>();
  const processedNames = new Set<string>();
  const extractionErrors: string[] = [];
  const pendingArchives: PendingArchive[] = [];

  try {
    await processZipRecursively(archiveData, results, containerName, '', sourceMap, processedNames, extractionErrors, pendingArchives);
  } catch (err) {
    extractionErrors.push(`${containerName} — erro inesperado no worker: ${err instanceof Error ? err.message : String(err)}`);
  }

  const response: WorkerResponse = {
    results,
    sourceEntries: Array.from(sourceMap.entries()),
    extractionErrors,
    pendingArchives,
  };
  (self as any).postMessage(response);
};
