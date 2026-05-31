#!/usr/bin/env python3
"""Generate a model-showcase promo per collection ("All parts for your <model>").

Reads each data/NN-<slug>.json, picks the 6 highest-value parts as a grid, and
emits promo-showcase-NN-<slug>.html (3 schemes) with a QR to the collection page.
Only collections with >= MIN products get a showcase (a grid needs a few parts).

Usage: python3 build_showcases.py
"""
import json, glob, os, re
import qr as QR
from build_promos import render_showcase, doc, write, qr_block

WORK = os.path.dirname(__file__)
MIN = 1  # include every collection (grids fill as stock grows)

def collection_url(handle):
    return QR.collection_url(handle) if handle else QR.SITE

def main():
    links = []
    built = []
    for path in sorted(glob.glob(os.path.join(WORK, 'data', '[0-9]*-*.json'))):
        cfg = json.load(open(path))
        prods = cfg.get('products', [])
        if len(prods) < MIN:
            continue
        index, slug = cfg['index'], cfg['slug']
        # 6 hero parts, highest price first
        ranked = sorted(prods, key=lambda p: float(p['price']), reverse=True)
        parts = [{'img': p['imgs'][0], 'price': p['price']} for p in ranked[:6] if p.get('imgs')]
        frm = min(float(p['price']) for p in prods)
        P = {'model': cfg['title'], 'count': len(prods), 'from': frm, 'parts': parts}

        code = f"sc-{slug}"
        handle = cfg.get('collection_handle')
        links.append(QR.link(code, collection_url(handle), 'collection',
                             label=f"{cfg['title']} — all parts", utm_campaign=code))
        qrhtml = qr_block(code, "SCAN: ALL PARTS")

        heading = f"Showcase · {cfg['title']}"
        out = f"promo-showcase-{index}-{slug}.html"
        write(out, doc(heading, [(heading, render_showcase(P, qrhtml=qrhtml))]))
        built.append(out)
        print("built", out, f"({len(prods)} parts, from £{frm:,.2f})")

    json.dump(links, open(os.path.join(WORK, 'data', 'qr-links-showcases.json'), 'w'),
              indent=2, ensure_ascii=False)
    print(f"\n{len(built)} showcases · qr-links-showcases.json: {len(links)} links")

if __name__ == '__main__':
    main()
