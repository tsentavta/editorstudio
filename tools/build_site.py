"""Build the EditorStudio static site from one checkout."""

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
    (out / "CNAME").write_text(args.site + "\n", encoding="utf-8")
    (out / ".nojekyll").touch()


if __name__ == "__main__":
    main()
