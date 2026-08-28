# Master production assets

`master-app.jsx` is the maintainable React source. `master-app.js` is its production JSX transform, and `master-app.css` is the Tailwind 3.4.17 output scanned from `Master.html` and `master-app.jsx`.

Production does not load Tailwind CDN or Babel. React 18.2.0 and ReactDOM 18.2.0 are pinned, repository-managed UMD assets under `nexus/vendor`. SheetJS 0.18.5 and `masterAddUpdate.js` load only after the operator selects an Excel file. A failed lazy load is discarded so the next file selection retries cleanly.

Regenerate the assets after editing `master-app.jsx`:

```powershell
npx --yes --package @babel/core@7.24.7 --package @babel/cli@7.24.7 --package @babel/preset-react@7.24.7 babel nexus/master/master-app.jsx --presets @babel/preset-react --out-file nexus/master/master-app.js --no-comments --compact true
npx --yes tailwindcss@3.4.17 -i nexus/master/master-tailwind.css -o nexus/master/master-app.css --minify --content Master.html --content nexus/master/master-app.jsx
```

Embed the current `master-app.jsx` SHA-256 comment in `master-app.js`; `scripts/test-master-performance.mjs` rejects a stale compiled asset. The pinned vendor hashes are also checked there.
