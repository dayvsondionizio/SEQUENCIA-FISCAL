import sys

file_path = r'c:\Users\Contador de Padarias\Desktop\Antigravity\SEQUENCIA FISCAL\src\App.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Search for the specific block by looking for keywords in nearby lines
start_line = -1
end_line = -1

for i, line in enumerate(lines):
    if 'if (innerArchiveName.endsWith' in line and 'const innerArchiveName = name.split' in lines[i-1]:
        start_line = i - 1
        # Look for the catch block
        for j in range(i, i + 20):
            if '} catch (e) {' in lines[j] and 'if (type === \'zip\') return;' in lines[j-1]:
                end_line = j
                break
        if start_line != -1 and end_line != -1:
            break

if start_line != -1 and end_line != -1:
    print(f"Found block from {start_line+1} to {end_line+1}")
    new_block = [
        '            } else {\n',
        '              const innerArchiveName = name.split(/[/\\]/).pop() || name;\n',
        '              if (innerArchiveName.endsWith(\'.zip\') || innerArchiveName.endsWith(\'.rar\')) {\n',
        '                const innerArchiveData = await entry.async(\'uint8array\');\n',
        '                await processArchiveRecursively(innerArchiveData, results, innerArchiveName, currentPath);\n',
        '              }\n',
        '            }\n',
        '          }\n',
        '          if (type === \'zip\') return;\n',
        '        } catch (e) {\n'
    ]
    lines[start_line:end_line+1] = new_block
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("Patch applied successfully!")
else:
    print("Could not find block to patch")
    sys.exit(1)
