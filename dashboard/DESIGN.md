# Previewhost design system

This guide governs the dashboard and informs private setup screens. Keep the interface quiet, readable, and useful while an agent builds an application.

A user should quickly understand:

- Which project and worktree is this?
- Can I open the application?
- What needs attention?
- What can I safely stop, retry, or reset?

## 1. Principles and authority

**Meaning before decoration.** Every element must help someone identify, compare, act, or recover. Remove elements that only fill space.

**One place for each fact.** A status gives the state; supporting text adds a consequence or next action. Do not narrate nearby labels, timestamps, or buttons.

**Quiet by default.** Use neutral surfaces and restrained borders. Reserve color for meaningful status and destructive actions.

**Density with room to read.** Group related content with small gaps; separate different tasks with larger gaps. Avoid both oversized empty panels and crowded toolbars.

**Truth before reassurance.** Show what the runtime reports. Do not infer health, successful cleanup, or rollback from an inactive spinner.

**Both themes are complete designs.** A new component must work in light and dark mode, with the same hierarchy and behavior.

Product requirements and authorization boundaries take precedence over visual convenience. This guide defines design intent; the existing tokens and components own exact values. Update both when an intentional design change requires it.

Do not import another application's theme engine, layout machinery, or lifecycle to implement these principles.

## 2. Tokens and visual language

`src/ui-tokens.css` owns the shared palette, fonts, and control dimensions. `dashboard/src/styles.css` maps those tokens to Tailwind and dashboard recipes. Private setup uses the shared tokens through `src/ui.ts`.

Use semantic utilities or existing variables. Do not add color literals to components, SVGs, or page-specific styles. A new token needs a current use and a value in both themes.

| Role | Existing tokens |
| --- | --- |
| Page and content surfaces | `--bg`, `--surface`, `--subtle` |
| Hover and selection | `--hover`, `--sel` |
| Panel boundaries and controls | `--border`, `--border-2` |
| Row separators | `--divider`, `--divider-2` |
| Primary and supporting text | `--t1`, `--t2`, `--t3` |
| Muted text | `--t4` |
| Low-priority visual detail | `--t5`, `--t6`, `--t7` |
| Primary action | `--inv-bg`, `--inv-fg` |
| Success, error, warning | `--ok`, `--err`, `--warn` |

Do not use faint text for instructions, errors, or required decisions. Check text contrast against its actual background in both themes: 4.5:1 for normal text. Focus indicators and meaningful control boundaries need 3:1 contrast. These are review targets, not a claim that every existing token combination passes.

The dashboard applies `ph-dark` to `body` and saves the choice as `previewhost.theme`. Components do not implement their own theme preferences.

Use one restrained boundary per group. Avoid decorative shadows, gradients, accent stripes, nested cards, and status dots or pills. Focus outlines remain visible; they are not decorative shadows.

## 3. Typography and geometry

Use Geist for interface text and Geist Mono for machine values. Mono belongs on paths, URLs, ports, environment keys, commands, timestamps, identifiers, and log output. It does not belong on instructions or status words.

| Element | Current recipe |
| --- | --- |
| Page title | 24px, weight 600 |
| Preview title | 22px; 20px on narrow screens |
| Body and controls | 13px |
| Supporting text | 12px |
| Section label | 11px, uppercase |
| Machine values | 11–12px |
| Standard / compact control | 32px / 28px high |
| Control / panel radius | 6px / 8px |
| App header / detail tabs | 52px / 44px high |
| Desktop sidebar | 232px wide |

Treat these as shared recipes, not reasons to scatter literal values across components. Keep control heights aligned within a row. Use `gap` for relationships within a group. Prefer existing spacing steps: 4, 8, 12, 16, 20, 24, and 32px.

Use the existing outline icon set. Icons support labels; they do not decorate headings. Every icon-only control needs an accessible name. Do not use emoji as interface icons.

Hover, focus, selection, and loading must not change control geometry. Keep motion brief and functional. Honor reduced-motion preferences; only animate progress while work is pending.

