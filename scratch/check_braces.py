import sys

file_path = r'c:\Users\Contador de Padarias\Desktop\Antigravity\SEQUENCIA FISCAL\src\App.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

stack = []
mismatches = []

for i, char in enumerate(content):
    if char == '{':
        stack.append(i)
    elif char == '}':
        if not stack:
            mismatches.append(('extra }', i))
        else:
            stack.pop()

if stack:
    for pos in stack:
        mismatches.append(('unclosed {', pos))

if not mismatches:
    print("No brace mismatches found!")
else:
    for type, pos in mismatches:
        # Get line number
        line_num = content[:pos].count('\n') + 1
        snippet = content[max(0, pos-20):min(len(content), pos+20)].replace('\n', '\\n')
        print(f"Mismatch: {type} at line {line_num} near '{snippet}'")
