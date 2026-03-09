#!/usr/bin/env python3
"""
Standalone wiki renderer for the GitHub Actions workflow.

Given a gh-pages site directory, this script:
  1. Finds all .ipynb files under files/
  2. Re-renders stale wiki pages (where .ipynb is newer than .html, or .html is missing)
  3. Regenerates all wiki index pages and nav.json
  4. Regenerates api/contents/ manifests for any new/changed files

Usage:
  python render-wiki.py <site-dir> [--templates-dir <path>] [--force]

  site-dir:       path to the gh-pages checkout (contains files/, wiki/, api/, build/, etc.)
  --templates-dir: path to wiki template directory (default: auto-detect from repo root)
  --force:        re-render all pages regardless of staleness
"""

import argparse
import html as html_mod
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import nbformat
from jinja2 import Environment, FileSystemLoader
from nbconvert import HTMLExporter


# ── helpers ──────────────────────────────────────────────────


def extract_notebook_title(nb, notebook_path):
    """Best effort to pull a title from the notebook."""
    try:
        for cell in nb.cells:
            if cell.get("cell_type") != "markdown":
                continue
            source = cell.get("source") or ""
            for line in source.splitlines():
                line = line.strip()
                if line and line.startswith("#"):
                    return line.lstrip("#").strip()
        return notebook_path.stem.replace("-", " ").replace("_", " ").title()
    except Exception:
        return notebook_path.stem


# ── notebook → HTML ─────────────────────────────────────────


def convert_notebook(notebook_path, output_file, files_dir, site_dir, templates_dir):
    """Convert a single notebook to a wiki HTML page."""
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(notebook_path, "r", encoding="utf-8") as f:
        nb = nbformat.read(f, as_version=4)

    notebook_title = extract_notebook_title(nb, notebook_path)
    rel_path = notebook_path.relative_to(files_dir)
    wiki_dir = site_dir / "wiki"
    static_output = output_file.relative_to(site_dir)
    rel_path_url = quote(rel_path.as_posix(), safe="/")
    relative_root = Path(os.path.relpath(site_dir, output_file.parent))

    # Build breadcrumbs for nested notebooks
    breadcrumbs = []
    parent_parts = list(rel_path.parent.parts)
    if parent_parts and parent_parts != ["."]:
        for i, part in enumerate(parent_parts):
            levels_up = len(parent_parts) - i
            rel_href = (
                "../" * levels_up + "index.html"
                if i < len(parent_parts) - 1
                else "index.html"
            )
            breadcrumbs.append({"name": part, "href": rel_href})

    exporter = HTMLExporter(
        template_name="wiki",
        extra_template_basedirs=[str(templates_dir)],
    )

    resources = {
        "metadata": {"name": notebook_path.stem},
        "wiki_toolbar": {
            "title": notebook_title,
            "home_href": (relative_root / "wiki" / "index.html").as_posix(),
            "breadcrumbs": breadcrumbs,
            "actions": [
                {
                    "kind": "link",
                    "label": "edit",
                    "href": (relative_root / "notebooks" / "index.html").as_posix() + f"?path={rel_path_url}",
                    "new_tab": True,
                    "download": False,
                },
                {
                    "kind": "link",
                    "label": "lab",
                    "href": (relative_root / "lab" / "index.html").as_posix() + f"?path={rel_path_url}",
                    "new_tab": True,
                    "download": False,
                },
                {
                    "kind": "link",
                    "label": "down",
                    "href": (relative_root / "files").as_posix() + f"/{rel_path_url}",
                    "new_tab": False,
                    "download": True,
                },
                {
                    "kind": "button",
                    "label": "share",
                    "share_href": output_file.name,
                    "aria_label": "Copy share link",
                },
            ],
        },
        "wiki_behavior_script_url": (relative_root / "static" / "wiki_behavior.js").as_posix(),
    }

    body, _ = exporter.from_notebook_node(nb, resources=resources)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(body)

    print(f"  rendered: {output_file.relative_to(site_dir)}")


