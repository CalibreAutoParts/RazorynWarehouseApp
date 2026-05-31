#!/usr/bin/env python3
"""Reusable Razoryn listing builder. One HTML file per collection.
Usage: import build; build(collection_title, index, products, out_path)
products: list of dicts {title, finish, position, secondary, part, price, imgs:[urls]}
"""
import base64, re, html as H, os

WORK = os.path.dirname(__file__)
RED='#c8202d'; RED_DARK='#e83948'; INK='#2c353e'; MUT='#6b7785'
BORDER='#e5e7eb'; DARKBG='#0f1318'; NAVYCHIP='#1a1f25'
PHONE='01923 372432'; EMAIL='eparts@razoryn.co.uk'; LOGO_RATIO='1200/268'
PHONE_SVG=('<svg class="ph" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 '
 '3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 '
 '21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .7-.2 1l-2.3 2.3z"/></svg>')

def _b64(p): return base64.b64encode(open(os.path.join(WORK,p),'rb').read()).decode()
RED_LOGO=_b64('logo_red.png'); WHITE_LOGO=_b64('logo_white.png')

def parse(title, finish):
    m=re.search(r'(\d{4})\s*[-–]\s*(\d{4})', title)
    years=f"{m.group(1)}–{m.group(2)}" if m else ""
    before=title[:m.start()].strip() if m else title
    after=title[m.end():].strip() if m else ""
    if finish:
        after=re.sub(r'^\s*'+re.escape(finish)+r'\s*','',after,flags=re.I).strip()
    return before, years, after

def norm(p):
    mm,years,desc=parse(p['title'], p.get('finish'))
    mm=mm.replace("CHR","C-HR")
    position=" · ".join([x for x in [p.get('secondary'),p.get('position')] if x]) or "—"
    sub=" · ".join([x for x in [years, p.get('finish'), "Aftermarket"] if x])
    price=float(p['price']); ebay=round(price*1.07,2)
    return dict(mm=mm.upper(), desc=(desc or "Aftermarket Part").upper(),
        sub=sub, finish=p.get('finish') or "—", position=position, part=p['part'],
        web=f"£{price:,.2f}", ebay=f"£{ebay:,.2f}", imgs=p['imgs'])

def slide(cls, P, img):
    return (f'<div class="stage"><div class="post {cls}">'
      f'<div class="head"><div class="logo"></div><div class="pill">{PHONE_SVG}<span>CALL {PHONE}</span></div></div>'
      f'<div class="rule"></div><div class="photo"><img loading="lazy" src="{img}" alt="{H.escape(P["mm"])}"></div>'
      f'<div class="meta"><div class="eyebrow">{H.escape(P["desc"])}</div><div class="title">{H.escape(P["mm"])}</div>'
      f'<div class="sub">{H.escape(P["sub"])}</div></div>'
      f'<div class="specs"><div class="spec"><div class="l">FINISH</div><div class="v">{H.escape(P["finish"])}</div></div>'
      f'<div class="spec"><div class="l">POSITION</div><div class="v">{H.escape(P["position"])}</div></div>'
      f'<div class="spec"><div class="l">PART NO.</div><div class="v">{H.escape(P["part"])}</div></div></div>'
      f'<div class="bottom"><div class="buy"><div class="exl">WEBSITE EXCLUSIVE PRICE</div><div class="amt">{P["web"]}</div>'
      f'<div class="cmp">{P["ebay"]} on eBay · save 7%</div></div>'
      f'<div class="contact"><div class="site">RAZORYN.CO.UK</div><div class="c">{EMAIL}</div>'
      f'<div class="c muted">Same-Day Dispatch · Fitment Support</div></div></div></div></div>')