Use a single 2px keyboard focus outline. Hover uses `--hover`; the selected navigation row uses `--sel`. Color feedback lasts 120ms; sidebar movement uses a 180ms ease-out transition.

## 4. Layout and navigation

Keep one application shell. The sidebar owns preview navigation and Secret Manager. On narrow screens, use the existing Sheet; do not build a second navigation model.

A preview has one persistent identity and action header, followed immediately by Activity, Logs, and Configuration tabs. Tab changes must not move the header or tabs. Content scrolls within its workspace.

Keep the brand at the left of the sidebar header area and its toggle at the right edge. Keep the toggle available when the sidebar is collapsed. Use a 24px desktop content gutter and 16px narrow-screen gutter. Avoid breadcrumbs that only repeat the selected view.

The expanded sidebar and its brand header share a surface and right boundary. Use 12px sidebar gutters and 4px between navigation rows.

The sidebar provides Overview, Secret Manager, and collapsible project groups. Linked Git
worktrees share a heading only when their canonical Git common directory matches. Independent
clones and non-Git folders remain separate, even when names match. Missing Git metadata falls
back to folder identity; never infer repository membership from names or remote URLs.

Show branch names beneath the repository heading. Add source subfolders and preview names
when needed to distinguish environments; detached worktrees use folder labels. Keep exact
paths and configured names in details and accessible control context. Branch labels describe
current source, not a historical build. A multi-repository application belongs under its owner's
project; its other sources remain visible in configuration and searchable from Overview.

Keep five previews visible per sidebar group, plus a selected or focused row so actions never
make their own target disappear. Show all expands the group; collapsing it is a presentation
choice only. Overview owns the full searchable comparison table and status filter. Group
headings replace repeated repository names and paths in both views. Overview filters leave
sidebar navigation available. Active work comes first, then entries needing attention, with
newer startup attempts first within each category. No separate recent-history list is stored.

Use the shortest distinguishing parent suffix for groups with matching names. Long labels
may wrap in Overview; sidebar labels truncate and retain their full accessible context.

Each row has a separate action menu; using it must not navigate. Keep sidebar action triggers
inside their rows, aligned with the name. Reuse the same actions in overview and details.
Every entry offers Recheck status and Remove entry. Removal explains blockers in its review;
an unreachable owner never counts as stopped. The server rechecks cleanup evidence and rejects
changed records before removal.

Paths stay on one line. Let parent directories truncate while preserving the final segments at full contrast. Use the shared `Path` component; never use right-to-left text direction to fake truncation.

### View contracts

| View | Primary purpose and structure |
| --- | --- |
| Previews | Compare worktrees, status, and available applications in aligned rows. Names open details; Open app opens the running application. |
| Activity | Show actionable failures, serving/latest attempts with start times, services, jobs, private setup, and managed data. Put recovery beside the affected resource. |
| Logs | Put search, attempt, and source above output. Use Log options for wrapping, search context, and Clear view. The header Refresh also retrieves logs. Explain hidden and omitted output separately; do not imply captured logs are live. |
| Configuration | Show the selected attempt's configuration, bindings, and sources. Keep Save as preview.yaml outside the scrolling body when no default file exists. Otherwise identify the existing file. |
| Secret Manager | Search stored references, then edit a selected reference in the existing dialog. Never fetch or display its stored value. |

Long lists need bounded scrolling without burying actions. The environment table uses a 320px height capped at 45% of viewport height, with its own scrollbar and sticky header. Secret lists use the existing bounded scroll area. Short lists should not gain artificial filler rows.

Tables compare values. Give each column enough room for its content; do not squeeze references into an action-width column. Reserve compact right columns for actions. Use row separators without extra lines above the first row or below the last.

At narrow widths, stack controls in reading order and preserve the primary action. Reduce secondary detail before shrinking text. Long paths, names, and output must not widen the entire page. Horizontal scrolling is appropriate for machine output or a table that cannot retain meaning when compressed.

