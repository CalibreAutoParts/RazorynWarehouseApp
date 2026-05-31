#!/usr/bin/env python3
"""Razoryn e-Parts promotional ad builder — high-converting social/promo formats.

Reuses the listing design system (Barlow Condensed + Inter, brand red/navy,
3 colour schemes, 1080x1350 print frame). Emits one print-ready HTML file per
promo, plus a combined `razoryn-promos.html` review sheet.

Each promo is a render_*() that returns the inner-content HTML for one .post;
the scheme tokens (--bg/--fg/--eye/--logo/...) are identical to build_collection.py
so White / Red / Navy work everywhere with no per-promo overrides.

Usage:  python3 build_promos.py
"""
import base64, html as H, os, json
import qr as QR

WORK = os.path.dirname(__file__)
RED='#c8202d'; RED_DARK='#e83948'; INK='#2c353e'; MUT='#6b7785'
BORDER='#e5e7eb'; DARKBG='#0f1318'; NAVYCHIP='#1a1f25'
PHONE='01923 372432'; EMAIL='eparts@razoryn.co.uk'; SITE='RAZORYN.CO.UK'
WHATSAPP='+44 7494 589542'; LOGO_RATIO='1200/268'

def _b64(p): return base64.b64encode(open(os.path.join(WORK,p),'rb').read()).decode()
RED_LOGO=_b64('logo_red.png'); WHITE_LOGO=_b64('logo_white.png')

# ---- icons (inherit currentColor) -----------------------------------------
ICON = {
 'phone':'<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .7-.2 1l-2.3 2.3z"/>',
 'truck':'<path d="M3 5h11v9H3zM14 8h3.5L21 11.2V14h-7zM7 18.5A1.6 1.6 0 1 1 7 15a1.6 1.6 0 0 1 0 3.5zM17.5 18.5a1.6 1.6 0 1 1 0-3.5 1.6 1.6 0 0 1 0 3.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
 'clock':'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.4 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
 'shield':'<path d="M12 3l7 2.5V11c0 4.5-3 8-7 10-4-2-7-5.5-7-10V5.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.7 12l2.2 2.2L15.5 9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
 'check':'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12.3l2.6 2.6L16.2 9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
 'bolt':'<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
 'tag':'<path d="M4 4h7l9 9-7 7-9-9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.4"/>',
 'pin':'<path d="M12 22s7-6.4 7-12A7 7 0 0 0 5 10c0 5.6 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/>',
 'spark':'<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
}
def ic(name, cls='ic'):
    return f'<svg class="{cls}" viewBox="0 0 24 24" fill="currentColor">{ICON[name]}</svg>'

def money(v): return f"£{float(v):,.2f}"
def ebay(v):  return round(float(v)*1.07, 2)

def hires(url, w=1600):
    """Request a high-res render from the Shopify CDN (keeps photos crisp at 1080px)."""
    if 'cdn.shopify.com' not in url or 'width=' in url: return url
    return url + ('&' if '?' in url else '?') + f'width={w}'

# ---- shared scaffold -------------------------------------------------------
def head(logo_pill=True):
    pill = (f'<div class="pill">{ic("phone","ph")}<span>CALL {PHONE}</span></div>') if logo_pill else ''
    return f'<div class="head"><div class="logo"></div>{pill}</div>'

def ctabar(line2="Same-Day Dispatch · Fitment Support · 30-Day Returns", qrhtml=''):
    return (f'<div class="cta"><div class="cta-l"><div class="site">{SITE}</div>'
            f'<div class="csub">{H.escape(line2)}</div></div>{qrhtml}'
            f'<div class="cta-r">{ic("phone","ph")}<span>{PHONE}</span></div></div>')

def qr_block(code, label="SCAN TO SHOP"):
    svg = QR.qr_svg(QR.go_url(code))
    return f'<div class="qr"><div class="qrbox">{svg}</div><div class="qrl">{H.escape(label)}</div></div>'

