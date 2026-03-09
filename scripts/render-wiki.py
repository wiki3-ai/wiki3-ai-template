#!/usr/bin/env python3
"""Standalone wiki renderer for gh-pages.

Converts notebooks in files/ to wiki HTML pages, generates index pages
and nav.json.  Designed to run inside the gh-pages tree (the JupyterLite
_output directory) without the full JupyterLite build infrastructure.

Usage:
    python .wiki-build/render.py                     # re-render everything
    python .wiki-build/render.py python.ipynb         # one notebook (relative to files/)
    python .wiki-build/render.py --templates-dir DIR  # custom template location

Dependencies: nbconvert nbformat jinja2
"""
from __future__ import annotations

import argparse
import html as html_mod
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote

from jinja2 import Environment, FileSystemLoader
import nbformat
from nbconvert import HTMLExporter

# ---------------------------------------------------------------------------
# Paths — resolved at parse time
# ---------------------------------------------------------------------------
ROOT: Path = None       # type: ignore[assignment]
FILES_DIR: Path = None  # type: ignore[assignment]
WIKI_DIR: Path = None   # type: ignore[assignment]
TEMPLATE_DIR: Path = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def extract_title(nb, notebook_path: Path) -> str:
    """Pull the first markdown heading from a notebook."""
    try:
        for cell in nb.cells:
            if cell.get("cell_type") != "markdown":
                continue
            for line in (cell.get("source") or "").splitlines():
                stripped = line.strip()
                if stripped.startswith("#"):
                    return stripped.lstrip("#").strip()
        return notebook_path.stem.replace("-", " ").replace("_", " ").title()
    except Exception:
        return notebook_path.stem


