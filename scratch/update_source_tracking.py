import sys
import re

file_path = r'c:\Users\Contador de Padarias\Desktop\Antigravity\SEQUENCIA FISCAL\src\App.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Update the processArchiveRecursively function to ensure ALL sources are added to sourceMap
new_function = r"""
    const processArchiveRecursively = async (archiveData: ArrayBuffer | Uint8Array, results: any, containerName: string, archivePath: string = '') => {
      const type = checkMagicBytes(archiveData);
      const currentPath = archivePath ? `${archivePath}/${containerName}` : containerName;
      
      if (type === 'rar') setExtractionStatus(`Extraindo RAR5: ${containerName}...`);

      const ensureSourceInMap = (name: string, isArchive: boolean) => {
        if (!sourceMap.has(name)) {
          sourceMap.set(name, {
            name: name,
            isZip: isArchive,
            totalXmls: 0,
            saidaCount: 0,
            entradaCount: 0
          });
        }
      };

      if (type === 'zip') {
        try {
          const zip = await JSZip.loadAsync(archiveData);
          for (const name of Object.keys(zip.files)) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            const uniqueName = `${currentPath}::${name}`;
            const baseName = name.split('/').pop() || name;
            
            if (!name.toLowerCase().endsWith('.zip') && !name.toLowerCase().endsWith('.rar')) {
              if (updatedProcessedNames.has(uniqueName)) continue;
              try {
                const xmlText = await entry.async('text');
                const looksLikeXml = xmlText.trim().startsWith('<');
                if (looksLikeXml || /^[0-9]{44}$/.test(baseName) || name.toLowerCase().endsWith('.xml')) {
                  const data = parseXML(xmlText, name);
                  if (data.tipo !== 'outro') {
                    updatedProcessedNames.add(uniqueName);
                    // Ensure the ZIP or the specific folder inside it is in the source map
                    const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                    ensureSourceInMap(displaySource, true);
                    
                    results.localTotalCount++;
                    data.sourceName = displaySource;
                    if (data.isCancelamento) results.localCancellations++;
                    if (data.tipo === 'inutilizacao') {
                      results.localInuts.push(data); results.localInutsCount++;
                    } else if (data.tipo === 'nfe') {
                      results.localXmls.push(data); results.localValidNfCount++;
                    } else {
                      results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                    }
                  } else { results.localNonXmlCount++; }
                } else { results.localNonXmlCount++; }
              } catch (e) { results.localNonXmlCount++; }
            } else {
              const innerArchiveName = baseName;
              const innerArchiveData = await entry.async('uint8array');
              await processArchiveRecursively(innerArchiveData, results, innerArchiveName, currentPath);
            }
          }
          return;
        } catch (e) { console.error('Erro ZIP:', e); return; }
      }

      if (type === 'rar' || type === 'unknown') {
        try {
          if (typeof (window as any).Archive === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/libarchive.js/dist/libarchive.js';
            document.head.appendChild(script);
            await new Promise(r => script.onload = r);
            (window as any).Archive.init({ workerUrl: 'https://unpkg.com/libarchive.js/dist/worker-bundle.js' });
          }
          const uint8 = archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);
          const archive = await Promise.race([
            (window as any).Archive.open(new Blob([uint8])),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
          ]) as any;
          const entries = await archive.getEntries();
          for (const entry of entries) {
            const name = entry.getPath();
            if (entry.isFolder()) continue;
            const fileData = await entry.extract();
            const baseName = name.split('/').pop() || name;
            
            if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
              await processArchiveRecursively(new Uint8Array(await fileData.arrayBuffer()), results, baseName, currentPath);
            } else {
              const xmlText = await fileData.text();
              const looksLikeXml = xmlText.trim().startsWith('<');
              if (looksLikeXml || /^[0-9]{44}$/.test(baseName) || name.toLowerCase().endsWith('.xml')) {
                const data = parseXML(xmlText, name);
                if (data.tipo !== 'outro') {
                  const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                  ensureSourceInMap(displaySource, true);
                  
                  results.localTotalCount++;
                  data.sourceName = displaySource;
                  if (data.isCancelamento) results.localCancellations++;
                  if (data.tipo === 'inutilizacao') {
                    results.localInuts.push(data); results.localInutsCount++;
                  } else if (data.tipo === 'nfe') {
                    results.localXmls.push(data); results.localValidNfCount++;
                  } else {
                    results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                  }
                } else { results.localNonXmlCount++; }
              } else { results.localNonXmlCount++; }
            }
          }
          setExtractionStatus(null);
          return;
        } catch (libErr) { console.warn('LibArchive falhou, tentando node-unrar-js...', libErr); }

        try {
          const uint8 = archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);
          const cleanBuffer = new ArrayBuffer(uint8.length + 1024*1024);
          new Uint8Array(cleanBuffer).set(uint8);
          let currentWasm = wasmBinary || await loadWasm();
          if (currentWasm) {
            const extractor = await createExtractorFromData({ data: new Uint8Array(cleanBuffer), wasmBinary: currentWasm });
            const extracted = extractor.extract();
            for (const file of extracted.files) {
              if (!file.extraction || file.extraction.length === 0) continue;
              const name = file.fileHeader.name;
              const baseName = name.split('/').pop() || name;
              if (name.toLowerCase().endsWith('.zip') || name.toLowerCase().endsWith('.rar')) {
                await processArchiveRecursively(file.extraction, results, baseName, currentPath);
              } else {
                const xmlText = new TextDecoder().decode(file.extraction);
                if (xmlText.trim().startsWith('<') || name.toLowerCase().endsWith('.xml')) {
                  const data = parseXML(xmlText, name);
                  if (data.tipo !== 'outro') {
                    const displaySource = name.includes('/') ? `${containerName}/${name.split('/').slice(0,-1).join('/')}` : containerName;
                    ensureSourceInMap(displaySource, true);
                    
                    results.localTotalCount++; data.sourceName = displaySource;
                    if (data.isCancelamento) results.localCancellations++;
                    if (data.tipo === 'inutilizacao') {
                      results.localInuts.push(data); results.localInutsCount++;
                    } else if (data.tipo === 'nfe') {
                      results.localXmls.push(data); results.localValidNfCount++;
                    } else {
                      results.localOthers.push({ fileName: name, subTipo: data.subTipo, tipo: data.tipo } as any);
                    }
                  } else { results.localNonXmlCount++; }
                } else { results.localNonXmlCount++; }
              }
            }
          }
        } catch (rarErr) { console.error('Erro RAR final:', rarErr); }
        setExtractionStatus(null);
      }
    };
"""

# Regex to find the entire processArchiveRecursively function
pattern = re.compile(r'const processArchiveRecursively = async.*?setProcessingProgress', re.DOTALL)
new_content = pattern.sub(new_function + "\n    setProcessingProgress", content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(new_content)
print("Function updated to track nested folders as sources!")
