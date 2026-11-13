"""Сборка сайта editorstudio.ru.

Собирает в одну папку:
    /            стартовая страница (site/)
    /metafora/   консоль API «Метафоры» (static/)
    /doaj/       DOAJ Metadata Studio (репозиторий tsentavta/doajmds)

doajmds рассчитан на корень своего домена, поэтому при копировании
ссылки от корня ("/guides/", "/favicon.svg", "/en/") переписываются
на "/doaj/...". Абсолютные адреса https://doajmds.site/ (canonical,
og:url, hreflang) по умолчанию не трогаются: для поисковиков
/doaj/ остаётся зеркалом doajmds.site. Ключ --doaj-canonical
переводит их на editorstudio.ru/doaj/.

Пример:
    python tools/build_site.py --doaj ../doajmds --out _site
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOAJ_PREFIX = "/doaj"

# Что из doajmds на сайт не попадает: исходники, служебные и
# доменно-специфичные файлы (robots, sitemap, верификация Яндекса).
DOAJ_SKIP_DIRS = {".git", ".github", "tools", "guides-src"}
DOAJ_SKIP_FILES = {"CNAME", "README.md", "README.en.md", "CHANGELOG.md",
                   "robots.txt", "sitemap.xml", ".gitignore", ".nojekyll"}
DOAJ_SKIP_PATTERNS = [re.compile(r"^yandex_[0-9a-f]+\.html$"),
                      re.compile(r"^google[0-9a-f]+\.html$")]

# href="/x", src="/x", content="/x", action="/x" — но не "//cdn..."
ATTR_RE = re.compile(r'\b(href|src|content|action|poster|data-href)=(["\'])/(?!/)')
SRCSET_RE = re.compile(r'\bsrcset=(["\'])([^"\']*)\1')
CSS_URL_RE = re.compile(r'url\((["\']?)/(?!/)')
MANIFEST_RE = re.compile(r'("(?:start_url|scope|src)"\s*:\s*")/(?!/)')


def rewrite_html(text: str) -> str:
    text = ATTR_RE.sub(lambda m: f'{m.group(1)}={m.group(2)}{DOAJ_PREFIX}/', text)
    text = SRCSET_RE.sub(lambda m: "srcset=%s%s%s" % (
        m.group(1),
        re.sub(r'(^|,\s*)/(?!/)', lambda n: n.group(1) + DOAJ_PREFIX + "/", m.group(2)),
        m.group(1)), text)
    return CSS_URL_RE.sub(lambda m: f'url({m.group(1)}{DOAJ_PREFIX}/', text)


def rewrite_canonical(text: str, site: str) -> str:
    return text.replace("https://doajmds.site/", f"https://{site}{DOAJ_PREFIX}/")


def skip_doaj(rel: Path) -> bool:
    if any(part in DOAJ_SKIP_DIRS for part in rel.parts):
        return True
    if len(rel.parts) == 1:
        name = rel.name
        if name in DOAJ_SKIP_FILES or any(p.match(name) for p in DOAJ_SKIP_PATTERNS):
            return True
    return False


def copy_doaj(src: Path, dst: Path, site: str, canonical: bool) -> int:
    rewritten = 0
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(src)
        if skip_doaj(rel):
            continue
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if f.suffix in {".html", ".css", ".webmanifest"}:
            text = f.read_text(encoding="utf-8")
            new = MANIFEST_RE.sub(lambda m: m.group(1) + DOAJ_PREFIX + "/", text) \
                if f.suffix == ".webmanifest" else rewrite_html(text)
            if canonical:
                new = rewrite_canonical(new, site)
            rewritten += new != text
            out.write_text(new, encoding="utf-8", newline="\n")
        else:
            shutil.copy2(f, out)
    return rewritten


def check_doaj(dst: Path) -> list:
    """Ссылки от корня, оставшиеся без префикса /doaj/ (должно быть пусто)."""
    bad = []
    leftover = re.compile(r'\b(?:href|src|content|action)=["\']/(?!/|doaj/)')
    for f in dst.rglob("*.html"):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if leftover.search(line):
                bad.append(f"{f.relative_to(dst)}:{i}")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--doaj", required=True, type=Path, help="папка с клоном tsentavta/doajmds")
    ap.add_argument("--out", default=ROOT / "_site", type=Path, help="куда собрать сайт")
    ap.add_argument("--site", default="editorstudio.ru", help="домен сайта (для CNAME)")
    ap.add_argument("--doaj-canonical", action="store_true",
                    help="перевести canonical/og/hreflang doajmds на editorstudio.ru/doaj/")
    args = ap.parse_args()

    if not (args.doaj / "index.html").is_file():
        sys.exit(f"Не найден {args.doaj / 'index.html'} — укажите клон doajmds в --doaj")

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    shutil.copytree(ROOT / "site", out, dirs_exist_ok=True)
    shutil.copytree(ROOT / "static", out / "metafora")
    n = copy_doaj(args.doaj, out / "doaj", args.site, args.doaj_canonical)

    (out / "CNAME").write_text(args.site + "\n", encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    bad = check_doaj(out / "doaj")
    if bad:
        print("Остались ссылки от корня без /doaj/:\n  " + "\n  ".join(bad[:30]))
        sys.exit(1)
    files = sum(1 for p in out.rglob("*") if p.is_file())
    print(f"Готово: {out}  ·  файлов {files}  ·  в doaj переписано {n}")


if __name__ == "__main__":
    main()
