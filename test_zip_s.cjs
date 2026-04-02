const JSZip = require('jszip');
const fs = require('fs');
// Since I uninstalled node-unrar-js in my previous turn, I'll need to check if I should use it or unrar-js.
// Wait, I installed node-unrar-js in turn 27.
const { createExtractorFromData } = require('node-unrar-js');

async function test() {
    const zipName = 'Envio de Arquivos Fiscais - Entrada e Saida - CP S - Documentos Solicitados.zip';
    const zipPath = 'c:/Users/Contador de Padarias/Desktop/Antigravity/SEQUENCIA FISCAL/' + zipName;
    if (!fs.existsSync(zipPath)) {
        console.error('File not found:', zipPath);
        return;
    }
    console.log('Testing ZIP:', zipName);
    const data = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(data);
    
    let xmlCount = 0;
    let rarCount = 0;
    let zipCount = 0;

    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const nameLower = name.toLowerCase();
        if (nameLower.endsWith('.xml')) xmlCount++;
        else if (nameLower.endsWith('.rar')) {
            rarCount++;
            console.log('Found nested RAR:', name);
        }
        else if (nameLower.endsWith('.zip')) {
            zipCount++;
            console.log('Found nested ZIP:', name);
        }
    }
    console.log(`ZIP Report: XMLs: ${xmlCount}, RARs: ${rarCount}, ZIPs: ${zipCount}`);
}

test().catch(console.error);
