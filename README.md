# MythicTomes

MythicTomes is a public library of 5E-compatible homebrew. Read material in your browser, browse it by author or catalogue, and use the page navigation to move through related rules.

## Finding material

- `content/authors/` contains one profile for each author. It states the author’s default copyright and licence terms.
- `content/catalogues/` contains curated collections. A catalogue links to works; it does not duplicate them.
- `content/playtests/<Author>/` contains each author’s canonical files, organised by type such as `Classes`, `Subclasses`, `Races`, `Magic Items`, and `Rules and Mechanics`.
- `content/assets/` contains approved images and other browser-safe supporting files.

The generated website turns this hierarchy into searchable, collapsible navigation. Keep a work in its author’s folder even when it belongs to more than one catalogue.

## Adding or updating a file

1. Create a branch from `develop`.
2. Add or update the file in the author’s folder under `content/playtests/`.
3. Add a small YAML block when possible. The preferred minimum is a title and author:

   ```yaml
   ---
   title: Your work title
   author: Your author name
   ---
   ```

   You may also add `category`, `catalogues`, `version`, `licence`, `copyright`, and `description`. Missing optional fields do not block a contribution.

4. If the work belongs in a themed collection, add its catalogue name to `catalogues` and update the relevant catalogue page.
5. Open a pull request to `develop`. Do not open normal contribution pull requests to `main`.

Before submitting, make sure you have the right to publish the work and any attached assets. Do not add private notes, session records, local paths, assistant settings, or unapproved third-party material.

## File formats

Markdown is the current browser-native format. Keep Markdown in the author’s canonical folder. PDF and supported assets may be added when the contributor provides clear title, author, copyright/licence, and catalogue information; their presentation workflow will be added separately.

## Copyright and hosting permission

You retain copyright in your original work. By submitting content, you confirm that you own it or are authorised to submit it, identify any third-party material, and grant MythicTomes a non-exclusive licence to host, render, cache, display, and distribute it through this library. This does not transfer ownership.

Read [LICENSE.md](LICENSE.md) for the full mixed-licence terms.

## Automatic vault publishing

Vault-managed works are generated from committed notes with `publish: true` in TheBigVaultOfDnD. Its private publishing workflow exports notes and referenced images, validates the site, and commits only changed public output to this repository's `main`. Edit those works in the vault, not their generated site copies.

Private-only edits do not create site commits. Removing the publishing property removes the generated page on the next successful sync. Published catalogue pages automatically appear in the managed navigation regions on the homepage and Catalogues index.

`npm run sync:vault -- --vault /path/to/vault` runs the same exporter locally. `npm run check:portal` validates, tests, builds Quartz, and writes `public/deployment.json` with the checked-out site commit. That marker is a build artifact, never a committed source file.

Wrangler runs the full validation/build command before deployment, so a successful standalone Quartz build cannot bypass validation. The Cloudflare dashboard may retain its existing `npx quartz build` command; setting it to the same validation command is supported but repeats work. Keep the deploy command `npx wrangler deploy`.
