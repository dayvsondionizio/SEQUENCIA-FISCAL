const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createExtractorFromData } = require('node-unrar-js');

async function diagnose() {
    const zipPath = path.join('teste para vasculhar', 'Envio de Arquivos Fiscais - Entrada e Saida - CP R - Documentos Solicitados (9).zip');
    console.log('--- Diagnóstico de Arquivo v3 ---');
    
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);
    const rarEntryName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.rar'));
    
    console.log('RAR encontrado:', rarEntryName);
    const rarData = await zip.files[rarEntryName].async('uint8array');
    
    try {
        const extractor = await createExtractorFromData({ data: rarData.buffer });
        const list = extractor.getFileList();
        
        console.log('ArcHeader:', list.arcHeader);
        console.log('FileHeaders count:', list.fileHeaders.length);
        
        for (let i = 0; i < Math.min(5, list.fileHeaders.length); i++) {
            console.log(` - File ${i}:`, list.fileHeaders[i].name);
        }
        
        console.log('Tentando extrair...');
        const extracted = extractor.extract();
        console.log('Extração OK! Arquivos extraídos:', extracted.files.length);
        
    } catch (err) {
        console.error('ERRO:', err);
    }
}

diagnose().catch(console.error);
