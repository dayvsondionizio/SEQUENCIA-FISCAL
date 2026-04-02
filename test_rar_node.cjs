const JSZip = require('jszip');
const fs = require('fs');
const { createExtractorFromData } = require('node-unrar-js');

async function test() {
    console.log('Starting RAR test with node-unrar-js...');
    const data = fs.readFileSync('Envio de Arquivos Fiscais - Entrada e Saida - CP R - Documentos Solicitados.zip');
    const zip = await JSZip.loadAsync(data);
    
    // Find the rar file
    const rarEntry = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.rar'));
    if (!rarEntry) {
        console.error('No RAR file found in ZIP!');
        return;
    }
    
    const rarData = await zip.file(rarEntry).async('arraybuffer');
    console.log(`RAR found: ${rarEntry} (${rarData.byteLength} bytes)`);
    
    try {
        const extractor = await createExtractorFromData({ data: rarData });
        const list = extractor.getFileList();
        console.log('RAR File List count:', [...list.fileHeaders].length);
        
        // Extract everything
        const extracted = extractor.extract(); 
        const files = [...extracted.files];
        console.log('Extracted files count:', files.length);
        
        let xmlCount = 0;
        for (const file of files) {
            if (file.fileHeader.name.toLowerCase().endsWith('.xml')) xmlCount++;
        }
        console.log(`Total XMLs in RAR: ${xmlCount}`);
    } catch (e) {
        console.error('RAR Extraction Error:', e);
    }
}

test().catch(console.error);
