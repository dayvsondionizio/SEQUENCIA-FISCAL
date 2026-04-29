const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createExtractorFromData } = require('node-unrar-js');

async function diagnose() {
    const zipPath = path.join('teste para vasculhar', 'Envio de Arquivos Fiscais - Entrada e Saida - CP R - Documentos Solicitados (9).zip');
    console.log('--- Diagnóstico de Arquivo v4 ---');
    
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);
    const rarEntryName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.rar'));
    const rarData = await zip.files[rarEntryName].async('nodebuffer');
    
    try {
        const extractor = await createExtractorFromData({ data: rarData });
        const list = extractor.getFileList();
        
        // Iterar manualmente sobre o gerador
        let count = 0;
        for (const header of list.fileHeaders) {
            count++;
            if (count < 5) console.log('Found:', header.name);
        }
        console.log('Total files via loop:', count);
        
        console.log('Tentando extrair com filtro...');
        const extracted = extractor.extract({ files: (h) => true });
        console.log('Sucesso! Extraídos:', extracted.files.length);
    } catch (err) {
        console.error('ERRO:', err);
    }
}

diagnose().catch(console.error);