def photocard(img, alt, cls="hero"):
    return f'<div class="{cls}"><img loading="lazy" src="{hires(img)}" alt="{H.escape(alt)}"></div>'

# ---- promo renderers (return inner HTML of one .post) ----------------------
def render_website_exclusive(P, qrhtml=''):
    eb = money(ebay(P['price'])); web = money(P['price'])
    return (head()
      + '<div class="pwrap center">'
      + '<div class="eyebrow2">WEBSITE EXCLUSIVE PRICE</div>'
      + '<h2 class="hl">BUY DIRECT<br><span class="hl-accent">&amp; SAVE 7%</span></h2>'
      + '<div class="subh">The same aftermarket part for less when you order direct from RAZORYN.CO.UK — with same-day dispatch.</div>'
      + photocard(P['img'], P['title'], 'hero')
      + f'<div class="partline">{H.escape(P["title"].upper())}</div>'
      + '<div class="compare">'
      + f'<div class="cmpcell ebay"><div class="cl">OUR EBAY STORE</div><div class="cv">{eb}</div></div>'
      + '<div class="cmparrow"><span class="vs">save<br>7%</span></div>'
      + f'<div class="cmpcell direct"><div class="cl">DIRECT ONLINE</div><div class="cv">{web}</div><div class="cnote">our best price</div></div>'
      + '</div></div>' + ctabar(qrhtml=qrhtml))

def render_same_day(P, qrhtml=''):
    return (head()
      + '<div class="pwrap center">'
      + f'<div class="bigicon">{ic("clock","biggi")}</div>'
      + '<div class="eyebrow2">UK STOCK · READY TO SHIP</div>'
      + '<h2 class="hl">ORDER BY <span class="hl-accent">12 NOON</span><br>DISPATCHED TODAY</h2>'
      + '<div class="subh">Beat the 12pm cut-off and your parts leave the same day — straight from our Watford warehouse.</div>'
      + '<div class="collage">' + ''.join(photocard(i, '', 'thumb') for i in P['imgs'][:3]) + '</div>'
      + '<div class="pillrow"><span class="ipill">'+ic("pin","ip")+'Watford, WD24 5RR</span>'
        '<span class="ipill">'+ic("check","ip")+'Mon–Fri 10–5 · Sat 10–2</span></div>'
      + '</div>' + ctabar("Free UK delivery over £50 · 30-day returns", qrhtml=qrhtml))

def render_free_delivery(P, qrhtml=''):
    return (head()
      + '<div class="pwrap center">'
      + f'<div class="bigicon">{ic("truck","biggi")}</div>'
      + '<div class="eyebrow2">ACROSS THE UK</div>'
      + '<h2 class="hl">FREE UK DELIVERY<br><span class="hl-accent">OVER £50</span></h2>'
      + '<div class="subh">Spend £50 or more and shipping is on us. Dispatched same day when you order before 12pm.</div>'
      + '<div class="collage">' + ''.join(photocard(i, '', 'thumb') for i in P['imgs'][:3]) + '</div>'
      + '<div class="pillrow"><span class="ipill">'+ic("bolt","ip")+'Same-day dispatch</span>'
        '<span class="ipill">'+ic("shield","ip")+'Tracked & insured</span></div>'
      + '</div>' + ctabar("Order before 12pm · Dispatched today", qrhtml=qrhtml))

def render_showcase(P, qrhtml=''):
    cells = []
    for it in P['parts'][:6]:
        cells.append(f'<div class="gcell"><div class="gimg"><img loading="lazy" src="{hires(it["img"],900)}" alt=""></div>'
                     f'<div class="gtag">{money(it["price"])}</div></div>')
    return (head()
      + '<div class="pwrap top">'
      + '<div class="eyebrow2">EVERYTHING IN ONE PLACE</div>'
      + f'<h2 class="hl sm">ALL PARTS FOR YOUR <span class="hl-accent">{H.escape(P["model"])}</span></h2>'
      + f'<div class="subh left">{P["count"]} aftermarket part{"s" if P["count"]!=1 else ""} in stock · from {money(P["from"])} · panels, bumpers, trims &amp; more.</div>'
      + '<div class="grid6">' + ''.join(cells) + '</div>'
      + f'<div class="shopline">Shop the full range &rarr; <b>{SITE}</b></div>'
      + '</div>' + ctabar(qrhtml=qrhtml))

