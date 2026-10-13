// O JSZip guarda UMA entrada por nome: se o ZIP traz dois arquivos com o mesmo caminho (caso real de cliente: dois
// "AUTORIZADAS.zip" e dois "CANCELADAS.zip" no mesmo pacote), só a última é lida e a outra SOME sem aviso — faltaram
// 9 dias de notas. Este módulo percorre o diretório central do ZIP e devolve TODAS as ocorrências dos nomes repetidos,
// pra o leitor processar cada uma. ZIP64, criptografia e métodos diferentes de "stored"/"deflate" ficam de fora (nesses
// casos o nome continua sendo lido pelo JSZip, como antes).

export interface OcorrenciaZip {
  tamanho: number;                       // tamanho descompactado (do diretório central)
  bytes: () => Promise<Uint8Array>;      // conteúdo descompactado
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

async function inflarRaw(dados: Uint8Array): Promise<Uint8Array> {
  const fluxo = new Blob([dados as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

function listarNomesRepetidosInterno(
  zip: Uint8Array,
  nomesLidosPeloJszip: Record<string, unknown>,
): Map<string, OcorrenciaZip[]> {
  const resultado = new Map<string, OcorrenciaZip[]>();
  if (zip.length < 22) return resultado;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // fim do diretório central (EOCD): assinatura 0x06054b50, até 64 KB de comentário depois dele
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return resultado;
  const total = u16(view, eocd + 10);
  const cdOffset = u32(view, eocd + 16);
  if (total === 0xFFFF || cdOffset === 0xFFFFFFFF) return resultado; // ZIP64: deixa com o JSZip

  type Entrada = { name: string; flags: number; metodo: number; comp: number; desc: number; offsetLocal: number };
  const decodificador = new TextDecoder('utf-8');
  const entradas: Entrada[] = [];
  let p = cdOffset;
  for (let n = 0; n < total && p + 46 <= zip.length; n++) {
    if (u32(view, p) !== 0x02014b50) break;
    const nomeLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const comentLen = u16(view, p + 32);
    entradas.push({
      name: decodificador.decode(zip.subarray(p + 46, p + 46 + nomeLen)),
      flags: u16(view, p + 8),
      metodo: u16(view, p + 10),
      comp: u32(view, p + 20),
      desc: u32(view, p + 24),
      offsetLocal: u32(view, p + 42),
    });
    p += 46 + nomeLen + extraLen + comentLen;
  }

  const porNome = new Map<string, Entrada[]>();
  entradas.forEach(e => {
    if (e.name.endsWith('/')) return; // pasta
    const lista = porNome.get(e.name);
    if (lista) lista.push(e); else porNome.set(e.name, [e]);
  });

  porNome.forEach((lista, name) => {
    if (lista.length < 2) return;
    // só assume o nome se o JSZip enxergou exatamente esse nome (evita ler duas vezes por diferença de codificação)
    if (!(name in nomesLidosPeloJszip)) return;
    const tratavel = lista.every(e => (e.flags & 1) === 0 && (e.metodo === 0 || e.metodo === 8) && e.comp !== 0xFFFFFFFF && e.desc !== 0xFFFFFFFF && e.offsetLocal !== 0xFFFFFFFF);
    if (!tratavel) return;
    resultado.set(name, lista.map(e => ({
      tamanho: e.desc,
      bytes: async () => {
        const o = e.offsetLocal;
        if (u32(view, o) !== 0x04034b50) throw new Error('cabeçalho local inválido');
        const inicio = o + 30 + u16(view, o + 26) + u16(view, o + 28);
        const comprimido = zip.subarray(inicio, inicio + e.comp);
        return e.metodo === 0 ? comprimido : inflarRaw(comprimido);
      },
    })));
  });
  return resultado;
}

// Qualquer falha aqui NUNCA pode derrubar a leitura de um ZIP que antes abria normalmente: se algo der errado
// (estrutura incomum, bytes truncados), devolve vazio e o leitor segue só com o JSZip, como sempre foi.
export function listarNomesRepetidos(
  zip: Uint8Array,
  nomesLidosPeloJszip: Record<string, unknown>,
): Map<string, OcorrenciaZip[]> {
  try {
    return listarNomesRepetidosInterno(zip, nomesLidosPeloJszip);
  } catch {
    return new Map();
  }
}

// Adapta uma ocorrência ao formato mínimo que o leitor usa das entradas do JSZip (dir, _data e async).
export function entradaVirtual(o: OcorrenciaZip) {
  return {
    dir: false,
    _data: { uncompressedSize: o.tamanho },
    async: async (tipo: 'text' | 'uint8array') => {
      const dados = await o.bytes();
      return tipo === 'text' ? new TextDecoder('utf-8').decode(dados) : dados;
    },
  };
}
