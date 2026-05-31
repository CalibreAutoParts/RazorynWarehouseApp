#!/usr/bin/env python3
"""Build src/models.json for the SiteShowcase video — the "Shop by vehicle model"
grid, mirroring razoryn.co.uk. Uses each collection's car-render image (from Shopify)
+ its title and live part count. Run: python3 gen_models.py
"""
import json, glob, os
HERE = os.path.dirname(os.path.abspath(__file__))
CDN = 'https://cdn.shopify.com/s/files/1/1033/6278/9714/collections/'

# slug (data filename) -> collection car-render image (models without a render are skipped)
IMG = {
    'i20':       CDN + '64.png?v=1778334179',
    'kona-sx2':  CDN + '62.png?v=1778334374',
    'tucson':    CDN + '66.png?v=1778334287',
    'ioniq-5':   CDN + '61.png?v=1778334447',
    'sportage':  CDN + '59.png?v=1778334055',
    'picanto':   CDN + '57.png?v=1778334133',
    'ioniq':     CDN + '60.png?v=1778334413',
    'niro-sg2':  CDN + '56.png?v=1778333898',
    'bayon':     CDN + '65.png?v=1778334239',
    'niro':      CDN + '58.png?v=1778333991',
    'kona':      CDN + '63.png?v=1778334332',
}
CAP = 8   # how many model cards to scroll through in the video

rows = []
for path in glob.glob(os.path.join(HERE, '..', 'data', '[0-9]*-*.json')):
    cfg = json.load(open(path))
    slug = cfg.get('slug')
    if slug in IMG:
        rows.append({'img': IMG[slug], 'title': cfg['title'].upper(), 'parts': len(cfg.get('products', []))})

rows.sort(key=lambda r: r['parts'], reverse=True)
rows = rows[:CAP]
json.dump(rows, open(os.path.join(HERE, 'src', 'models.json'), 'w'), indent=2, ensure_ascii=False)
print(f"wrote src/models.json: {len(rows)} models")
for r in rows:
    print(f"  {r['parts']:>3} parts  {r['title']}")
