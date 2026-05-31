#!/usr/bin/env python3
"""Build index.html — a simple hub linking every generated ad file.
Usage: python3 build_index.py
"""
import glob, os, re
WORK = os.path.dirname(__file__)

def links(pattern, label):
    out = []
    for f in sorted(glob.glob(os.path.join(WORK, pattern))):
        n = os.path.basename(f)
        if n == 'index.html':
            continue
        out.append(f'<li><a href="{n}">{n}</a></li>')
    return f'<h2>{label} <span>({len(out)})</span></h2><ul>{"".join(out)}</ul>' if out else ''

def main():
    body = (
        links('razoryn-promos.html', 'Promo pack (all promos · review sheet)')
        + links('promo-[!s]*.html', 'Promotional ads')          # promo-*.html but not promo-showcase
        + links('promo-showcase-*.html', 'Model showcases')
        + links('razoryn-[0-9]*.html', 'Collection listings')
    )
    html = (
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Razoryn e-Parts — Ad Library</title>'
        '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">'
        '<style>'
        'body{margin:0;font-family:Inter,sans-serif;background:#0f1318;color:#f0f2f5;padding:40px;max-width:900px;margin:0 auto;}'
        "h1{font-family:'Barlow Condensed';font-weight:800;font-size:42px;text-transform:uppercase;margin:0 0 4px;}"
        '.sub{color:#6b7785;font-weight:600;margin-bottom:8px;}'
        '.note{color:#9aa0a8;font-size:13px;line-height:1.5;background:#1a1f25;border:1px solid #2a313a;border-radius:10px;padding:14px 16px;margin:18px 0 28px;}'
        "h2{font-family:'Barlow Condensed';font-weight:700;font-size:22px;text-transform:uppercase;margin:28px 0 10px;border-top:1px solid #2a313a;padding-top:20px;}"
        'h2 span{color:#6b7785;font-size:15px;}'
        'ul{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;}'
        'a{color:#fff;text-decoration:none;background:#1a1f25;border:1px solid #2a313a;border-radius:8px;padding:10px 14px;display:block;font-weight:600;font-size:14px;}'
        'a:hover{border-color:#e83948;color:#e83948;}'
        '</style></head><body>'
        '<h1>Razoryn e-Parts — Ad Library</h1>'
        '<div class="sub">Print-ready 1080×1350 ads · White / Red / Navy</div>'
        '<div class="note">Open any file in a browser to preview (product photos load from Shopify). '
        'To post: <b>Print → Save as PDF</b> (Margins: None, Background graphics: ON), or run '
        '<b>node export_png.js</b> for ready-to-post PNGs in <b>export/</b>.</div>'
        + body + '</body></html>'
    )
    open(os.path.join(WORK, 'index.html'), 'w').write(html)
    print('built index.html')

if __name__ == '__main__':
    main()