def render_fitment(P, qrhtml=''):
    badges = [('shield','AFTERMARKET QUALITY','Built to fit & last'),
              ('check','REAL FITMENT SUPPORT','We help you order right'),
              ('truck','UK WAREHOUSE STOCK','Dispatched from Watford')]
    bhtml = ''.join(f'<div class="badge">{ic(n,"bi")}<div class="bt">{t}</div><div class="bd">{d}</div></div>'
                    for n,t,d in badges)
    return (head()
      + '<div class="pwrap center">'
      + '<div class="eyebrow2">BUY WITH CONFIDENCE</div>'
      + '<h2 class="hl">THE RIGHT PART,<br><span class="hl-accent">FIRST TIME</span></h2>'
      + '<div class="subh">Not sure it fits? Send us your reg or part number — we&rsquo;ll confirm before you buy.</div>'
      + f'<div class="badges">{bhtml}</div>'
      + f'<div class="pillrow"><span class="ipill">{ic("phone","ip")}{PHONE}</span>'
        f'<span class="ipill">{ic("spark","ip")}WhatsApp {WHATSAPP}</span></div>'
      + '</div>' + ctabar("Mon–Fri 10–5 · Sat 10–2 · 30-day returns", qrhtml=qrhtml))

def render_cover(P, qrhtml=''):
    return ('<div class="cover">' + head(logo_pill=False)
      + '<div class="cv-mid">'
      + '<div class="eyebrow2">AFTERMARKET BODY PANELS &amp; TRIM</div>'
      + '<h2 class="hl xl">QUALITY CAR PARTS<br><span class="hl-accent">WITHOUT THE MARKUP</span></h2>'
      + '<div class="subh">Toyota · Hyundai · Kia · Nissan · Peugeot · Vauxhall — bumpers, wings, grilles, lights &amp; more.</div>'
      + '</div>'
      + f'<div class="cv-foot"><div class="cv-foot-l"><div class="site big">{SITE}</div>'
        f'<div class="csub">Same-Day Dispatch · Fitment Support · Free UK Delivery over £50</div></div>{qrhtml}</div>'
      + '</div>')

