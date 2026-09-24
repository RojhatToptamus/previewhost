# Documentation website

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

Edit the Markdown files listed in [pages.mjs](pages.mjs).
Each page's heading supplies its title. Its first paragraph supplies its description,
including search and social metadata. The build also generates Markdown copies and `llms.txt`.

Product screenshots are in `assets/` at the repository root.
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
