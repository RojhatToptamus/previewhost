# Dashboard changes

Read [`dashboard/DESIGN.md`](dashboard/DESIGN.md) before dashboard UI or copy changes.

The dashboard uses React, Vite, Tailwind, and shadcn in `dashboard/src/`.
Keep the shared palette, fonts, and sizing in `src/ui-tokens.css`; private setup
uses these same tokens through `src/ui.ts`.

Compose the maintained components in `dashboard/src/components/ui/`. Keep
plain status words, restrained borders, consistent controls, and both themes.
Keep application state local to the view that owns it; the existing dashboard
API remains the source of runtime, configuration, and authorization data.
Check desktop and narrow layouts, keyboard controls, loading, and error states
in a browser. Build and check the packaged assets when changing the frontend.

Do not commit supplied designer specifications, HTML prototypes, or prototype runtime files.
