import sys

file_path = r'c:\Users\Contador de Padarias\Desktop\Antigravity\SEQUENCIA FISCAL\src\App.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Line 488 (0-indexed 487) is the suspected extra brace
print(f"Line 487: {lines[486].strip()}")
print(f"Line 488: {lines[487].strip()}")
print(f"Line 489: {lines[488].strip()}")
print(f"Line 490: {lines[489].strip()}")

# Remove the brace at line 488 (index 487)
del lines[487]

with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("Removed extra brace!")
