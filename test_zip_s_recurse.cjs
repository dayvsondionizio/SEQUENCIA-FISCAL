const JSZip = require('jszip');
const fs = require('fs');

async function processArchiveRecursively(archiveData, results, containerName) {
    console.log(`Processing: ${containerName}`);
    try {
        const zip = await JSZip.loadAsync(archiveData);
        for (const [name, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            const nameLower = name.toLowerCase();
            if (nameLower.endsWith('.xml')) {
                results.xmlCount++;
            } else if (nameLower.endsWith('.zip') || nameLower.endsWith('.rar')) {
                const innerData = await entry.async('arraybuffer');
                await processArchiveRecursively(innerData, results, name);
            }
        }
    } catch (e) {
        console.log(`Not a ZIP: ${containerName} - skipping`);
    }
}

async function test() {
    const zipName = 'Envio de Arquivos Fiscais - Entrada e Saida - CP S - Documentos Solicitados.zip';
    const zipPath = 'c:/Users/Contador de Padarias/Desktop/Antigravity/SEQUENCIA FISCAL/' + zipName;
    const data = fs.readFileSync(zipPath);
    const results = { xmlCount: 0 };
    await processArchiveRecursively(data, results, zipName);
    console.log(`Total XMLs found recursively: ${results.xmlCount}`);
}

test().catch(console.error);
