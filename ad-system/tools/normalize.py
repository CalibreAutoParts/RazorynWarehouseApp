#!/usr/bin/env python3
"""Convert a raw Shopify GraphQL products response into build_collection.py data.

Usage:
  python3 tools/normalize.py <raw.json> --index 04 --slug i20 \
      --title "Hyundai i20 BC3 2020-2026" [--collection <handle>] [--out <path>]

<raw.json> is the verbatim GraphQL result (either the whole {"data":{...}} envelope
or just the products object). Emits ad-system/data/<index>-<slug>.json ready for:
  python3 build_collection.py data/<index>-<slug>.json
"""
import json, os, sys, argparse

WORK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def edges_of(raw):
    d = raw.get('data', raw)
    p = d.get('products', d)
    return p['edges']

def first(node, *path, default=None):
    cur = node
    for k in path:
        if cur is None: return default
        cur = cur.get(k) if isinstance(cur, dict) else None
    return cur if cur is not None else default

def norm_node(n):
    imgs = [first(e, 'node', 'image', 'url') for e in first(n, 'media', 'edges', default=[])]
    imgs = [u for u in imgs if u]
    v = first(n, 'variants', 'edges', default=[])
    sku = first(v[0], 'node', 'sku', default='') if v else ''
    price = first(v[0], 'node', 'price', default='0') if v else '0'
    part = (first(n, 'partNumber', 'value') or sku or '').strip()
    sec = first(n, 'secondary', 'value')
    return {
        'title': n['title'].strip(),
        'finish': first(n, 'finish', 'value'),
        'position': first(n, 'position', 'value'),
        'secondary': sec.strip() if isinstance(sec, str) else sec,
        'part': part,
        'price': str(price),
        'imgs': imgs,
        'sku': sku,
        'handle': n.get('handle'),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw')
    ap.add_argument('--index', required=True)
    ap.add_argument('--slug', required=True)
    ap.add_argument('--title', required=True)
    ap.add_argument('--collection', default=None, help='collection handle (for showcase QR)')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    raw = json.load(open(a.raw))
    products = [norm_node(e['node']) for e in edges_of(raw)]
    out = a.out or f"ad-system/data/{a.index}-{a.slug}.json"
    data = {
        'title': a.title, 'index': a.index, 'slug': a.slug,
        'out': f"ad-system/razoryn-{a.index}-{a.slug}.html",
        'collection_handle': a.collection,
        'products': products,
    }
    os.makedirs(os.path.join(WORK, 'data'), exist_ok=True)
    json.dump(data, open(out, 'w'), indent=2, ensure_ascii=False)
    miss = [p['sku'] for p in products if not p['handle'] or not p['imgs']]
    print(f"wrote {out}: {len(products)} products"
          + (f"; ⚠ missing handle/imgs: {miss}" if miss else ""))

if __name__ == '__main__':
    main()