# ---- CSS (literal hex; logos injected after) -------------------------------
CSS = r"""
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#1d2026;font-family:'Inter',sans-serif;padding:24px;min-height:100vh;color:#fff;}
h1{font-family:'Barlow Condensed';font-weight:800;font-size:30px;text-transform:uppercase;margin-bottom:4px;}
.ph2{font-family:'Barlow Condensed';font-weight:700;font-size:23px;text-transform:uppercase;margin:30px 0 6px;color:#fff;}
.cap{color:#9aa0a8;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;margin:10px 0 8px;}
.group{display:flex;flex-wrap:wrap;gap:16px;}
.stage{width:min(100%,330px);}
.post{position:relative;width:100%;aspect-ratio:1080/1350;container-type:inline-size;overflow:hidden;display:flex;flex-direction:column;padding:5cqw 5.2cqw 5.2cqw;
  --bg:#fff;--fg:#2c353e;--m:#6b7785;--eye:#c8202d;--logo:var(--logo-red);
  --boxbg:#fff;--boxbd:#e5e7eb;--linec:#e5e7eb;--pillbg:#c8202d;--pilltx:#fff;--chipbg:#c8202d;--chiptx:#fff;--accent:#c8202d;--soft:#f7f8fa;
  background:var(--bg);color:var(--fg);}
.post.s-red{--bg:#c8202d;--fg:#fff;--m:rgba(255,255,255,.82);--eye:#fff;--logo:var(--logo-white);--boxbd:transparent;--linec:rgba(255,255,255,.28);--pillbg:#fff;--pilltx:#c8202d;--chipbg:#1a1f25;--chiptx:#fff;--accent:#fff;--soft:rgba(255,255,255,.10);}
.post.s-navy{--bg:#0f1318;--fg:#f0f2f5;--m:rgba(255,255,255,.68);--eye:#e83948;--logo:var(--logo-white);--boxbd:rgba(255,255,255,.10);--linec:rgba(255,255,255,.16);--pillbg:#e83948;--pilltx:#fff;--chipbg:#e83948;--chiptx:#fff;--accent:#e83948;--soft:rgba(255,255,255,.06);}
/* header */
.head{display:flex;align-items:center;justify-content:space-between;gap:3cqw;flex:0 0 auto;}
.logo{height:7cqw;aspect-ratio:1200/268;background:var(--logo) left center/contain no-repeat;flex:0 0 auto;}
.pill{display:inline-flex;align-items:center;gap:1.4cqw;font-weight:700;font-size:2.3cqw;letter-spacing:.03em;color:var(--pilltx);background:var(--pillbg);padding:1.7cqw 3cqw;border-radius:100px;white-space:nowrap;}
.pill .ph{width:2.9cqw;height:2.9cqw;}
/* body wrap */
.pwrap{flex:1 1 0;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:2.4cqw;padding:2cqw 0;}
.pwrap.center{align-items:center;text-align:center;}
.pwrap.top{justify-content:flex-start;gap:2cqw;padding-top:3.5cqw;}
.pwrap.top .hl.sm{font-size:8cqw;}
.eyebrow2{font-weight:800;font-size:2.5cqw;letter-spacing:.26em;color:var(--eye);text-transform:uppercase;}
.hl{font-family:'Barlow Condensed';font-weight:800;font-size:13cqw;line-height:.88;color:var(--fg);text-transform:uppercase;letter-spacing:-.01em;}
.hl.sm{font-size:9.4cqw;}.hl.xl{font-size:14.5cqw;}
.hl-accent{color:var(--accent);}
.post.s-red .hl-accent{color:#fff;-webkit-text-stroke:.45cqw rgba(255,255,255,.0);}
.subh{font-weight:500;font-size:3cqw;line-height:1.32;color:var(--m);max-width:84cqw;}
.subh.left{text-align:left;max-width:none;}
/* hero photo */
.hero{width:100%;flex:1 1 0;min-height:0;background:#fff;border:.3cqw solid var(--boxbd);border-radius:3cqw;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 1.8cqw 4.5cqw rgba(0,0,0,.18);margin:.6cqw 0;}
.hero img{width:100%;height:100%;object-fit:contain;padding:3cqw;}
.partline{font-weight:700;font-size:2.2cqw;letter-spacing:.08em;color:var(--m);}
/* price compare */
.compare{display:flex;align-items:stretch;gap:2.4cqw;width:100%;margin-top:.6cqw;}
.cmpcell{flex:1;border-radius:2.6cqw;padding:2.8cqw 2cqw;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.cmpcell.ebay{background:var(--soft);color:var(--m);border:.3cqw solid var(--linec);}
.cmpcell.direct{background:var(--chipbg);color:var(--chiptx);}
.cmpcell .cl{font-weight:800;font-size:2cqw;letter-spacing:.16em;opacity:.85;}
.cmpcell .cv{font-family:'Barlow Condensed';font-weight:800;font-size:9.5cqw;line-height:.9;margin-top:.6cqw;}
.cmpcell .cv.strike{text-decoration:line-through;text-decoration-thickness:.4cqw;opacity:.6;}
.cmpcell .cnote{font-weight:700;font-size:2.1cqw;margin-top:.6cqw;letter-spacing:.04em;}
.cmparrow{display:flex;align-items:center;justify-content:center;}
.cmparrow .vs{display:flex;flex-direction:column;align-items:center;justify-content:center;width:9.5cqw;height:9.5cqw;border-radius:50%;background:var(--accent);color:#fff;font-family:'Barlow Condensed';font-weight:800;font-size:2.7cqw;line-height:.92;text-transform:uppercase;}
.post.s-red .cmparrow .vs{background:#fff;color:var(--red);}
/* big icon promos */
.bigicon{display:flex;align-items:center;justify-content:center;width:20cqw;height:20cqw;border-radius:50%;background:var(--soft);color:var(--accent);margin-bottom:1cqw;}
.post.s-red .bigicon{background:rgba(255,255,255,.14);color:#fff;}
.biggi{width:11cqw;height:11cqw;}
/* collage / thumbs */
.collage{display:flex;gap:2.2cqw;width:100%;margin-top:1cqw;}
.thumb{flex:1;aspect-ratio:1/1;background:#fff;border:.3cqw solid var(--boxbd);border-radius:2.4cqw;overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:0 1.4cqw 3.4cqw rgba(0,0,0,.16);}
.thumb img{width:100%;height:100%;object-fit:contain;padding:2.2cqw;}
.pillrow{display:flex;gap:2.2cqw;flex-wrap:wrap;justify-content:center;margin-top:1.4cqw;}
.ipill{display:inline-flex;align-items:center;gap:1.3cqw;font-weight:700;font-size:2.25cqw;color:var(--fg);background:var(--soft);border:.3cqw solid var(--linec);padding:1.5cqw 2.8cqw;border-radius:100px;}
.ipill .ip{width:3cqw;height:3cqw;color:var(--accent);flex:0 0 auto;}
.post.s-red .ipill{color:#fff;}.post.s-red .ipill .ip{color:#fff;}
/* showcase grid */
.grid6{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2.2cqw;width:100%;margin-top:.6cqw;}
.gcell{position:relative;aspect-ratio:1.18/1;background:#fff;border:.3cqw solid var(--boxbd);border-radius:2.2cqw;overflow:hidden;box-shadow:0 1.2cqw 3cqw rgba(0,0,0,.14);}
.gimg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.gimg img{width:100%;height:100%;object-fit:contain;padding:2.4cqw;}
.gtag{position:absolute;left:1.4cqw;bottom:1.4cqw;background:var(--chipbg);color:var(--chiptx);font-family:'Barlow Condensed';font-weight:800;font-size:3cqw;line-height:1;padding:1cqw 1.8cqw;border-radius:1.4cqw;}
.shopline{font-weight:600;font-size:2.7cqw;color:var(--m);margin-top:1.4cqw;}.shopline b{color:var(--fg);font-weight:800;}
/* trust badges */
.badges{display:flex;gap:2.2cqw;width:100%;margin-top:1cqw;}
.badge{flex:1;background:var(--soft);border:.3cqw solid var(--linec);border-radius:2.6cqw;padding:3cqw 2cqw;text-align:center;display:flex;flex-direction:column;align-items:center;gap:1cqw;}
.badge .bi{width:7cqw;height:7cqw;color:var(--accent);}
.post.s-red .badge .bi{color:#fff;}
.badge .bt{font-family:'Barlow Condensed';font-weight:800;font-size:2.8cqw;text-transform:uppercase;line-height:1;color:var(--fg);}
.badge .bd{font-weight:500;font-size:2cqw;color:var(--m);line-height:1.2;}
/* cta footer bar */
.cta{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:3cqw;border-top:.4cqw solid var(--linec);padding-top:3cqw;margin-top:1cqw;}
.cta .site{font-family:'Barlow Condensed';font-weight:800;font-size:5.6cqw;color:var(--fg);text-transform:uppercase;line-height:.9;}
.cta .csub{font-weight:600;font-size:2.15cqw;color:var(--m);margin-top:.6cqw;}
.cta-r{display:inline-flex;align-items:center;gap:1.4cqw;font-family:'Barlow Condensed';font-weight:800;font-size:4.6cqw;color:var(--fg);white-space:nowrap;}
.cta-r .ph{width:4cqw;height:4cqw;color:var(--accent);}
.post.s-red .cta-r .ph{color:#fff;}
/* cover */
.cover{flex:1 1 0;display:flex;flex-direction:column;}
.cv-mid{flex:1 1 0;display:flex;flex-direction:column;justify-content:center;gap:2.6cqw;}
.cv-foot{flex:0 0 auto;border-top:.4cqw solid var(--linec);padding-top:3cqw;display:flex;align-items:flex-end;justify-content:space-between;gap:4cqw;}
.cv-foot-l{flex:1;}
.cv-foot .site.big{font-family:'Barlow Condensed';font-weight:800;font-size:8cqw;color:var(--fg);text-transform:uppercase;line-height:.9;}
.cv-foot .csub{font-weight:600;font-size:2.3cqw;color:var(--m);margin-top:.8cqw;}
/* QR card (scannable on every scheme — always dark-on-white) */
.cta-l{flex:1;}
.qr{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:.7cqw;}
.qrbox{width:13.5cqw;height:13.5cqw;background:#fff;border-radius:1.6cqw;padding:1cqw;box-shadow:0 1cqw 2.6cqw rgba(0,0,0,.2);}
.qrbox svg{display:block;width:100%;height:100%;}
.qrl{font-weight:800;font-size:1.5cqw;letter-spacing:.1em;color:var(--fg);white-space:nowrap;}
.cover .qrbox{width:16cqw;height:16cqw;}
@page{size:1080px 1350px;margin:0;}
@media print{html,body{background:#fff !important;padding:0 !important;}h1,.ph2,.cap{display:none !important;}
 .group{display:block !important;gap:0 !important;}.stage{width:1080px !important;max-width:none !important;break-after:page;}
 .post{box-shadow:none;border:0;}}
""".replace('var(--logo-red)','url("data:image/png;base64,%RED%")').replace('var(--logo-white)','url("data:image/png;base64,%WHITE%")')
CSS = CSS.replace('%RED%', RED_LOGO).replace('%WHITE%', WHITE_LOGO)

