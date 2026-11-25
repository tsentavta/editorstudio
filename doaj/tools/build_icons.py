"""Generate the site icons (favicon.svg, favicon.ico, PNGs) without third-party libraries.

The icon is an orange rounded square with a white geometric "D". The same shape is drawn
as SVG and rasterised here with 4x4 supersampling, so every size looks identical and does
not depend on installed fonts.

Usage:  python tools/build_icons.py
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG = (0xE2, 0x50, 0x2E)
FG = (0xFF, 0xFF, 0xFF)

# Shape in unit coordinates (0..1)
RADIUS = 0.22                      # corner radius of the square
X0, Y0, Y1 = 0.29, 0.21, 0.79      # left edge, top and bottom of the "D"
CX, CY, RX, RY = 0.47, 0.5, 0.26, 0.29   # centre and radii of the bowl
STROKE = 0.135


def in_square(x, y):
    r = RADIUS
    dx = max(r - x, 0, x - (1 - r))
    dy = max(r - y, 0, y - (1 - r))
    return dx * dx + dy * dy <= r * r


def in_d(x, y, inset=0.0):
    x0, y0, y1, rx, ry = X0 + inset, Y0 + inset, Y1 - inset, RX - inset, RY - inset
    if x0 <= x <= CX and y0 <= y <= y1:
        return True
    return x >= CX and ((x - CX) / rx) ** 2 + ((y - CY) / ry) ** 2 <= 1


def letter(x, y):
    return in_d(x, y) and not in_d(x, y, STROKE)


def render(size, ss=4):
    rows = []
    n = ss * ss
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if in_square(x, y):
                        if letter(x, y):
                            fg += 1
                        else:
                            bg += 1
            cover = bg + fg
            if cover:
                rgb = [round((BG[i] * bg + FG[i] * fg) / cover) for i in range(3)]
                row += bytes(rgb + [round(255 * cover / n)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return png(size, b''.join(rows))


def png(size, raw):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def ico(images):
    """ICO container with embedded PNG images (supported by all current browsers and crawlers)."""
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b'', b''
    for size, blob in images:
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    return head + entries + data


def svg():
    r, s = RADIUS, STROKE
    f = lambda v: f'{round(v, 4):g}'
    ox, iy0, iy1 = f(X0 + s), f(Y0 + s), f(Y1 - s)
    # outer contour clockwise, inner contour counter-clockwise -> hole via evenodd
    d = (f'M{f(X0)} {f(Y0)}H{f(CX)}A{f(RX)} {f(RY)} 0 0 1 {f(CX)} {f(Y1)}H{f(X0)}Z'
         f'M{ox} {iy0}V{iy1}H{f(CX)}A{f(RX - s)} {f(RY - s)} 0 0 0 {f(CX)} {iy0}Z')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">'
            f'<rect width="1" height="1" rx="{r}" fill="#e2502e"/>'
            f'<path fill="#fff" fill-rule="evenodd" d="{d}"/></svg>\n')


def main():
    (ROOT / 'favicon.svg').write_text(svg(), encoding='utf-8')
    pngs = {s: render(s) for s in (16, 32, 48, 96, 180, 192, 512)}
    (ROOT / 'favicon.ico').write_bytes(ico([(s, pngs[s]) for s in (16, 32, 48)]))
    (ROOT / 'favicon-96.png').write_bytes(pngs[96])
    (ROOT / 'apple-touch-icon.png').write_bytes(pngs[180])
    (ROOT / 'icon-192.png').write_bytes(pngs[192])
    (ROOT / 'icon-512.png').write_bytes(pngs[512])
    (ROOT / 'site.webmanifest').write_text(MANIFEST, encoding='utf-8')
    print('icons written')


MANIFEST = '''{
  "name": "DOAJ Metadata Studio",
  "short_name": "DOAJ MDS",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#e2502e",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml" }
  ]
}
'''


if __name__ == '__main__':
    main()