# ── index pages ─────────────────────────────────────────────


def generate_index_page(wiki_dir, files_dir, site_dir, current_dir, templates_dir):
    """Generate an index/listing page for one directory."""
    index_location = wiki_dir / current_dir
    relative_root = Path(os.path.relpath(site_dir, index_location))
    theme_base = relative_root / "build" / "themes" / "@jupyterlab"
    light_css = (theme_base / "theme-light-extension" / "index.css").as_posix()
    dark_css = (theme_base / "theme-dark-extension" / "index.css").as_posix()

    wiki_root = Path(os.path.relpath(wiki_dir, index_location)).as_posix()
    if wiki_root == ".":
        wiki_root = ""

    breadcrumbs = []
    if current_dir != Path("."):
        parts = list(current_dir.parts)
        for i in range(len(parts)):
            part_path = Path(*parts[: i + 1]) if i > 0 else Path(parts[0])
            rel_to_crumb = Path(os.path.relpath(wiki_dir / part_path, index_location))
            breadcrumbs.append(
                {"name": parts[i], "href": (rel_to_crumb / "index.html").as_posix()}
            )

    current_wiki_dir = wiki_dir / current_dir
    html_files = [f for f in current_wiki_dir.glob("*.html") if f.name != "index.html"]

    subdirs = []
    for subdir in sorted(current_wiki_dir.iterdir()):
        if subdir.is_dir() and any(subdir.rglob("*.html")):
            subdirs.append(
                {
                    "name": subdir.name,
                    "href": quote(subdir.name, safe="") + "/index.html",
                }
            )

    template_entries = []
    for html_file in sorted(html_files, key=lambda f: f.name):
        html_rel_path = html_file.relative_to(wiki_dir)
        nb_rel_path = html_rel_path.with_suffix(".ipynb")
        notebook_path = files_dir / nb_rel_path

        title = nb_rel_path.stem.replace("-", " ").replace("_", " ").title()
        if notebook_path.exists():
            try:
                with open(notebook_path, "r", encoding="utf-8") as f:
                    nb = nbformat.read(f, as_version=4)
                title = extract_notebook_title(nb, notebook_path)
            except Exception:
                pass

        rel_display = html_mod.escape(html_file.stem)
        html_href = quote(html_file.name, safe="")
        rel_path_url = quote(nb_rel_path.as_posix(), safe="/")
        static_output = html_file.relative_to(site_dir)
        static_href = "/" + quote(static_output.as_posix(), safe="/")
        title_attr = html_mod.escape(title)

        template_entries.append(
            {
                "html_href": html_href,
                "edit_href": (relative_root / "notebooks" / "index.html").as_posix() + f"?path={rel_path_url}",
                "lab_href": (relative_root / "lab" / "index.html").as_posix() + f"?path={rel_path_url}",
                "download_href": (relative_root / "files").as_posix() + f"/{rel_path_url}",
                "static_href": html_href,
                "title_attr": title_attr,
                "rel_display": rel_display,
            }
        )

    env = Environment(loader=FileSystemLoader(str(templates_dir)), autoescape=True)
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
        entries=template_entries,
        subdirs=subdirs,
        breadcrumbs=breadcrumbs,
        wiki_root=wiki_root,
        behavior_script_url=(relative_root / "static" / "wiki_behavior.js").as_posix(),
    )

    index_file = index_location / "index.html"
    index_file.parent.mkdir(parents=True, exist_ok=True)
    with open(index_file, "w", encoding="utf-8") as f:
        f.write(index_html)
    print(f"  index: {index_file.relative_to(site_dir)}")


# ── nav.json ─────────────────────────────────────────────────