Display the serving application's readable hostname when supplied by the runtime. Keep the existing Open app destination; different origins can affect application cookies and CORS. Never construct an alias from a preview name or show a candidate's address as serving.

Log source means the process or job that emitted the output. Frameworks can forward browser messages into that same output. Do not silently hide lines or classify their origin from text prefixes. Source selection and search provide reliable ways to narrow output.

Back and reload preserve the selected preview and its diagnostic choices within a browser session.
Store presentation choices only; fetch runtime state again. If an attempt is no longer retained,
show a useful recovery action rather than silently selecting another. With no retained attempts,
show Activity and its existing recovery actions.

## 5. Components and interaction

Compose the maintained components in `dashboard/src/components/ui/`. Reuse view-level helpers in `components/shared.tsx`. Add a wrapper only when several callers need the same behavior.

| Need | Existing component or pattern |
| --- | --- |
| Action / navigation action | `Button`, appropriate variant; native anchor for URLs |
| Text or search input | `Input`, `InputGroup`, shared `SearchField` |
| Labeled field and validation | `Field`, `FieldLabel`, `FieldDescription`, `FieldError` |
| Choice list | shadcn `Select`; no native dropdowns |
| Preview actions | `DropdownMenu`, shared `PreviewMenu` |
| View navigation | `Tabs`, `Sidebar`, mobile `Sheet` |
| Tabular data | `Table` and its semantic children |
| Bounded list | `ScrollArea` |
| Private value edit | `Dialog` with an explicit Save action |
| Destructive confirmation | `ConfirmAction` / `AlertDialog` |
| Loading / empty / failure | `Loading`, `EmptyState`, `Notice` |
| Theme choice | Existing `Toggle` |
| Secondary diagnostic disclosure | Native `details` and `summary` |

Do not add a component merely to replace working native behavior. Shared CSS owns consistent sizing; page components own content and placement.

### Actions and feedback

- Give each view at most one primary action. A dialog may have its own primary action.
- Do not repeat an action in a notice when the header already provides it.
- Use sentence-case verbs: Open app, Retry start, Reset data. Avoid generic OK or Submit.
- Keep important actions available without hover. An icon-only compact action retains its accessible name.
- After copying, replace the copy icon with a check for two seconds. Announce Copied through the control; do not show a success toast. Show an error if copying fails.
- Use a toast for a completed operation that lacks sufficient local feedback. Keep errors beside the affected field or task when recovery needs attention.
- Show pending feedback only during actual work. Prevent duplicate submissions and preserve the control's size.
- Explain disabled actions when the reason is not evident from nearby state.

Dialogs have a title, relevant consequences, and explicit actions. Keep focus inside while open, support dismissal where safe, and return focus to the trigger. Never stack dialogs. Confirm destructive scope using actual environment and database names.

## 6. States and safety copy

Render statuses as plain words. Color reinforces the word; it never replaces it. Use labels derived from existing runtime state, not a separate UI state machine.

- **Ready** means startup checks passed. It does not promise ongoing health or prove every application request works.
- **Starting** requires a startup candidate. A generic busy operation is **Working**, not necessarily startup.
- **Update failed** may coexist with a working previous application. Keep Serving and Latest update separate; Open app must target the serving application.
- **Needs secrets** describes required private setup. Saving values does not start the application or automatically resume an ended agent turn.
- **Stopped** does not mean data was deleted. Preserve the distinction between retained data, canceled startup, and incomplete cleanup.

Use other truthful states when needed, including Startup failed, Configuration error, and Cleanup incomplete. Do not force them into a misleading success or stopped label.

Keep these consequences explicit at the relevant decision:

