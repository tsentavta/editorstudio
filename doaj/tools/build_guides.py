"""Generate the guide pages (/guides/, /en/guides/) and sitemap.xml.

Each guide is written once per language in guides-src/<slug>.<lang>.html:

    title: Page title (also the H1)
    description: Meta description, about 150 characters
    updated: 2026-10-28
    ---
    <p>HTML body…</p>

This script wraps every file in the shared page template (meta tags, canonical, hreflang,
Open Graph, schema.org Article + BreadcrumbList, header, related guides, footer), writes
guides/<slug>/index.html and en/guides/<slug>/index.html plus both guide indexes, and
regenerates sitemap.xml for the whole site.

Usage:  python tools/build_guides.py
"""
import datetime
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'guides-src'
SITE = 'https://editorstudio.ru/doaj'

# Order shown in the guide index and in "Other guides"
GUIDES = ['upload-articles', 'bulk-upload-csv', 'missing-doi-orcid', 'export-articles', 'api-search-syntax']

LANGS = {
    'ru': {
        'prefix': '/', 'locale': 'ru_RU', 'app': 'Открыть приложение', 'guides': 'Инструкции',
        'home': 'DOAJ Metadata Studio', 'other': 'Другие инструкции', 'updated': 'Обновлено',
        'index_title': 'Инструкции по работе с DOAJ',
        'index_desc': 'Пошаговые инструкции для редакторов журналов: загрузка статей в DOAJ, массовая загрузка из Excel, поиск пропусков в метаданных, экспорт и поиск через DOAJ API.',
        'index_lead': 'Практические инструкции для редакторов и издателей журналов открытого доступа. Каждая инструкция проверена на живом DOAJ API и ведёт в DOAJ Metadata Studio – бесплатный инструмент, где описанное можно сделать в пару кликов.',
        'switch': ('EN', 'English version'),
        'disclaimer': 'Неофициальный инструмент, не связан с <a href="https://doaj.org" rel="noopener">DOAJ</a> (Directory of Open Access Journals).',
        'source': 'Исходный код', 'license': 'Лицензия MIT',
        'months': ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    },
    'en': {
        'prefix': '/en/', 'locale': 'en_US', 'app': 'Open the app', 'guides': 'Guides',
        'home': 'DOAJ Metadata Studio', 'other': 'Other guides', 'updated': 'Updated',
        'index_title': 'Guides to working with DOAJ',
        'index_desc': 'Step-by-step guides for journal editors: uploading articles to DOAJ, bulk upload from Excel, finding metadata gaps, exporting and searching with the DOAJ API.',
        'index_lead': 'Practical guides for editors and publishers of open access journals. Every guide was checked against the live DOAJ API and links to DOAJ Metadata Studio – a free tool where you can do what is described in a couple of clicks.',
        'switch': ('RU', 'Русская версия'),
        'disclaimer': 'Unofficial tool, not affiliated with <a href="https://doaj.org" rel="noopener">DOAJ</a> (Directory of Open Access Journals).',
        'source': 'Source code', 'license': 'MIT License',
        'months': None,
    },
}


def other(lang):
    return 'en' if lang == 'ru' else 'ru'


def guides_path(lang, slug=None):
    base = LANGS[lang]['prefix'] + 'guides/'
    return base + (slug + '/' if slug else '')


def fmt_date(lang, iso):
    d = datetime.date.fromisoformat(iso)
    months = LANGS[lang]['months']
    if months:
        return f'{d.day} {months[d.month - 1]} {d.year}'
    return f'{d.strftime("%B")} {d.day}, {d.year}'


def read_source(slug, lang):
    path = SRC / f'{slug}.{lang}.html'
    text = path.read_text(encoding='utf-8')
    head, sep, body = text.partition('\n---\n')
    if not sep:
        sys.exit(f'{path.name}: missing "---" separator after the header')
    meta = {}
    for line in head.splitlines():
        if line.strip():
            key, _, value = line.partition(':')
            meta[key.strip()] = value.strip()
    for key in ('title', 'description', 'updated'):
        if key not in meta:
            sys.exit(f'{path.name}: missing "{key}"')
    meta['body'] = body.strip()
    return meta