# ---------------------------------------------------------------------------
# Notebook → HTML
# ---------------------------------------------------------------------------
def convert_notebook(notebook_path: Path) -> None:
    """Convert a single notebook to a wiki HTML page."""
    rel_path = notebook_path.relative_to(FILES_DIR)
    output_file = WIKI_DIR / rel_path.with_suffix(".html")
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(notebook_path, "r", encoding="utf-8") as f:
        nb = nbformat.read(f, as_version=4)

    title = extract_title(nb, notebook_path)
    rel_path_url = quote(rel_path.as_posix(), safe="/")
    static_output = output_file.relative_to(ROOT)

    # Breadcrumbs for nested notebooks
    breadcrumbs = []
    parent_parts = list(rel_path.parent.parts)
    if parent_parts and parent_parts != ["."]:
        for i, part in enumerate(parent_parts):
            levels_up = len(parent_parts) - i
            rel_href = "../" * levels_up + "index.html" if i < len(parent_parts) - 1 else "index.html"
            breadcrumbs.append({"name": part, "href": rel_href})

    exporter = HTMLExporter(
        template_name="wiki",
        extra_template_basedirs=[str(TEMPLATE_DIR)],
    )

    resources = {
        "metadata": {"name": notebook_path.stem},
        "wiki_toolbar": {
            "title": title,
            "home_href": "/",
            "breadcrumbs": breadcrumbs,
            "actions": [
                {"kind": "link", "label": "edit",
                 "href": f"/notebooks/index.html?path={rel_path_url}",
                 "new_tab": True, "download": False},
                {"kind": "link", "label": "lab",
                 "href": f"/lab/index.html?path={rel_path_url}",
                 "new_tab": True, "download": False},
                {"kind": "link", "label": "down",
                 "href": f"/files/{rel_path_url}",
                 "new_tab": False, "download": True},
                {"kind": "button", "label": "share",
                 "share_href": "/" + quote(static_output.as_posix(), safe="/"),
                 "aria_label": "Copy share link"},
            ],
        },
        "wiki_behavior_script_url": "/static/wiki_behavior.js",
    }

    body, _ = exporter.from_notebook_node(nb, resources=resources)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(body)
    print(f"  rendered {rel_path} → {output_file.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# Index pages
# ---------------------------------------------------------------------------
def generate_index_page(current_dir: Path) -> None:
    """Generate an index/listing page for *current_dir* (relative to wiki/)."""
    index_location = WIKI_DIR / current_dir
    relative_root = Path(os.path.relpath(ROOT, index_location))
    theme_base = relative_root / "build" / "themes" / "@jupyterlab"
    light_css = (theme_base / "theme-light-extension" / "index.css").as_posix()
    dark_css = (theme_base / "theme-dark-extension" / "index.css").as_posix()

    wiki_root = Path(os.path.relpath(WIKI_DIR, index_location)).as_posix()
    if wiki_root == ".":
        wiki_root = ""

    # Breadcrumbs
    breadcrumbs = []
    if current_dir != Path("."):
        parts = list(current_dir.parts)
        for i in range(len(parts)):
            part_path = Path(*parts[: i + 1]) if i > 0 else Path(parts[0])
            rel_to_crumb = Path(os.path.relpath(WIKI_DIR / part_path, index_location))
            breadcrumbs.append({
                "name": parts[i],
                "href": (rel_to_crumb / "index.html").as_posix(),
            })

    # HTML files in this directory (excluding index.html)
    current_wiki_dir = WIKI_DIR / current_dir
    html_files = [f for f in current_wiki_dir.glob("*.html") if f.name != "index.html"]

    # Immediate subdirectories with content
    subdirs = []
    if current_wiki_dir.exists():
        for subdir in sorted(current_wiki_dir.iterdir()):
            if subdir.is_dir() and any(subdir.rglob("*.html")):
                subdirs.append({
                    "name": subdir.name,
                    "href": quote(subdir.name, safe="") + "/index.html",
                })

    # Build template entries
    entries = []
    for html_file in sorted(html_files, key=lambda f: f.name):
        html_rel = html_file.relative_to(WIKI_DIR)
        nb_rel = html_rel.with_suffix(".ipynb")
        notebook_path = FILES_DIR / nb_rel

        title = nb_rel.stem.replace("-", " ").replace("_", " ").title()
        if notebook_path.exists():
            try:
                with open(notebook_path, "r", encoding="utf-8") as f:
                    nb = nbformat.read(f, as_version=4)
                title = extract_title(nb, notebook_path)
            except Exception:
                pass

        rel_display = html_mod.escape(html_file.stem)
        html_href = quote(html_file.name, safe="")
        rel_path_url = quote(nb_rel.as_posix(), safe="/")
        static_output = html_file.relative_to(ROOT)
        static_href = "/" + quote(static_output.as_posix(), safe="/")

        entries.append({
            "html_href": html_href,
            "edit_href": f"/notebooks/index.html?path={rel_path_url}",
            "lab_href": f"/lab/index.html?path={rel_path_url}",
            "download_href": f"/files/{rel_path_url}",
            "static_href": static_href,
            "title_attr": html_mod.escape(title),
            "rel_display": rel_display,
        })

    env = Environment(loader=FileSystemLoader(str(TEMPLATE_DIR)), autoescape=True)
    template = env.get_template("wiki_index.html.j2")

    if current_dir == Path("."):
        toolbar_title = "Wiki3.ai index"
        page_title = "Wiki Index"
    else:
        toolbar_title = current_dir.name
        page_title = f"Wiki Index - {current_dir.name}"

    index_html = template.render(
        title=page_title,
        toolbar_title=toolbar_title,
        light_css=light_css,
        dark_css=dark_css,
        entries=entries,
        subdirs=subdirs,
        breadcrumbs=breadcrumbs,
        wiki_root=wiki_root,
        behavior_script_url="/static/wiki_behavior.js",
    )

    index_file = index_location / "index.html"
    index_file.parent.mkdir(parents=True, exist_ok=True)
    with open(index_file, "w", encoding="utf-8") as f:
        f.write(index_html)
    print(f"  index {current_dir.as_posix()}/index.html")


# ---------------------------------------------------------------------------
# nav.json
# ---------------------------------------------------------------------------
def build_nav_tree(current_dir: Path) -> dict:
    current_wiki_dir = WIKI_DIR / current_dir
    pages = []
    for html_file in sorted(
        (f for f in current_wiki_dir.glob("*.html") if f.name != "index.html"),
        key=lambda f: f.name,
    ):
        html_rel = html_file.relative_to(WIKI_DIR)
        nb_rel = html_rel.with_suffix(".ipynb")
        notebook_path = FILES_DIR / nb_rel

        title = nb_rel.stem.replace("-", " ").replace("_", " ").title()
        if notebook_path.exists():
            try:
                with open(notebook_path, "r", encoding="utf-8") as f:
                    nb = nbformat.read(f, as_version=4)
                title = extract_title(nb, notebook_path)
            except Exception:
                pass
        pages.append({
            "title": title,
            "href": "/wiki/" + quote(html_rel.as_posix(), safe="/"),
        })

    dirs = []
    for subdir in sorted(current_wiki_dir.iterdir()):
        if subdir.is_dir() and any(subdir.rglob("*.html")):
            child_rel = subdir.relative_to(WIKI_DIR)
            child_tree = build_nav_tree(child_rel)
            dirs.append({
                "name": subdir.name,
                "href": "/wiki/" + quote((child_rel / "index.html").as_posix(), safe="/"),
                **child_tree,
            })
    return {"pages": pages, "dirs": dirs}


def generate_nav_json() -> None:
    nav_tree = build_nav_tree(Path("."))
    nav_file = WIKI_DIR / "nav.json"
    nav_file.parent.mkdir(parents=True, exist_ok=True)
    with open(nav_file, "w", encoding="utf-8") as f:
        json.dump(nav_tree, f, indent=2)
    print(f"  nav.json ({sum(len(d.get('pages',[])) for d in [nav_tree]+nav_tree.get('dirs',[]))} top-level entries)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def collect_dirs_with_content() -> set[Path]:
    """Return the set of directories (relative to files/) that contain notebooks."""
    dirs: set[Path] = set()
    for nb_path in FILES_DIR.rglob("*.ipynb"):
        rel = nb_path.relative_to(FILES_DIR)
        for parent in rel.parents:
            if parent != Path("."):
                dirs.add(parent)
    return dirs


def main() -> None:
    global ROOT, FILES_DIR, WIKI_DIR, TEMPLATE_DIR

    parser = argparse.ArgumentParser(description="Re-render wiki pages from notebooks")
    parser.add_argument("site_root", nargs="?", default=".",
                        help="Root of the deployed site (default: cwd)")
    parser.add_argument("--templates-dir",
                        help="Path to wiki templates (default: <site_root>/.wiki-build/templates)")
    parser.add_argument("notebooks", nargs="*",
                        help="Specific notebooks to render (relative to files/)")
    args = parser.parse_args()

    ROOT = Path(args.site_root).resolve()
    FILES_DIR = ROOT / "files"
    WIKI_DIR = ROOT / "wiki"
    TEMPLATE_DIR = Path(args.templates_dir).resolve() if args.templates_dir else ROOT / ".wiki-build" / "templates"

    if not FILES_DIR.exists():
        print(f"Error: {FILES_DIR} not found.  Run from the gh-pages root.", file=sys.stderr)
        sys.exit(1)

    if not TEMPLATE_DIR.exists():
        print(f"Error: {TEMPLATE_DIR} not found.  Missing wiki-render infrastructure.", file=sys.stderr)
        sys.exit(1)

    WIKI_DIR.mkdir(exist_ok=True)

    # Determine which notebooks to render
    specific: list[Path] = []
    if args.notebooks:
        for arg in args.notebooks:
            p = FILES_DIR / arg
            if not p.exists():
                print(f"Warning: {p} not found, skipping", file=sys.stderr)
            else:
                specific.append(p)
    else:
        specific = sorted(FILES_DIR.rglob("*.ipynb"))

    if not specific:
        print("No notebooks to render.")
        return

    print(f"Rendering {len(specific)} notebook(s)…")
    for nb_path in specific:
        convert_notebook(nb_path)

    # Regenerate all index pages (always — cheap and keeps them consistent)
    print("Generating index pages…")
    generate_index_page(Path("."))
    for d in sorted(collect_dirs_with_content()):
        generate_index_page(d)

    # Regenerate nav.json
    print("Generating nav.json…")
    generate_nav_json()

    print("Done.")


if __name__ == "__main__":
    main()