- Stop retains managed database data. It affects only the selected preview.
- Delete data erases named managed databases without restarting. Remove entry requires no remaining data or cleanup and keeps sources and saved secrets.
- Removing the last entry closes an empty automatic owner and ends its private approvals. An offline data record contains no restart configuration.
- Restart uses retained configuration and current source; it does not reload preview.yaml.
- Default lookup uses preview.yaml, then preview.yml. Both files present or invalid YAML is an error.
- Saving YAML is explicit and does not change the running preview. Either default filename blocks saving, including directories and symlinks.
- Reset erases the named managed databases, not external databases or secrets. Deletion and job writes cannot be rolled back.
- A rerun can repeat database writes. A canceled process does not undo earlier writes.
- Stored secret references differ from application environment-variable names. Updating a shared reference affects future starts in every project that uses it.
- Secret values and private capabilities stay out of logs, URLs shown to agents, screenshots, and diagnostic payloads.
- Canceled private setup stays canceled until the user requests it again. A finished agent turn may require a continuation message.

Do not remove a necessary confirmation warning merely because the originating page explains the same risk. Those are separate decision points.

## 7. Copy rules

Write for someone checking an application, not someone learning Previewhost internals.

Omit permanent reassurance and help text from navigation. Use an icon with an accessible name for theme switching; keep connection failures in the relevant error view. A healthy state does not need an explanatory sentence. Put consequences beside the action or in its confirmation, not in repeated page introductions.

1. Start with the useful fact. Add a consequence or next action only when it helps.
2. Use familiar words, active voice, and short sentences. Aim below 20 words for instructions and 25 for explanations.
3. Give a concept one name. Use preview, worktree, service, job, attempt, stored reference, and managed database consistently.
4. Labels name things; buttons name actions; hints explain consequences. Do not make all three repeat the same sentence.
5. Remove filler such as “at the time shown,” “successfully completed,” and explanations of obvious controls.
6. Keep errors specific. State what failed and how to recover when known. Do not invent a cause or hide the original diagnostic.
7. Empty states explain what is absent and give one useful next step. Loading states name the pending work.
8. Never promise rollback, automatic continuation, or healthy application behavior without runtime evidence.
9. Use sentence case. Keep uppercase for machine keys and the existing section-label treatment.
10. Keep identifiers, paths, commands, and returned errors exact. Do not rewrite machine values for tone.

| Avoid | Prefer |
| --- | --- |
| Ready — Every startup check passed. | Ready |
| Save this attempt as preview.yaml. Existing files are never overwritten. [Save as preview.yaml] | Existing files are never overwritten. [Save as preview.yaml] |
| Started at the time shown. | The timestamp alone. |
| Values are never shown. | Stored values are never shown. |
| Its owner may have shut down. | Start through your agent or CLI to reconnect. |

## 8. Implementation ownership and review

Runtime, configuration, and authorization remain owned by the existing API. Derive presentation in `lib/model.ts`; keep selection and pending UI state in the view that uses them. Do not copy server state into a second lifecycle.

Keep failed-update actions with their attempt and resource. Destructive confirmations retain their
pending and failed outcome, including whether deletion finished before startup failed. Never offer
an automatic destructive retry. Log filtering and Clear view affect only the current view; retain
the chosen attempt on refresh and label output that is no longer retained.

Before adding a component, section, token, or sentence, ask:

- Which current task does it support?
- Can an existing component or operation handle it?
- Does it repeat a fact already visible here?
- What happens with long content, no data, a failure, and a narrow viewport?
- Does it preserve keyboard access and the existing authorization boundary?

Before finishing a UI change:

- Inspect the complete diff for duplicate state, CSS overrides, repeated copy, and unused components.
- Run focused checks, typecheck, and build the packaged dashboard assets.
- Exercise affected interactions in a real browser, not just component mocks.
- Inspect light and dark screenshots at desktop and narrow widths, including 320px when the affected layout permits it.
- Check long names, long paths, many rows, empty lists, loading, and errors relevant to the change.
- Verify focus visibility, tab order, dialogs, selection, copy feedback, and scroll ownership.
- Use disposable data. Never capture secret values or private capabilities.
- State what was actually tested and what remains unverified.