def alternates(path_ru, path_en):
    return (f'<link rel="alternate" hreflang="ru" href="{SITE}{path_ru}">\n'
            f'<link rel="alternate" hreflang="en" href="{SITE}{path_en}">\n'
            f'<link rel="alternate" hreflang="x-default" href="{SITE}{path_en}">')


def page(lang, path, alt_path, title, description, h1, body, crumbs, json_ld, updated=None):
    L = LANGS[lang]
    esc = html.escape
    switch_label, switch_title = L['switch']
    path_ru, path_en = (path, alt_path) if lang == 'ru' else (alt_path, path)
    crumb_items = [('EditorStudio', '__EDITORSTUDIO_HOME__'), *crumbs]
    crumb_html = ''.join(
        f'<li><a href="{href or path}"' + (' aria-current="page"' if not href else '') + f'>{esc(name)}</a></li>'
        for name, href in crumb_items)
    crumb_label = 'Хлебные крошки' if lang == 'ru' else 'Breadcrumbs'
    updated_html = f'<p class="updated">{L["updated"]}: <time datetime="{updated}">{fmt_date(lang, updated)}</time></p>' if updated else ''
    return f'''<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{SITE}{path}">
{alternates(path_ru, path_en)}
<meta name="theme-color" content="#e2502e">
<meta property="og:type" content="article">
<meta property="og:site_name" content="DOAJ Metadata Studio">
<meta property="og:locale" content="{L["locale"]}">
<meta property="og:url" content="{SITE}{path}">
<meta property="og:title" content="{esc(h1)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:image" content="{SITE}/docs/screenshot-audit{'-en' if lang == 'en' else ''}.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/assets/guides.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="__EDITORSTUDIO_THEME__">
<link rel="stylesheet" href="/editorstudio.css">
<script>try{{const t=JSON.parse(localStorage.getItem('doajs.theme'));if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}}catch(e){{}}</script>
<script type="application/ld+json">
{json.dumps(json_ld, ensure_ascii=False, indent=1)}
</script>
</head>
<body>
<header class="top">
  <div class="bar">
    <a class="brand" href="{L["prefix"]}"><img width="24" height="24" src="/favicon.svg" alt="">EditorStudio / DOAJ</a>
    <nav>
      <a href="{guides_path(lang)}">{L["guides"]}</a>
      <a class="cta" href="{L["prefix"]}">{L["app"]}</a>
      <a class="langsw" href="{alt_path}" hreflang="{other(lang)}" lang="{other(lang)}" title="{switch_title}">{switch_label}</a>
    </nav>
  </div>
</header>
<main class="guide">
  <nav class="breadcrumbs" aria-label="{crumb_label}"><ol>{crumb_html}</ol></nav>
  <h1>{esc(h1)}</h1>{chr(10) + "  " + updated_html if updated_html else ""}
  {body}
</main>
<footer>
  <span>{L["disclaimer"]}</span>
  <a href="https://github.com/tsentavta/editorstudio" rel="noopener">{L["source"]}</a>
  <span>{L["license"]}</span>
</footer>
</body>
</html>
'''


def breadcrumb_ld(items):
    return {'@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': name, 'item': SITE + href}
        for i, (name, href) in enumerate(items)]}


