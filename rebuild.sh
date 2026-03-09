#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Activate the venv
source /opt/venv/bin/activate

echo "=== Clean old build artifacts ==="
rm -rf packages/jupyterlite-deploy/lib \
       packages/jupyterlite-deploy/jupyterlite_deploy/labextension \
       _output

echo "=== Install JS dependencies ==="
cd packages/jupyterlite-deploy
jlpm install

echo "=== Build extension ==="
jlpm build:prod
cd ../..

echo "=== Run integration tests ==="
cd packages/jupyterlite-deploy
node test/test-memfs.mjs
cd ../..

echo "=== Reinstall Python packages ==="
pip uninstall -y jupyterlite-deploy jupyterlite-wiki-addon jupyterlite-demo 2>/dev/null || true
# Ensure build deps are available (needed for --no-build-isolation)
pip install hatchling hatch-jupyter-builder hatch-nodejs-version editables 2>/dev/null
# Use --no-build-isolation so pip uses our pre-built labextension
# instead of rebuilding JS in a clean isolated env
pip install --no-build-isolation -e packages/jupyterlite-deploy
pip install -e packages/jupyterlite_wiki_addon
pip install --no-deps -e .

echo "=== Verify deploy:sync in installed extension ==="
if grep -rq "deploy:sync" /opt/venv/share/jupyter/labextensions/jupyterlite-deploy/; then
  echo "  ✓ deploy:sync found in venv labextension"
else
  echo "  ✗ deploy:sync NOT found — aborting"
  exit 1
fi

echo "=== Rebuild JupyterLite site ==="
jupyter lite build --force

echo "=== Verify deploy:sync in _output ==="
if grep -rq "deploy:sync" _output/; then
  echo "  ✓ deploy:sync found in _output"
else
  echo "  ✗ deploy:sync NOT found in _output — something is wrong"
  exit 1
fi

echo "=== Verify wiki pages in _output ==="
if [ -d "_output/wiki" ] && ls _output/wiki/*.html >/dev/null 2>&1; then
  echo "  ✓ wiki pages found in _output/wiki"
  ls _output/wiki/*.html | head -5
else
  echo "  ✗ wiki pages NOT found — wiki addon may not be working"
  exit 1
fi

echo "=== Done ==="
echo "Run ./deploy.sh to push to gh-pages."
