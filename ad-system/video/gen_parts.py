#!/usr/bin/env python3
"""Build src/parts.json for the Remotion videos from the collection data.

Picks the single highest-value part from each collection (one per model for
variety), sorts premium-first, caps the list, and writes {img, model, name, price}.
Run: python3 gen_parts.py
"""
import json, glob, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import build_collection as B   # reuse parse/norm + hires

CAP = 12

def model_of(title):
    return re.sub(r'\s*\d{4}(?:\s*[-–]\s*\d{4})?\s*\+?\s*$', '', title).strip()  # strip trailing year/range only

def clean(name):
    name = name.title().replace(' W/ ', ' w/ ')
    return (name[:30].rstrip(' -') + '…') if len(name) > 31 else name

rows = []
for path in sorted(glob.glob(os.path.join(HERE, '..', 'data', '[0-9]*-*.json'))):
    cfg = json.load(open(path))
    prods = [p for p in cfg.get('products', []) if p.get('imgs')]
    if not prods:
        continue
    hero = max(prods, key=lambda p: float(p['price']))
    N = B.norm(hero)
    rows.append({
        'img': B.hires(hero['imgs'][0], 1200),
        'model': model_of(cfg['title']),
        'name': clean(N['desc']),
        'price': N['web'],
    })

rows.sort(key=lambda r: float(r['price'].replace('£', '').replace(',', '')), reverse=True)
rows = rows[:CAP]
json.dump(rows, open(os.path.join(HERE, 'src', 'parts.json'), 'w'), indent=2, ensure_ascii=False)
print(f"wrote src/parts.json: {len(rows)} parts")
for r in rows:
    print(f"  {r['price']:>9}  {r['model']} — {r['name']}")