def build_guide(slug, lang, src, all_src):
    L = LANGS[lang]
    path, alt = guides_path(lang, slug), guides_path(other(lang), slug)
    related = ''.join(
        f'<li><a href="{guides_path(lang, s)}">{html.escape(all_src[(s, lang)]["title"])}</a></li>'
        for s in GUIDES if s != slug)
    body = src['body'] + f'\n  <section class="related">\n    <h2>{L["other"]}</h2>\n    <ul>{related}</ul>\n  </section>'
    crumbs = [(L['home'], L['prefix']), (L['guides'], guides_path(lang)), (src['title'], None)]
    json_ld = {'@context': 'https://schema.org', '@graph': [
        {'@type': 'Article', 'headline': src['title'], 'description': src['description'], 'inLanguage': lang,
         'datePublished': src.get('published', src['updated']), 'dateModified': src['updated'],
         'mainEntityOfPage': SITE + path, 'image': f'{SITE}/docs/screenshot-audit{"-en" if lang == "en" else ""}.jpg',
         'author': {'@type': 'Person', 'name': 'tsentavta', 'url': 'https://github.com/tsentavta'},
         'publisher': {'@type': 'Organization', 'name': 'DOAJ Metadata Studio', 'url': SITE + L['prefix'],
                       'logo': {'@type': 'ImageObject', 'url': SITE + '/icon-512.png'}}},
        breadcrumb_ld([(L['home'], L['prefix']), (L['guides'], guides_path(lang)), (src['title'], path)]),
    ]}
    # Search results cut titles at about 65 characters: add the site name only when it fits
    title = src['title'] + (' – DOAJ Metadata Studio' if len(src['title']) <= 42 else '')
    return path, page(lang, path, alt, title, src['description'], src['title'], body, crumbs, json_ld, src['updated'])


def build_index(lang, all_src):
    L = LANGS[lang]
    path, alt = guides_path(lang), guides_path(other(lang))
    items = ''.join(
        f'<li><a href="{guides_path(lang, s)}"><b>{html.escape(all_src[(s, lang)]["title"])}</b></a>'
        f'<p>{html.escape(all_src[(s, lang)]["description"])}</p></li>' for s in GUIDES)
    body = f'<p class="lead">{L["index_lead"]}</p>\n  <ul class="index">{items}</ul>'
    crumbs = [(L['home'], L['prefix']), (L['guides'], None)]
    json_ld = {'@context': 'https://schema.org', '@graph': [
        {'@type': 'CollectionPage', 'name': L['index_title'], 'description': L['index_desc'], 'inLanguage': lang, 'url': SITE + path},
        breadcrumb_ld([(L['home'], L['prefix']), (L['guides'], path)]),
    ]}
    return path, page(lang, path, alt, f'{L["index_title"]} – DOAJ Metadata Studio', L['index_desc'],
                      L['index_title'], body, crumbs, json_ld)


def sitemap(pairs):
    """pairs: list of (ru_path, en_path, lastmod)"""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
    for ru, en, lastmod in pairs:
        for loc in (ru, en):
            out += ['  <url>', f'    <loc>{SITE}{loc}</loc>', f'    <lastmod>{lastmod}</lastmod>',
                    f'    <xhtml:link rel="alternate" hreflang="ru" href="{SITE}{ru}"/>',
                    f'    <xhtml:link rel="alternate" hreflang="en" href="{SITE}{en}"/>',
                    f'    <xhtml:link rel="alternate" hreflang="x-default" href="{SITE}{en}"/>', '  </url>']
    out.append('</urlset>')
    return '\n'.join(out) + '\n'


def write(path, content):
    target = ROOT / path.lstrip('/') / 'index.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(re.sub(r'((?:href|src)=")/(?!/)', lambda m: m[0] if content[m.end():].startswith("favicon.svg") and m[1] == 'src="' else m[1] + "/doaj/", content).replace('__EDITORSTUDIO_HOME__', '/').replace('__EDITORSTUDIO_THEME__', '/theme.css'), encoding='utf-8', newline='\n')


def main():
    all_src = {(s, lang): read_source(s, lang) for s in GUIDES for lang in LANGS}
    latest = max(src['updated'] for src in all_src.values())
    for lang in LANGS:
        write(*build_index(lang, all_src))
        for slug in GUIDES:
            write(*build_guide(slug, lang, all_src[(slug, lang)], all_src))
    pairs = [('/', '/en/', latest), (guides_path('ru'), guides_path('en'), latest)]
    pairs += [(guides_path('ru', s), guides_path('en', s), all_src[(s, 'ru')]['updated']) for s in GUIDES]
    (ROOT / 'sitemap.xml').write_text(sitemap(pairs), encoding='utf-8', newline='\n')
    print(f'Wrote {len(GUIDES) * 2} guides, 2 indexes and sitemap.xml ({len(pairs) * 2} URLs)')


if __name__ == '__main__':
    main()
