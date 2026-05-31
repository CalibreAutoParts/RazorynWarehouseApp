#!/usr/bin/env python3
"""QR helpers for the Razoryn ad builders.

Each QR links DIRECTLY to its destination page (product / collection / storefront).
No redirect, no tracking, no backend — scanning just opens the page in a browser.
"""
import io, os, re
import segno

SITE = os.environ.get("SITE_URL", "https://www.razoryn.co.uk").rstrip("/")
QR_DARK = "#0f1318"   # dark-on-white so it scans on every scheme (the card supplies the white)

def qr_svg(data, dark=QR_DARK):
    """Inline, responsive SVG QR (viewBox only — sized by CSS)."""
    q = segno.make(data, error="m")
    n = q.symbol_size(border=3)[0]
    buf = io.BytesIO(); q.save(buf, kind="svg", border=3, dark=dark, light=None)
    s = buf.getvalue().decode()
    s = re.sub(r'<\?xml[^>]*\?>\s*', '', s)
    s = re.sub(r'\swidth="\d+(?:\.\d+)?"', '', s, count=1)
    s = re.sub(r'\sheight="\d+(?:\.\d+)?"', '', s, count=1)
    s = s.replace('<svg ', f'<svg viewBox="0 0 {n} {n}" preserveAspectRatio="xMidYMid meet" ', 1)
    return s

def product_url(handle):    return f"{SITE}/products/{handle}"
def collection_url(handle): return f"{SITE}/collections/{handle}"
