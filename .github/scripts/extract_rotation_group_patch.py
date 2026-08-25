from pathlib import Path

source = Path('.github/workflows/apply-rotation-groups.yml').read_text().splitlines()
start = next(i for i, line in enumerate(source) if "python3 <<'PY'" in line) + 1
lines = source[start:]

out = []
in_triple = False
for line in lines:
    if not in_triple and line == '          PY':
        break
    processed = line if in_triple else (line[10:] if line.startswith('          ') else line)
    out.append(processed)
    if processed.count("'''") % 2:
        in_triple = not in_triple

Path('/tmp/rotation-group-patch.py').write_text('\n'.join(out) + '\n')