SCHEMES=[("s-white","White · Light"),("s-red","Red · Brand"),("s-navy","Navy · Dark")]

def slide(cls, inner):
    return f'<div class="stage"><div class="post {cls}">{inner}</div></div>'

def doc(title, sections):
    """sections: list of (heading, inner_html_builder) -> inner per scheme."""
    body=[f'<h1>{H.escape(title)}</h1>',
          '<div class="cap">Razoryn e-Parts · promotional ads · White / Red / Navy · 1080×1350 · print → PDF → Canva</div>']
    for heading, inner in sections:
        body.append(f'<h2 class="ph2">{H.escape(heading)}</h2><div class="group">')
        for cls,_ in SCHEMES:
            body.append(slide(cls, inner))
        body.append('</div>')
    return ('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      f'<title>Razoryn — {H.escape(title)}</title>'
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
      f'<style>{CSS}</style></head><body>{"".join(body)}</body></html>')

# Copy rule (from the brief): stock is aftermarket — never claim "genuine"/"OEM".
import re as _re
_BANNED = _re.compile(r'\b(genuine|oem)\b', _re.I)
def check_copy(html, path):
    hits = set(m.group(0) for m in _BANNED.finditer(_re.sub(r'<[^>]+>', ' ', html)))
    if hits:
        print(f"  ⚠️  COPY RULE: {path} contains banned term(s): {', '.join(sorted(hits))}")

