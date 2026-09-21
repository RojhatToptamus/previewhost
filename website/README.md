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

## Publish

Set `DOCS_URL` to the final public HTTPS URL, including its path prefix.
The following command uses an example address. Replace it with your domain:

```sh
DOCS_URL=https://docs.example.com/ npm run check:docs
npm run test:docs
```

Upload `.local/docs-site` to the static host.
Use `npm run build:docs` as the host's build command. Set `DOCS_URL` in its environment.
For a site under `/docs/`, use `DOCS_URL=https://example.com/docs/`. The build derives asset and navigation paths from that URL.

The public URL supplies canonical links, Open Graph URLs, the sitemap, and `llms.txt` links.
Without `DOCS_URL`, the build marks pages `noindex` and omits the sitemap. Use that output for local previews only.

Configure the host to:

- Serve each directory's `index.html`, including direct visits to nested guides.
- Redirect alternate domains and `/index.html` URLs to the corresponding canonical URL.
- Return HTTP 404 for unknown paths and use `404.html` as the error page. Do not rewrite missing paths to the introduction.
- Serve `.md` and `.txt` files as text, `.xml` as XML, and images with their correct content types.
- Keep HTML, `llms.txt`, and the sitemap fresh after deploys. Only hashed JS and CSS assets can use long immutable caching.

`robots.txt` must be at the origin root to control crawlers.
For a site under a path, add the generated `Sitemap:` line to the host's root `robots.txt`.
Do not replace crawler rules for other sites on the same origin.

After deployment, verify the introduction, a nested guide, its `index.md`, `llms.txt`, `sitemap.xml`, `social-card.png`, and an unknown path.
Check the public HTML for the correct domain and no `noindex` tag on documentation pages.
Submit the sitemap in Google Search Console after verifying domain ownership.

## Search and sharing metadata

Each page uses its Markdown heading as the title and its first paragraph as the description.
The introduction has a site title that identifies Previewhost and local application previews.
Keep the first paragraph short and specific to the page. The build also uses it for search and sharing metadata and `llms.txt`.

The build adds canonical links, Open Graph and Twitter card metadata, and `TechArticle` structured data.
The sitemap contains the public HTML pages. It excludes the 404 page and Markdown copies.
It has no generated modification dates: a new build does not mean that every guide changed.

The shared preview image is [social-card.png](social-card.png), a 1200 × 630 PNG.
To rebuild it from the existing logo and text, run `node website/social-card.mjs` with Playwright's Chromium installed.

## Agent documentation

The build generates `llms.txt` with links grouped by workflow and topic.
Each guide has an `index.md` copy with working links and the original code examples.
HTML pages link to both files through `alternate` and `describedby` relations.
The Markdown source remains the only place to edit the guides.

This follows the [llms.txt proposal](https://llmstxt.org/) to help agents select the relevant documentation.
It is not a search ranking requirement. [Google's AI search guidance](https://developers.google.com/search/docs/appearance/ai-features) uses the same SEO requirements as regular search.

## Local path previews

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
validate metadata and agent files, and verify npm exclusions. Browser checks use the existing Playwright dependency:

```sh
npm run test:docs
```

Set `PREVIEWHOST_TEST_BROWSER` to an installed Chromium executable if Playwright's
Chromium is unavailable. Browser output stays in `.local/docs-browser`.
