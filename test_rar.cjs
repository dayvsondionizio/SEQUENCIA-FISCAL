const JSZip = require('jszip');
const fs = require('fs');
const unrar = require('unrar-js');

async function test() {
    console.log('Starting RAR test with unrarSync...');
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
        // unrarSync expects a Buffer
        const extracted = unrar.unrarSync(Buffer.from(rarData));
        console.log('Extracted files count:', extracted.length);
        
        let xmlCount = 0;
        for (const file of extracted) {
            console.log(`- ${file.name} (${file.data.length} bytes)`);
            if (file.name.toLowerCase().endsWith('.xml')) xmlCount++;
        }
        console.log(`Total XMLs in RAR: ${xmlCount}`);
    } catch (e) {
        console.error('RAR Extraction Error:', e);
    }
}

test().catch(console.error);