def write(path, html):
    check_copy(html, path)
    open(os.path.join(WORK, path),'w').write(html); return path

# ---- live product data (pulled from Shopify, tag K2010) --------------------
CDN="https://cdn.shopify.com/s/files/1/1033/6278/9714/files/"
HERO = {  # beat-ebay flagship: high-value part makes the saving land
  "title":"Yaris Cross Primed Front Bumper",
  "price":"153.44",
  "img":CDN+"57_b1844ee5-f596-4265-8a15-4ef544501ba6.png?v=1778420298",
}
THUMBS = [
  CDN+"57_b8ebe899-6220-48f2-9b2b-192b20f674a7.png?v=1778420284",
  CDN+"57_13bd1a43-1be7-4d43-b4ee-924b673313f9.png?v=1778420370",
  CDN+"57_9fea640d-7515-4a65-96dc-83b7d5896583.png?v=1778420398",
]
SHOWCASE = {
  "model":"TOYOTA YARIS CROSS 2020+", "count":18, "from":"30.22",
  "parts":[
    {"img":CDN+"57_d3a34985-af12-48a2-8ca7-17a9b77218cd.jpg?v=1778420104","price":"185.99"},
    {"img":CDN+"57_b1844ee5-f596-4265-8a15-4ef544501ba6.png?v=1778420298","price":"153.44"},
    {"img":CDN+"57_13bd1a43-1be7-4d43-b4ee-924b673313f9.png?v=1778420370","price":"120.89"},
    {"img":CDN+"57_9fea640d-7515-4a65-96dc-83b7d5896583.png?v=1778420398","price":"102.29"},
    {"img":CDN+"57_c2c8cc82-04be-4227-9244-5d6bd38533c8.png?v=1778420422","price":"83.69"},
    {"img":CDN+"57_fa21645b-2ce7-459f-a6da-4ba260bc62ba.png?v=1778420359","price":"63.70"},
  ],
}