def build_nav_tree(wiki_dir, files_dir, current_dir):
    """Recursively build a navigation tree dict."""
    current_wiki_dir = wiki_dir / current_dir
    pages = []
    for html_file in sorted(
        [f for f in current_wiki_dir.glob("*.html") if f.name != "index.html"],
        key=lambda f: f.name,
    ):
        html_rel = html_file.relative_to(wiki_dir)
        nb_rel = html_rel.with_suffix(".ipynb")
        notebook_path = files_dir / nb_rel

        title = nb_rel.stem.replace("-", " ").replace("_", " ").title()
        if notebook_path.exists():
            try:
                with open(notebook_path, "r", encoding="utf-8") as f:
                    nb = nbformat.read(f, as_version=4)
                title = extract_notebook_title(nb, notebook_path)
            except Exception:
                pass

        pages.append(
            {"title": title, "href": "/wiki/" + quote(html_rel.as_posix(), safe="/")}
        )

    dirs = []
    for subdir in sorted(current_wiki_dir.iterdir()):
        if subdir.is_dir() and any(subdir.rglob("*.html")):
            child_rel = subdir.relative_to(wiki_dir)
            child_tree = build_nav_tree(wiki_dir, files_dir, child_rel)
            dirs.append(
                {
                    "name": subdir.name,
                    "href": "/wiki/"
                    + quote((child_rel / "index.html").as_posix(), safe="/"),
                    **child_tree,
                }
            )
    return {"pages": pages, "dirs": dirs}


def generate_nav_json(wiki_dir, files_dir):
    """Write wiki/nav.json."""
    nav_tree = build_nav_tree(wiki_dir, files_dir, Path("."))
    nav_json = wiki_dir / "nav.json"
    with open(nav_json, "w", encoding="utf-8") as f:
        json.dump(nav_tree, f, indent=2)
    print(f"  nav.json updated")


# ── Contents API manifests ───────────────────────────────────


def rebuild_contents_api(site_dir, files_dir):
    """
    Regenerate api/contents/ manifests so JupyterLite sees new/changed files.

    Each directory gets an all.json listing its entries.  This mirrors what
    ``jupyter lite build`` produces.
    """
    api_dir = site_dir / "api" / "contents"
    now = datetime.now(timezone.utc).isoformat()

    def scan_dir(dir_path, rel=""):
        entries = []
        for child in sorted(dir_path.iterdir()):
            child_rel = f"{rel}/{child.name}" if rel else child.name
            if child.is_dir():
                entries.append(
                    {
                        "content": None,
                        "created": now,
                        "format": None,
                        "hash": None,
                        "hash_algorithm": None,
                        "last_modified": now,
                        "mimetype": None,
                        "name": child.name,
                        "path": child_rel,
                        "size": None,
                        "type": "directory",
                        "writable": True,
                    }
                )
                # Recurse
                scan_dir(child, child_rel)
            elif child.suffix == ".ipynb":
                entries.append(
                    {
                        "content": None,
                        "created": now,
                        "format": None,
                        "hash": None,
                        "hash_algorithm": None,
                        "last_modified": datetime.fromtimestamp(
                            child.stat().st_mtime, tz=timezone.utc
                        ).isoformat(),
                        "mimetype": None,
                        "name": child.name,
                        "path": child_rel,
                        "size": child.stat().st_size,
                        "type": "notebook",
                        "writable": True,
                    }
                )
            else:
                mimetype = "application/octet-stream"
                if child.suffix in {".json", ".geojson"}:
                    mimetype = "application/json"
                elif child.suffix == ".csv":
                    mimetype = "text/csv"
                elif child.suffix == ".txt":
                    mimetype = "text/plain"
                entries.append(
                    {
                        "content": None,
                        "created": now,
                        "format": None,
                        "hash": None,
                        "hash_algorithm": None,
                        "last_modified": datetime.fromtimestamp(
                            child.stat().st_mtime, tz=timezone.utc
                        ).isoformat(),
                        "mimetype": mimetype,
                        "name": child.name,
                        "path": child_rel,
                        "size": child.stat().st_size,
                        "type": "file",
                        "writable": True,
                    }
                )

        manifest = {
            "created": now,
            "format": "json",
            "hash": None,
            "hash_algorithm": None,
            "last_modified": now,
            "mimetype": None,
            "name": rel.rsplit("/", 1)[-1] if rel else "",
            "path": rel,
            "size": None,
            "type": "directory",
            "writable": True,
            "content": entries,
        }

        out_dir = api_dir / rel if rel else api_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / "all.json", "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

    scan_dir(files_dir, "")
    print("  api/contents/ updated")


