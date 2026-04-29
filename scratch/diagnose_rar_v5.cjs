const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createExtractorFromData } = require('node-unrar-js');

async function diagnose() {
    const zipPath = path.join('teste para vasculhar', 'Envio de Arquivos Fiscais - Entrada e Saida - CP R - Documentos Solicitados (9).zip');
    console.log('--- Diagnóstico de Arquivo v5 ---');
    
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);
    const rarEntryName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.rar'));
    const rarData = await zip.files[rarEntryName].async('uint8array');
    
    console.log('Type of rarData:', rarData.constructor.name); // Uint8Array
    
    try {
        console.log('Testando com .buffer...');
        try {
            const ext1 = await createExtractorFromData({ data: rarData.buffer });
            const list1 = ext1.getFileList();
            for (const h of list1.fileHeaders) { /* just iterate */ }
            console.log(' .buffer OK');
        } catch (e) {
            console.log(' .buffer FAILED:', e.message);
        }

        console.log('Testando com Uint8Array diretamente...');
        try {
            const ext2 = await createExtractorFromData({ data: rarData });
            const list2 = ext2.getFileList();
            for (const h of list2.fileHeaders) { /* just iterate */ }
            console.log(' Uint8Array OK');
        } catch (e) {
            console.log(' Uint8Array FAILED:', e.message);
        }
        
    } catch (err) {
        console.error('ERRO FATAL:', err);
    }
}

diagnose().catch(console.error);
