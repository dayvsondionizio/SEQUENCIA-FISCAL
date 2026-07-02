import { gerarPDF } from 'nfe-danfe-pdf';

// nfe-danfe-pdf only accepts the fully processed <nfeProc> envelope
// (NFe + protNFe) — it reads protNFe.infProt.chNFe/nProt/dhRecbto directly
// with no fallback. Many imported XMLs are the bare, unprocessed <NFe> (no
// protocolo attached), so we wrap those on the fly using data the app
// already parsed from the note, instead of rejecting them.
function toNfeProc(xml: string, chave?: string, protocolo?: string, dataEmissao?: string): string {
  if (/<nfeProc[\s>]/.test(xml)) return xml;

  const conteudo = xml.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();
  const chaveResolvida = chave || (conteudo.match(/Id="NFe(\d{44})"/)?.[1] ?? '0'.repeat(44));

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
${conteudo}
<protNFe versao="4.00">
  <infProt>
    <tpAmb>1</tpAmb>
    <verAplic>SequenciaFiscal</verAplic>
    <chNFe>${chaveResolvida}</chNFe>
    <dhRecbto>${dataEmissao || ''}</dhRecbto>
    <nProt>${protocolo || ''}</nProt>
    <cStat>100</cStat>
    <xMotivo>Autorizado o uso da NF-e</xMotivo>
  </infProt>
</protNFe>
</nfeProc>`;
}

// Vercel Node.js serverless function: receives a note's XML and streams back
// the rendered DANFE PDF. Stateless — nothing is persisted.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { xml, cancelada, chave, protocolo, dataEmissao } = req.body || {};
  if (!xml || typeof xml !== 'string') {
    res.status(400).json({ error: 'XML da nota não informado' });
    return;
  }

  try {
    const xmlProcessado = toNfeProc(xml, chave, protocolo, dataEmissao);
    const pdfDoc = await gerarPDF(xmlProcessado, { cancelada: !!cancelada });

    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="danfe.pdf"');
      res.status(200).send(buffer);
    });
    pdfDoc.on('error', (err: Error) => {
      console.error('Erro ao gerar DANFE:', err);
      res.status(500).json({ error: 'Falha ao gerar o PDF do DANFE' });
    });
    // gerarPDF already finalizes (.end()) the document internally before
    // returning it — calling .end() again here would push after EOF.
  } catch (err) {
    console.error('Erro ao gerar DANFE:', err);
    res.status(500).json({ error: 'Falha ao gerar o PDF do DANFE. Verifique se o XML é uma NF-e válida.' });
  }
}
