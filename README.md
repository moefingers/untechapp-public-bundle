# untechapp-public-bundle

Public host for the [untechapp](https://github.com/moefingers/untechapp) userscript loader.

## What's here

Just one file:

- [`inventory-autofill.user.js`](./inventory-autofill.user.js) — Tampermonkey userscript loader for untechapp. Install once, it pulls the live bundle from unbrinks's API on every page load.

## Why this repo exists

Tampermonkey installs/updates fetch `@updateURL` and `@downloadURL` from wherever those URLs point. Originally the loader was hosted on unbrinks.vercel.app — same origin as the unbrinks PWA. Chrome 139+ auto-captures every URL in the PWA's scope, so clicking the loader's install URL launched the PWA instead of letting Tampermonkey handle it.

W3C App Manifest spec has no way to exclude a path from PWA scope (WICG/manifest-incubations#105 is the open proposal, unshipped as of 2026). The real fix is cross-origin hosting — this repo. PWA scope is same-origin, so it can never claim a GitHub raw URL.

The loader is the **source of truth in [moefingers/unbrinks/public/assets/tools/inventory-autofill.user.js](https://github.com/moefingers/unbrinks/tree/main/public/assets/tools)** (so unbrinks's `/tools/techapp-auto-inventory` page can render install instructions inline). Pushes to this repo happen via [`unbrinks/scripts/sync-loader-to-public.mjs`](https://github.com/moefingers/unbrinks/blob/main/scripts/sync-loader-to-public.mjs).

## Install URL (for the userscript)

```
https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js
```

## Updating

From the `unbrinks` repo, after editing the loader:

```sh
node scripts/sync-loader-to-public.mjs
```

That diffs + commits + pushes here. Tampermonkey then sees the new `@version` on its next update-check (default ~24h) or when the user explicitly hits "Check for updates" in the dashboard.

GitHub raw has ~5 min CDN cache on the URL; no busting available, but the loader changes rarely enough that it doesn't matter.

## Not here: the bundle

The actual untechapp bundle is live-loaded from unbrinks's Vercel API on every page load. It's served from Neon (zero deploy delay) — the loader fetches it via `BUNDLE_API` (see the loader source). The bundle is too large + changes too often to live on GitHub raw with its caching behavior.
