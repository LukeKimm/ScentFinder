#!/usr/bin/env python3
"""extension/ 폴더에 새로 생긴 파일을 Xcode 프로젝트(xcode/ScentFinder)에 추가합니다.

Apple 변환 도구는 확장 파일을 하나씩 프로젝트에 등록하기 때문에, git pull 로 새 파일이 생기면
Xcode 빌드에 빠져서 확장이 동작하지 않습니다. git pull 뒤에 한 번 실행하세요:

    python3 tools/sync_xcode.py

(이미 들어 있는 파일은 건드리지 않음. 서명·Team 설정도 그대로 유지)
"""
import hashlib, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBX = os.path.join(ROOT, 'xcode', 'ScentFinder', 'ScentFinder.xcodeproj', 'project.pbxproj')
EXT = os.path.join(ROOT, 'extension')
TEMPLATE = 'classify.js'   # 이 파일의 등록 항목을 본떠서 새 파일을 등록
TYPES = {'.js': 'sourcecode.javascript', '.json': 'text.json', '.html': 'text.html', '.css': 'text.css', '.png': 'image.png'}

if not os.path.exists(PBX):
    sys.exit('xcode/ScentFinder 프로젝트가 없습니다. 먼저 ./build.sh 를 실행하세요.')

src = open(PBX, encoding='utf-8').read()
lines = src.split('\n')
tpl_lines = [i for i, l in enumerate(lines) if f'/* {TEMPLATE}' in l or f'name = {TEMPLATE};' in l]
if not tpl_lines:
    sys.exit(f'프로젝트에서 {TEMPLATE} 항목을 찾지 못했습니다.')

existing = set(re.findall(r'path = \.\./\.\./\.\./extension/([^;]+);', src))
existing |= set(re.findall(r'name = ([^;]+);', src))
missing = sorted(f for f in os.listdir(EXT)
                 if os.path.isfile(os.path.join(EXT, f)) and not f.startswith('.')
                 and os.path.splitext(f)[1] in TYPES and f not in existing)
if not missing:
    print('추가할 파일 없음 — 프로젝트가 최신입니다.')
    sys.exit(0)

ids = set(re.findall(r'\b[0-9A-F]{24}\b', src))
def new_id(seed):
    n = 0
    while True:
        h = hashlib.md5(f'{seed}:{n}'.encode()).hexdigest().upper()[:24]
        if h not in ids:
            ids.add(h)
            return h
        n += 1

inserts = {}  # 원래 줄 번호 → 뒤에 붙일 줄들
for f in missing:
    mapping = {}
    for i in tpl_lines:
        line = lines[i]
        for old in re.findall(r'\b[0-9A-F]{24}\b', line):
            mapping.setdefault(old, new_id(f + old))
        new = line
        for old, nid in mapping.items():
            new = new.replace(old, nid)
        new = new.replace(TEMPLATE, f).replace('sourcecode.javascript', TYPES[os.path.splitext(f)[1]])
        inserts.setdefault(i, []).append(new)

out = []
for i, l in enumerate(lines):
    out.append(l)
    out.extend(inserts.get(i, []))
open(PBX, 'w', encoding='utf-8').write('\n'.join(out))
print('Xcode 프로젝트에 추가:', ', '.join(missing))
