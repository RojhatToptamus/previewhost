# Documentation website

The site reuses the MIT-licensed documentation interface from
[monki-landing](https://github.com/RojhatToptamus/monki-landing).
Its sidebar, search dialog, page outline, typography, code blocks, themes, and
mobile navigation come from that template. Previewhost uses its own neutral palette.
The template license is in [LICENSE](LICENSE).

## Develop and build

From the Previewhost repository root:

```sh
npm ci
npm run dev:docs
```

Open the local URL printed by Vite. To build and inspect the static output:

```sh
npm run build:docs
npm run preview:docs
```

`build:docs` writes HTML for every page to `.local/docs-site`.
Serve that directory with any static host that supports directory indexes.
The site has no application server, account system, analytics, or runtime API.
Reading and normal navigation work without JavaScript. Search, themes, and copy controls use React.

For a host under a path, build with its prefix, including both slashes:

```sh
DOCS_BASE=/previewhost/ npm run build:docs
DOCS_BASE=/previewhost/ npm run preview:docs
```

The repository's npm `files` allowlist excludes the website, Markdown guides,
root screenshots, and `.local` output. The existing agent skill still includes
its Markdown references and product screenshots. The docs build is separate from `build` and `prepack`.
The Markdown parser is a development dependency only.

## Edit content

Edit the Markdown source listed in [pages.mjs](pages.mjs). The same file serves
repository readers and the website. Relative links to published guides become
site links. Other repository files keep GitHub links.

Add screenshots to the existing `assets` directory. Use current product captures,
descriptive alt text, and no private values. The build reuses those images directly.

Run `npm run check:docs` to check types, build all pages, validate links and anchors,
and verify npm exclusions. Browser checks use the existing Playwright dependency:

```sh
npm run test:docs
```

Set `PREVIEWHOST_TEST_BROWSER` to an installed Chromium executable if Playwright's
Chromium is unavailable. Browser output stays in `.local/docs-browser`.