# ── behavior script ──────────────────────────────────────────


def copy_behavior_script(site_dir, templates_dir):
    """Ensure the wiki_behavior.js is up-to-date in static/."""
    src = templates_dir / "wiki_behavior.js"
    dest = site_dir / "static" / "wiki_behavior.js"
    if src.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        print("  static/wiki_behavior.js updated")


# ── main ─────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Render wiki pages in a gh-pages tree")
    parser.add_argument("site_dir", type=Path, help="Path to the gh-pages checkout")
    parser.add_argument(
        "--templates-dir",
        type=Path,
        default=None,
        help="Path to wiki template directory",
    )
    parser.add_argument(
        "--force", action="store_true", help="Re-render all pages regardless of staleness"
    )
    args = parser.parse_args()

    site_dir = args.site_dir.resolve()
    files_dir = site_dir / "files"
    wiki_dir = site_dir / "wiki"

    if not files_dir.exists():
        print("No files/ directory found — nothing to do")
        return

    # Auto-detect templates directory
    templates_dir = args.templates_dir
    if templates_dir is None:
        # Look relative to this script → ../../packages/jupyterlite_wiki_addon/...
        repo_root = Path(__file__).resolve().parent.parent.parent
        templates_dir = (
            repo_root
            / "packages"
            / "jupyterlite_wiki_addon"
            / "jupyterlite_wiki_addon"
            / "templates"
        )
    templates_dir = templates_dir.resolve()

    if not templates_dir.exists():
        print(f"ERROR: templates directory not found: {templates_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Site dir:      {site_dir}")
    print(f"Templates dir: {templates_dir}")

    wiki_dir.mkdir(exist_ok=True)

    # ── 1. Find notebooks and render stale pages ──
    notebooks = list(files_dir.rglob("*.ipynb"))
    if not notebooks:
        print("No notebooks found in files/")
        return

    rendered = 0
    skipped = 0
    for nb_path in sorted(notebooks):
        rel = nb_path.relative_to(files_dir)
        html_path = wiki_dir / rel.with_suffix(".html")

        is_stale = args.force or not html_path.exists()
        if not is_stale:
            nb_mtime = nb_path.stat().st_mtime
            html_mtime = html_path.stat().st_mtime
            is_stale = nb_mtime > html_mtime

        if is_stale:
            convert_notebook(nb_path, html_path, files_dir, site_dir, templates_dir)
            rendered += 1
        else:
            skipped += 1

    print(f"\nRendered {rendered} page(s), skipped {skipped} up-to-date page(s)")

    # ── 2. Copy behavior script ──
    copy_behavior_script(site_dir, templates_dir)

    # ── 3. Regenerate all index pages ──
    print("\nRegenerating index pages…")
    # Root index
    generate_index_page(wiki_dir, files_dir, site_dir, Path("."), templates_dir)
    # Subdirectory indices
    dirs_with_content = set()
    for nb_path in notebooks:
        rel = nb_path.relative_to(files_dir)
        for parent in rel.parents:
            if parent != Path("."):
                dirs_with_content.add(parent)
    for subdir in sorted(dirs_with_content):
        if (wiki_dir / subdir).is_dir():
            generate_index_page(wiki_dir, files_dir, site_dir, subdir, templates_dir)

    # ── 4. Regenerate nav.json ──
    print("\nRegenerating nav.json…")
    generate_nav_json(wiki_dir, files_dir)

    # ── 5. Rebuild Contents API manifests ──
    print("\nRebuilding Contents API…")
    rebuild_contents_api(site_dir, files_dir)

    print("\nDone!")


if __name__ == "__main__":
    main()
