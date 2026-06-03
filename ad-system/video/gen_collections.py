#!/usr/bin/env python3
"""Build src/collections.json + src/headlights.json for the per-collection video ads.

For each collection: model, car-render (or hero part) image, collection URL, part
count, 'from' price and the top-6 parts. Also a cross-collection RHD-headlights list.
Run: python3 gen_collections.py
"""
import json, glob, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import build_collection as B

def money(v): return f"£{float(v):,.2f}"

SITE = 'https://www.razoryn.co.uk'
CDN = 'https://cdn.shopify.com/s/files/1/1033/6278/9714/collections/'
# collections with a proper car-render image (others fall back to their hero part)
RENDER = {
    'i20': '64.png?v=1778334179', 'kona-sx2': '62.png?v=1778334374', 'tucson': '66.png?v=1778334287',
    'ioniq-5': '61.png?v=1778334447', 'sportage': '59.png?v=1778334055', 'picanto': '57.png?v=1778334133',
    'ioniq': '60.png?v=1778334413', 'niro-sg2': '56.png?v=1778333898', 'bayon': '65.png?v=1778334239',
    'niro': '58.png?v=1778333991', 'kona': '63.png?v=1778334332',
}

def model_of(title):
    return re.sub(r'\s*\d{4}(?:\s*[-–]\s*\d{4})?\s*\+?\s*$', '', title).strip()

def clean(name):
    name = name.title().replace(' W/ ', ' w/ ').replace('Led', 'LED').replace('Drl', 'DRL')
    return (name[:28].rstrip(' -') + '…') if len(name) > 29 else name

cols, heads = [], []
for path in sorted(glob.glob(os.path.join(HERE, '..', 'data', '[0-9]*-*.json'))):
    cfg = json.load(open(path))
    prods = [p for p in cfg.get('products', []) if p.get('imgs')]
    if not prods:
        continue
    slug = cfg['slug']
    handle = cfg.get('collection_handle') or slug
    ranked = sorted(prods, key=lambda p: float(p['price']), reverse=True)
    parts = [{'img': B.hires(p['imgs'][0], 1200), 'name': clean(B.norm(p)['desc']), 'price': money(p['price'])} for p in ranked[:6]]
    hero = (CDN + RENDER[slug]) if slug in RENDER else parts[0]['img']
    cols.append({
        'slug': slug, 'title': cfg['title'], 'model': model_of(cfg['title']),
        'img': hero, 'url': f'{SITE}/collections/{handle}',
        'count': len(prods), 'from': money(min(float(p['price']) for p in prods)),
        'parts': parts,
    })
    # RHD headlights for the UK-market ad
    for p in prods:
        t = p['title'].lower()
        if ('headlight' in t or 'headlamp' in t) and 'bracket' not in t:
            heads.append({'img': B.hires(p['imgs'][0], 1200), 'model': model_of(cfg['title']),
                          'name': clean(B.norm(p)['desc']), 'price': money(p['price'])})

# dedupe headlights by model (keep priciest = usually the LED/main unit), cap 8
seen = {}
for h in sorted(heads, key=lambda x: float(x['price'].replace('£', '').replace(',', '')), reverse=True):
    seen.setdefault(h['model'], h)
heads = list(seen.values())[:8]

json.dump(cols, open(os.path.join(HERE, 'src', 'collections.json'), 'w'), indent=2, ensure_ascii=False)
json.dump(heads, open(os.path.join(HERE, 'src', 'headlights.json'), 'w'), indent=2, ensure_ascii=False)
print(f"collections.json: {len(cols)} collections")
print(f"headlights.json:  {len(heads)} RHD headlights")
for h in heads: print(f"  {h['price']:>9}  {h['model']} — {h['name']}")
