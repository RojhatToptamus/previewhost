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
