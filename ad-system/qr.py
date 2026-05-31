#!/usr/bin/env python3
"""Shared QR helpers for the Razoryn ad builders.

Every QR encodes a *dynamic redirect* — `<QR_BASE>/go/<code>` — not the destination
directly. The razoryn-backend `/go/:code` route logs the scan and 302-redirects to
the real target (product / collection / site) with UTM tags appended, so:
  • scan count   = rows in qr_scans for that code   (owned by us, free)
  • conversion   = Shopify orders attributed to utm_content=<code>

`QR_BASE` must resolve to the backend (e.g. a `go.razoryn.co.uk` subdomain or a
reverse-proxy rule that sends /go/* to the Express app). Override via env QR_BASE_URL.
`SITE` is the public Shopify storefront the redirect lands on.
"""
import io, os, re
import segno

QR_BASE = os.environ.get("QR_BASE_URL", "https://go.razoryn.co.uk").rstrip("/")
SITE    = os.environ.get("SITE_URL", "https://www.razoryn.co.uk").rstrip("/")
QR_DARK = "#0f1318"   # always dark-on-white (the card supplies the white) so it scans on every scheme

def go_url(code):
    return f"{QR_BASE}/go/{code}"

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

def product_url(handle): return f"{SITE}/products/{handle}"
def collection_url(handle): return f"{SITE}/collections/{handle}"

def link(code, target_url, kind, label=None, utm_campaign=None):
    """A row for qr_links — POST these to the backend /api/qr/import."""
    return {"code": code, "target_url": target_url, "kind": kind,
            "label": label, "utm_campaign": utm_campaign}
