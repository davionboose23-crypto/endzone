#!/usr/bin/env bash
# Stage the Pages site: standalone app + the shared repo archive (frozen snapshots, grades, lessons, decisions).
set -euo pipefail
npm run build:standalone
rm -rf _site && mkdir -p _site
cp endzone-standalone.html _site/index.html
node scripts/export-site.mjs _site/archive
touch _site/.nojekyll
