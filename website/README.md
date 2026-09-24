# Product and documentation website

The site uses the MIT-licensed [monki-landing](https://github.com/RojhatToptamus/monki-landing)
documentation template. See [LICENSE](LICENSE).

## Local development

Run these commands from the repository root:

```sh
npm ci
npm run dev:docs
```

To build and preview the site locally:

```sh
npm run build:docs
npm run preview:docs
```

The build output is `.local/docs-site`.

## Deployment

The repository's `vercel.json` builds the public site for `https://www.previewhost.app/`.
Canonical links, social URLs, and the sitemap use that address. Local builds omit
`DOCS_URL` and remain `noindex`.

The shared mark is `assets/previewhost.svg`. After changing it, regenerate the square
PNG favicon with `node scripts/generate-favicon.mjs` (requires Playwright Chromium).

## Edit content

The product homepage is in `src/landing.tsx` and `src/landing.css`. The introduction
is served at `/introduction/`; the other documentation routes are unchanged.
The existing `/index.md` address still serves the introduction for Markdown readers.

Edit the Markdown files listed in [pages.mjs](pages.mjs).
Each page's heading supplies its title. Its first paragraph supplies its description,
including search and social metadata. The build also generates Markdown copies and `llms.txt`.

Product screenshots are in `assets/` at the repository root.
The homepage demonstration is rendered in `src/product-demo.tsx` and
`src/product-demo.css`. The shared-notes configuration comes directly from
`examples/multi-repo/environment.yaml`; the static preview uses the documented
static spec. The demo stays in the browser and does not start local services.
Startup and migration messages come from the example; ongoing request lines are
illustrative application output. Playback pauses outside the visible Logs view
and can be paused manually. The real dashboard retrieves captured logs on demand.
Keep bindings, labels, and replacement behavior aligned with the dashboard.
Secret Manager contains representative reference names only, never stored values.
Dropdowns reuse the dashboard Select component with site-scoped styles.

To update the shared social image, edit [social-card.mjs](social-card.mjs) and run:

```sh
node website/social-card.mjs
```

## Checks

```sh
npm run check:docs
npm run test:docs
```

`check:docs` checks types, builds the site, and validates links, metadata, and npm exclusions.
`test:docs` runs browser checks with Playwright's Chromium.
