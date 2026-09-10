ITTR v22.6 — SINGLE SOURCE FRONTEND

This release fixes the situation where /api/build is current but the website can still
load an older public/index.html.

The server now always serves ROOT /index.html.
public/index.html is kept identical but cannot shadow the root frontend.
HTML is served with no-store/no-cache headers.
Old service workers/cache are removed automatically.

Replace together:
index.html
server.js
sw.js
package.json
manifest.webmanifest
public/index.html
public/sw.js
public/manifest.webmanifest

Verify:
1. /api/build => backend 22.6.0
2. normal site banner => ITTR v22.6 ONLINE · SINGLE SOURCE
