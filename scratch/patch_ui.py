import sys

file_path = r'c:\Users\Contador de Padarias\Desktop\Antigravity\SEQUENCIA FISCAL\src\App.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 1. Update the processArchiveRecursively function blocks
found_func = False
for i, line in enumerate(lines):
    if 'const processArchiveRecursively = async' in line:
        # Add setExtractionStatus call
        if 'setExtractionStatus' not in lines[i+4]:
             lines.insert(i+4, "      if (type === 'rar') setExtractionStatus(`Extraindo RAR5: ${containerName}...`);\n")
        found_func = True
        break

# 2. Update the Archive.init and extractor logic
for i, line in enumerate(lines):
    if 'Archive.init({ workerUrl:' in line:
        lines[i] = "            Archive.init({ workerUrl: 'https://unpkg.com/libarchive.js/dist/worker-bundle.js' });\n"
    if 'setExtractionStatus(null)' not in line and 'return; // Sucesso com LibArchive' in line:
        lines.insert(i, "            setExtractionStatus(null);\n")

# 3. Add UI status element
for i, line in enumerate(lines):
    if '<p className="text-slate-400 text-sm mt-4">' in line:
        ui_block = [
            '            {extractionStatus && (\n',
            '              <div className="mt-4 flex items-center gap-3 text-emerald-600 bg-emerald-50 px-4 py-2 rounded-full border border-emerald-100 animate-pulse">\n',
            '                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce"></div>\n',
            '                <span className="text-xs font-bold uppercase tracking-wider">{extractionStatus}</span>\n',
            '              </div>\n',
            '            )}\n'
        ]
        lines[i:i] = ui_block
        break

with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("Patch applied!")