if __name__ == "__main__":
    pile = {"imgs":THUMBS}
    SITE_URL = QR.SITE
    YC_COLLECTION = "toyota-yaris-cross-2020"   # collection handle
    links = []   # qr_links rows to register with the backend

    def site_qr(code, label="SCAN TO SHOP"):
        links.append(QR.link(code, SITE_URL, 'site', label='Razoryn storefront', utm_campaign=code))
        return qr_block(code, label)
    def coll_qr(code, handle, label):
        links.append(QR.link(code, QR.collection_url(handle), 'collection', label=label, utm_campaign=code))
        return qr_block(code, label)

    # Site-level promos -> website home; showcase -> collection page
    FILES = [
      ("promo-website-exclusive.html","Website Exclusive · Buy Direct (save 7%)",
         render_website_exclusive(HERO, qrhtml=site_qr("ig-website-exclusive"))),
      ("promo-same-day.html",         "Same-Day Dispatch · Order by 12pm",
         render_same_day(pile, qrhtml=site_qr("ig-same-day"))),
      ("promo-free-delivery.html",    "Free UK Delivery over £50",
         render_free_delivery(pile, qrhtml=site_qr("ig-free-delivery"))),
      ("promo-showcase-yaris-cross.html","Model Showcase · Yaris Cross",
         render_showcase(SHOWCASE, qrhtml=coll_qr("yaris-cross", YC_COLLECTION, "SCAN: ALL PARTS"))),
      ("promo-fitment.html",          "Fitment Support · Quality Reassurance",
         render_fitment({}, qrhtml=site_qr("ig-fitment"))),
      ("promo-brand-cover.html",      "Brand / Carousel Cover",
         render_cover({}, qrhtml=site_qr("ig-cover"))),
    ]
    for fn, heading, inner in FILES:
        write(fn, doc(heading, [(heading, inner)]))
        print("built", fn)
    # combined review sheet (all promos x 3 schemes, one print job)
    write("razoryn-promos.html", doc("Razoryn e-Parts — Promo Pack",
          [(h, inner) for _, h, inner in FILES]))
    json.dump(links, open(os.path.join(WORK,'data','qr-links-promos.json'),'w'), indent=2, ensure_ascii=False)
    print("built razoryn-promos.html  (", len(FILES), "promos x 3 schemes ); qr-links-promos.json:", len(links))
