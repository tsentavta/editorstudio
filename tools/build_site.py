"""Build the EditorStudio static site from one checkout."""

import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERIFICATION_FILE = re.compile(r"(?:google[0-9a-f]+|yandex_[0-9a-f]+)\.html")
BODY_TAG = re.compile(rb"<body\b[^>]*>", re.IGNORECASE)


def install_metrika(out):
    snippet = (ROOT / "tools" / "yandex_metrika.html").read_bytes().strip()
    for page in out.rglob("*.html"):
        if VERIFICATION_FILE.fullmatch(page.name):
            continue
        content = page.read_bytes()
        body = BODY_TAG.search(content)
        if body is None or b"<!-- Yandex.Metrika counter -->" in content:
            raise ValueError(f"Cannot install Metrika in {page.relative_to(out)}")
        start = body.end()
        page.write_bytes(content[:start] + b"\n" + snippet + b"\n" + content[start:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "_site")
    parser.add_argument("--site", default="editorstudio.ru")
    args = parser.parse_args()

    out = args.out.resolve()
    sources = [ROOT / name for name in ("site", "static", "doaj")]
    if out == ROOT or out in ROOT.parents or any(
        out == source or out in source.parents or source in out.parents
        for source in sources
    ):
        parser.error("--out must not overlap the source tree")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(sources[0], out)
    shutil.copytree(sources[1], out / "metafora")
    shutil.copytree(sources[2], out / "doaj", ignore=shutil.ignore_patterns(
        "tools", "guides-src", "CHANGELOG.md", "__pycache__"
    ))
    if args.site == "editorstudio.ru":
        install_metrika(out)
    (out / "CNAME").write_text(args.site + "\n", encoding="utf-8")
    (out / ".nojekyll").touch()


if __name__ == "__main__":
    main()