CSS=f''':root{{--red:{RED};--red-dark:{RED_DARK};--ink:{INK};--mut:{MUT};--border:{BORDER};--darkbg:{DARKBG};--navychip:{NAVYCHIP};--logo-red:url("data:image/png;base64,{RED_LOGO}");--logo-white:url("data:image/png;base64,{WHITE_LOGO}");}}
*{{margin:0;padding:0;box-sizing:border-box;}}body{{background:#1d2026;font-family:'Inter',sans-serif;padding:24px;min-height:100vh;color:#fff;}}
h1{{font-family:'Barlow Condensed';font-weight:800;font-size:30px;text-transform:uppercase;margin-bottom:4px;}}
.ph2{{font-family:'Barlow Condensed';font-weight:700;font-size:23px;text-transform:uppercase;margin:32px 0 6px;color:#fff;}}
.cap{{color:#9aa0a8;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;margin:10px 0 8px;}}
.group{{display:flex;flex-wrap:wrap;gap:16px;}}.stage{{width:min(100%,330px);}}
.post{{position:relative;width:100%;aspect-ratio:1080/1350;container-type:inline-size;overflow:hidden;display:flex;flex-direction:column;padding:5cqw 5.2cqw 6.6cqw;--bg:#fff;--fg:var(--ink);--m:var(--mut);--eye:var(--red);--rulec:var(--red);--boxbg:#fff;--boxbd:var(--border);--linec:var(--border);--pillbg:var(--red);--pilltx:#fff;--chipbg:var(--red);--chiptx:#fff;--logo:var(--logo-red);background:var(--bg);}}
.head{{display:flex;align-items:center;justify-content:space-between;gap:3cqw;}}.logo{{height:7cqw;aspect-ratio:{LOGO_RATIO};background:var(--logo) left center/contain no-repeat;flex:0 0 auto;}}
.pill{{display:inline-flex;align-items:center;gap:1.4cqw;font-weight:700;font-size:2.3cqw;letter-spacing:.03em;color:var(--pilltx);background:var(--pillbg);padding:1.7cqw 3cqw;border-radius:100px;white-space:nowrap;}}.pill .ph{{width:2.9cqw;height:2.9cqw;}}
.rule{{height:.5cqw;background:var(--rulec);margin-top:3.2cqw;border-radius:2px;}}
.photo{{flex:1 1 0;min-height:0;margin:3.4cqw 0;background:var(--boxbg);border:.3cqw solid var(--boxbd);border-radius:2.6cqw;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 1.6cqw 4cqw rgba(0,0,0,.12);}}.photo img{{width:100%;height:100%;object-fit:contain;padding:3cqw;}}
.meta{{min-height:0;}}.meta .eyebrow{{font-weight:800;font-size:2.45cqw;letter-spacing:.15em;color:var(--eye);line-height:1.25;}}.meta .title{{font-family:'Barlow Condensed';font-weight:800;font-size:9.4cqw;line-height:.9;color:var(--fg);text-transform:uppercase;margin-top:1.1cqw;}}.meta .sub{{font-weight:500;font-size:2.8cqw;color:var(--m);margin-top:1.2cqw;}}
.specs{{display:grid;grid-template-columns:1fr 1fr 1.25fr;gap:2.4cqw;margin-top:3cqw;padding-top:2.6cqw;border-top:.35cqw solid var(--linec);}}.spec .l{{font-weight:800;font-size:1.8cqw;letter-spacing:.1em;color:var(--m);}}.spec .v{{font-weight:700;font-size:2.45cqw;color:var(--fg);margin-top:.6cqw;word-break:break-word;line-height:1.1;}}
.bottom{{display:flex;align-items:stretch;justify-content:space-between;gap:3cqw;margin-top:3.4cqw;}}.buy{{background:var(--chipbg);border-radius:2.4cqw;padding:2.4cqw 3.2cqw;color:var(--chiptx);display:flex;flex-direction:column;justify-content:center;}}.buy .exl{{font-weight:800;font-size:1.8cqw;letter-spacing:.1em;opacity:.85;}}.buy .amt{{font-family:'Barlow Condensed';font-weight:800;font-size:8cqw;line-height:.86;margin-top:.4cqw;}}.buy .cmp{{font-weight:600;font-size:1.95cqw;opacity:.85;margin-top:.5cqw;}}
.contact{{text-align:right;display:flex;flex-direction:column;justify-content:center;}}.contact .site{{font-family:'Barlow Condensed';font-weight:700;font-size:4.3cqw;color:var(--fg);text-transform:uppercase;}}.contact .c{{font-weight:600;font-size:2.25cqw;color:var(--fg);margin-top:.6cqw;}}.contact .muted{{color:var(--m);}}
.post.s-red{{--bg:var(--red);--fg:#fff;--m:rgba(255,255,255,.8);--eye:#fff;--rulec:rgba(255,255,255,.55);--boxbg:#fff;--boxbd:transparent;--linec:rgba(255,255,255,.28);--pillbg:#fff;--pilltx:var(--red);--chipbg:var(--navychip);--chiptx:#fff;--logo:var(--logo-white);}}
.post.s-navy{{--bg:var(--darkbg);--fg:#f0f2f5;--m:rgba(255,255,255,.66);--eye:var(--red-dark);--rulec:var(--red-dark);--boxbg:#fff;--boxbd:transparent;--linec:rgba(255,255,255,.16);--pillbg:var(--red-dark);--pilltx:#fff;--chipbg:var(--red-dark);--chiptx:#fff;--logo:var(--logo-white);}}
@page{{size:1080px 1350px;margin:0;}}
@media print{{html,body{{background:#fff !important;padding:0 !important;}}h1,.ph2,.cap{{display:none !important;}}.group{{display:block !important;gap:0 !important;}}.stage{{width:1080px !important;max-width:none !important;break-after:page;}}.post{{box-shadow:none;border:0;}}}}'''

SCHEMES=[("s-white","White · Light"),("s-red","Red · Brand"),("s-navy","Navy · Dark")]

def build(collection_title, index, products, out_path):
    items=[norm(p) for p in products]
    body=[]
    for P in items:
        body.append(f'<h2 class="ph2">{H.escape(P["mm"])} · {H.escape(P["desc"].title())} · {P["web"]}</h2>')
        for label,idx in [("Front",0),("Back",1)]:
            if len(P['imgs'])>idx and P['imgs'][idx]:
                body.append(f'<div class="cap">{label}</div><div class="group">')
                for cls,_ in SCHEMES: body.append(slide(cls,P,P['imgs'][idx]))
                body.append('</div>')
    doc=(f'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
      f'<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      f'<title>Razoryn — {H.escape(collection_title)}</title>'
      f'<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      f'<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
      f'<style>{CSS}</style></head><body>'
      f'<h1>{H.escape(collection_title)} — Listings</h1>'
      f'<div class="cap">Collection {index} · {len(items)} products · White / Red / Navy · front &amp; back</div>'
      f'{"".join(body)}</body></html>')
    open(out_path,'w').write(doc)
    return out_path, len(items)

if __name__=='__main__':
    import json,sys
    cfg=json.load(open(sys.argv[1]))
    p,n=build(cfg['title'],cfg['index'],cfg['products'],cfg['out'])
    print('built',p,'with',n,'products')
