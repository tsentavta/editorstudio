"""Generate the English site (en/index.html) from the Russian source (index.html).

index.html is the single source of truth. Every run of Cyrillic text in it (as split by
quotes, backticks, angle brackets and line breaks) is looked up in tools/en.tsv and replaced
with its English translation; then a few locale-specific bits (lang, canonical URL, number
formatting, CSV delimiter, language switch) are adjusted.

Usage:  python tools/build_en.py
After changing any Russian text in index.html, rerun the script. It fails and lists the
fragments that have no translation yet; add them to tools/en.tsv and run it again.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'index.html'
DICT = ROOT / 'tools' / 'en.tsv'
OUT = ROOT / 'en' / 'index.html'

SEGMENT = re.compile(r'[^<>"\'`\n]*[А-Яа-яЁё][^<>"\'`\n]*')
CYRILLIC = re.compile(r'[А-Яа-яЁё]')

# Code fragments that intentionally keep Russian words (yes/no input accepted in both languages).
KEEP_CYRILLIC = ['да|yes|true|1', 'нет|no|false|0']

# (old, new, expected minimum number of occurrences)
LOCALE_FIXES = [
    ('<html lang="ru">', '<html lang="en">', 1),
    ('<link rel="canonical" href="https://editorstudio.ru/doaj/">', '<link rel="canonical" href="https://editorstudio.ru/doaj/en/">', 1),
    ('<meta property="og:url" content="https://editorstudio.ru/doaj/">', '<meta property="og:url" content="https://editorstudio.ru/doaj/en/">', 1),
    ('<meta property="og:locale" content="ru_RU">', '<meta property="og:locale" content="en_US">', 1),
    ('"url": "https://editorstudio.ru/doaj/",', '"url": "https://editorstudio.ru/doaj/en/",', 1),
    ('"inLanguage": "ru"', '"inLanguage": "en"', 1),
    ("toLocaleString('ru')", "toLocaleString('en')", 1),
    ("'№ ' + j.number", "'no. ' + j.number", 1),
    # links to the guides (header and "About" section)
    ('href="/doaj/guides/', 'href="/doaj/en/guides/', 6),
    # og:image, twitter:image and JSON-LD screenshot
    ('/docs/screenshot-search.jpg', '/docs/screenshot-search-en.jpg', 3),
    # English-locale Excel expects a comma
    ('<option value=",">', '<option value="," selected>', 1),
]
LANG_SWITCH = (
    '<a class="langsw" href="/doaj/en/" hreflang="en" lang="en" title="English version">EN</a>',
    '<a class="langsw" href="/doaj/" hreflang="ru" lang="ru" title="Русская версия">RU</a>',
)


def load_dict():
    tr = {}
    for n, line in enumerate(DICT.read_text(encoding='utf-8').splitlines(), 1):
        if not line or line.startswith('#'):
            continue
        if '\t' not in line:
            sys.exit(f'{DICT.name}:{n}: no tab separator')
        ru, en = line.split('\t', 1)
        tr[ru] = en
    return tr


def main():
    tr = load_dict()
    html = SRC.read_text(encoding='utf-8')
    missing = []

    def sub(m):
        s = m.group(0)
        core = s.strip()
        if core not in tr:
            missing.append(core)
            return s
        lead = s[:len(s) - len(s.lstrip())]
        trail = s[len(s.rstrip()):]
        return lead + tr[core] + trail

    out = SEGMENT.sub(sub, html)
    if missing:
        print('No translation in tools/en.tsv for:', file=sys.stderr)
        for s in dict.fromkeys(missing):
            print('  ' + s, file=sys.stderr)
        sys.exit(1)

    for old, new, at_least in LOCALE_FIXES:
        if out.count(old) < at_least:
            sys.exit(f'Locale fix not applied, source changed? {old!r}')
        out = out.replace(old, new)

    rest = out
    for keep in KEEP_CYRILLIC:
        rest = rest.replace(keep, '')
    leftover = sorted({m.group(0) for m in re.finditer(r'.{0,20}[А-Яа-яЁё].{0,20}', rest)})
    if leftover:
        sys.exit('Untranslated Cyrillic left:\n  ' + '\n  '.join(leftover))

    if LANG_SWITCH[0] not in out:
        sys.exit('Language switch link not found in index.html')
    out = out.replace(*LANG_SWITCH)

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(out, encoding='utf-8', newline='\n')
    print(f'Wrote {OUT.relative_to(ROOT)} ({len(tr)} translations)')


if __name__ == '__main__':
    main()
