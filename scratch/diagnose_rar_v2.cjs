const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createExtractorFromData } = require('node-unrar-js');

async function diagnose() {
    const zipPath = path.join('teste para vasculhar', 'Envio de Arquivos Fiscais - Entrada e Saida - CP R - Documentos Solicitados (9).zip');
    console.log('--- Diagnóstico de Arquivo ---');
    console.log('Lendo ZIP:', zipPath);
    
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);
    
    const entries = Object.keys(zip.files);
    console.log('Arquivos no ZIP:', entries.length);
    
    const rarEntryName = entries.find(n => n.toLowerCase().endsWith('.rar'));
    if (!rarEntryName) {
        console.error('Nenhum arquivo RAR encontrado dentro do ZIP!');
        return;
    }
    
    console.log('RAR encontrado:', rarEntryName);
    const rarData = await zip.files[rarEntryName].async('nodebuffer');
    console.log('Tamanho do RAR:', rarData.length, 'bytes');
    console.log('DNA (10 bytes):', rarData.slice(0, 10).toString('hex'));
    
    try {
        console.log('Tentando abrir RAR com node-unrar-js...');
        // Em Node.js, não precisamos passar wasmBinary se a lib conseguir achar o .wasm no disco,
        // mas aqui vamos ver o que acontece.
        const extractor = await createExtractorFromData({ data: rarData });
        const list = extractor.getFileList();
        console.log('Lista de arquivos no RAR obtida com sucesso!');
        console.log('Total de arquivos no RAR:', list.fileHeaders.length);
        
        const extracted = extractor.extract();
        console.log('Extração concluída com sucesso!');
        let xmlCount = 0;
        for (const file of extracted.files) {
            const name = file.fileHeader.name;
            if (name.toLowerCase().endsWith('.xml')) xmlCount++;
            // console.log(' -', name, file.extraction.length, 'bytes');
        }
        console.log('Total de XMLs encontrados:', xmlCount);
        
    } catch (err) {
        console.error('ERRO NA EXTRAÇÃO RAR:', err);
    }
}

diagnose().catch(console.error);
