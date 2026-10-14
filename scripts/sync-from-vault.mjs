#!/usr/bin/env node
// Generates public library pages from TheBigVaultOfDnD.
//
//   npm run sync:vault              write content/ from the vault
//   npm run sync:vault -- --dry-run show what would change
//   npm run sync:check              verify generated files were not hand-edited (no vault needed)
//
// A page's `modified` date is the publish date (today, or --date YYYY-MM-DD for the approval
// date) when its public content changes, and is otherwise left as it was.
//
// The vault is the only place published works are edited. See vault-sync.config.yaml.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFile, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import YAML from "yaml"

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"])
const INDEX_START = "<!-- vault-sync:works:start -->"
const INDEX_END = "<!-- vault-sync:works:end -->"
const CATALOGUE_START = "<!-- vault-sync:catalogues:start -->"
const CATALOGUE_END = "<!-- vault-sync:catalogues:end -->"
const PASSTHROUGH_FIELDS = ["description", "version", "licence", "copyright"]

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const contentRoot = path.join(repositoryRoot, "content")

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function splitFrontmatter(markdown) {
  const text = markdown.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return { data: {}, body: text }
  const end = text.indexOf("\n---", 4)
  if (end === -1) throw new Error("Unclosed YAML frontmatter")
  const after = text.indexOf("\n", end + 4)
  return {
    data: YAML.parse(text.slice(4, end)) ?? {},
    body: after === -1 ? "" : text.slice(after + 1),
  }
}

/** Splits Markdown into alternating prose / fenced-code segments so code is never rewritten. */
export function segments(body) {
  const output = []
  let fence = null
  let buffer = []
  const flush = (code) => {
    if (buffer.length) output.push({ code, text: buffer.join("\n") })
    buffer = []
  }
  for (const line of body.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (!fence && marker) {
      flush(false)
      fence = marker[1]
      buffer.push(line)
    } else if (fence && line.trim().startsWith(fence)) {
      buffer.push(line)
      flush(true)
      fence = null
    } else buffer.push(line)
  }
  flush(Boolean(fence))
  return output
}

const joinSegments = (parts) => parts.map((part) => part.text).join("\n")
const mapProse = (body, transform) =>
  joinSegments(
    segments(body).map((part) => (part.code ? part : { ...part, text: transform(part.text) })),
  )

/** Removes Obsidian %%comments%%, which are private author notes. */
export function stripComments(body) {
  return mapProse(body, (text) => text.replace(/%%[\s\S]*?%%/g, ""))
}

/**
 * Normalises heading depth for Quartz, which renders the page title as the H1.
 * The work's own title becomes an H2: an existing leading heading is promoted to H2, or
 * `## {title}` is inserted when the note starts with prose. Other headings keep their
 * relative depth beneath it.
 */
export function normaliseHeadings(body, title) {
  const parts = segments(body.trim())
  const levels = parts
    .filter((part) => !part.code)
    .flatMap((part) => [...part.text.matchAll(/^(#{1,6})\s/gm)].map((match) => match[1].length))
  const firstLine = body.trim().split("\n")[0] ?? ""
  const leadingHeading = /^#{1,6}\s/.test(firstLine)
  const targetMinimum = leadingHeading ? 2 : 3
  const offset = levels.length ? targetMinimum - Math.min(...levels) : 0
  const shifted = joinSegments(
    parts.map((part) =>
      part.code
        ? part
        : {
            ...part,
            text: part.text.replace(/^(#{1,6})(?=\s)/gm, (hashes) =>
              "#".repeat(Math.min(6, Math.max(2, hashes.length + offset))),
            ),
          },
    ),
  )
  return leadingHeading ? shifted : `## ${title}\n\n${shifted}`
}

/**
 * Rewrites Obsidian wikilinks and embeds.
 *  - resolveNote(name) → output basename of a published or site-owned note, or null
 *  - resolveAsset(name) → public asset path (relative to content/), or null
 * Links to unpublished notes are reduced to their display text so private notes never
 * appear as broken links. Returns { body, warnings }.
 */
export function rewriteLinks(body, { resolveNote, resolveAsset }) {
  const warnings = []
  const text = mapProse(body, (prose) =>
    prose.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (whole, bang, inner, offset, source) => {
      const separator = inner.includes("\\|") ? "\\|" : "|"
      const pipe = inner.indexOf(separator)
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
      const alias = pipe === -1 ? null : inner.slice(pipe + separator.length)
      const hashIndex = target.search(/[#^]/)
      const name = hashIndex === -1 ? target : target.slice(0, hashIndex)
      const anchor = hashIndex === -1 ? "" : target.slice(hashIndex)
      const tail = alias === null ? "" : `${separator}${alias}`

      if (IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        const asset = resolveAsset(name)
        if (!asset) throw new Error(`Embedded image not found in vault: ${name}`)
        return `${bang}[[${asset}${tail}]]`
      }

      if (name === "") return whole // same-note heading link
      // resolveNote returns a target slug, or { target, display } to keep the author's link
      // text when the target is a full path (an unaliased link would otherwise show the file name).
      const resolved = resolveNote(name)
      if (resolved) {
        const { target, display } =
          typeof resolved === "string" ? { target: resolved, display: null } : resolved
        if (alias !== null || bang || anchor || !display)
          return `${bang}[[${target}${anchor}${tail}]]`
        const lineStart = source.lastIndexOf("\n", offset) + 1
        const pipe = source.slice(lineStart).trimStart().startsWith("|") ? "\\|" : "|"
        return `[[${target}${pipe}${display}]]`
      }
      if (bang) {
        warnings.push(`removed embed of unpublished note "${name}"`)
        return ""
      }
      warnings.push(`unlinked unpublished note "${name}"`)
      return alias ?? path.basename(name)
    }),
  )
  return { body: text, warnings }
}

/**
 * A note inside a configured setting folder (`settings`: vault root folder → catalogue name)
 * belongs to that catalogue. `folders` are the directories between the setting root and the
 * note, which is where its category comes from. Returns null for notes outside every setting.
 */
export function locateInSetting(relativePath, settings = {}) {
  const [root, ...rest] = relativePath.split("/")
  const catalogue = settings[root]
  if (!catalogue || rest.length === 0) return null
  return { catalogue, folders: rest.slice(0, -1) }
}

/**
 * Maps the folders below a setting root to a category and optional subcategory, so a new
 * folder becomes a new category without any configuration: the first folder is the
 * category, the second the subcategory, and any further folders are joined onto the
 * subcategory with " - ". A note directly in the setting root has no folder category (it
 * falls back to a categoryRule, then to ROOT_CATEGORY).
 */
export function categoryFromFolders(folders) {
  const [category, ...remaining] = folders
  const subcategory = remaining.length ? remaining.join(" - ") : undefined
  return { category, subcategory }
}

/** Category of a note kept directly in a setting folder that no rule or property places. */
export const ROOT_CATEGORY = "General"

export function deriveMetadata(relativePath, data, config) {
  const rule = config.categoryRules?.find((candidate) =>
    new RegExp(candidate.pattern).test(relativePath),
  )
  const match = rule ? relativePath.match(new RegExp(rule.pattern)) : null
  const location = locateInSetting(relativePath, config.settings)
  const fromFolders = location ? categoryFromFolders(location.folders) : {}
  const category =
    data.category ??
    fromFolders.category ??
    rule?.category ??
    (location ? ROOT_CATEGORY : undefined)
  const subcategory =
    data.subcategory ?? fromFolders.subcategory ?? match?.groups?.subcategory ?? rule?.subcategory
  const catalogues = [data.catalogues ?? location?.catalogue ?? []].flat().filter(Boolean)
  const tags = data.tags
    ? [data.tags].flat()
    : [
        ...catalogues.map((name) => config.catalogues?.[name]?.tag).filter(Boolean),
        category && slug(category),
        subcategory && slug(subcategory),
      ].filter(Boolean)

  const metadata = {
    title: data.title ?? path.basename(relativePath, ".md"),
    author: data.author ?? config.defaultAuthor,
    category,
    ...(subcategory ? { subcategory } : {}),
    ...(catalogues.length ? { catalogues } : {}),
    tags: [...new Set(tags)],
  }
  for (const field of PASSTHROUGH_FIELDS) if (data[field]) metadata[field] = data[field]
  return metadata
}

const safeSegment = (value, relativePath) => {
  if (!value || /[\\/]/.test(value) || value === "." || value === "..")
    throw new Error(`${relativePath}: "${value}" cannot be used as a folder name`)
  return value
}

/**
 * Catalogue layout: content/catalogues/<folder>/<category>/[<subcategory>/]<file>, with the
 * catalogue's own note at content/catalogues/<folder>/Overview.md (a leaf rather than an
 * index, so the explorer can still reach it when folders only expand). Applies when the
 * note's catalogue configures a `folder`; other notes use their category's outputPaths template.
 */
export function catalogueOutputPath(relativePath, metadata, config) {
  const name =
    metadata.category === "Catalogue"
      ? (metadata.catalogues?.[0] ?? metadata.title)
      : metadata.catalogues?.[0]
  const folder = config.catalogues?.[name]?.folder
  if (!folder) return null
  const base = ["catalogues", safeSegment(folder, relativePath)]
  if (metadata.category === "Catalogue") return [...base, "Overview.md"].join("/")
  if (!metadata.category)
    throw new Error(
      `${relativePath}: no category. Set a category property, or keep the note in a category folder under its setting folder (${Object.keys(config.settings ?? {}).join(", ") || "none configured"}).`,
    )
  const category = config.categoryFolders?.[metadata.category] ?? metadata.category
  const flat = (config.flatCategories ?? []).includes(metadata.category)
  return [
    ...base,
    safeSegment(category, relativePath),
    ...(metadata.subcategory && !flat ? [safeSegment(metadata.subcategory, relativePath)] : []),
    path.basename(relativePath),
  ].join("/")
}

export function outputPathFor(relativePath, metadata, config) {
  const inCatalogue = catalogueOutputPath(relativePath, metadata, config)
  if (inCatalogue) return inCatalogue
  const template = config.outputPaths?.[metadata.category]
  if (!template)
    throw new Error(
      `${relativePath}: not placed in any catalogue (category "${metadata.category}"). Move it under a setting folder (${Object.keys(config.settings ?? {}).join(", ") || "none configured"}) or add a catalogues property naming a configured catalogue.`,
    )
  const values = {
    author: metadata.author,
    subcategory: metadata.subcategory ?? "",
    file: path.basename(relativePath),
    title: metadata.title,
  }
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!values[key]) throw new Error(`Missing ${key} for ${relativePath}`)
    return values[key]
  })
}

export function renderAuthorIndex(works, sections) {
  const blocks = []
  const list = (items) =>
    items
      .toSorted((a, b) => a.title.localeCompare(b.title))
      .map((work) => `- [[${work.basename}|${work.title}]]`)
      .join("\n")
  const details = (summary, items) =>
    `<details>\n<summary>${summary}</summary>\n\n${list(items)}\n\n</details>`

  for (const section of sections) {
    const members = works.filter((work) => work.category === section.category)
    if (!members.length) continue
    blocks.push(`## ${section.heading}`)
    if (!section.groupBySubcategory) {
      blocks.push(details(`Show ${section.label}`, members))
      continue
    }
    const groups = [...new Set(members.map((work) => work.subcategory ?? "Other"))].sort()
    for (const group of groups) {
      const lower = section.lowercaseSubcategory
      const shown =
        lower === true || (Array.isArray(lower) && lower.includes(group))
          ? group.toLowerCase()
          : group
      blocks.push(`### ${group}`)
      blocks.push(
        details(
          `Show ${shown} ${section.label}`,
          members.filter((work) => (work.subcategory ?? "Other") === group),
        ),
      )
    }
  }
  return blocks.join("\n\n")
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex")

/**
 * What a reader sees on a page: everything except bookkeeping lines (date, source commit,
 * generation notice, redirect aliases). Two pages with the same fingerprint are the same
 * publication, so moving a note to another folder does not change its date.
 */
export function publicFingerprint(markdown) {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^aliases:\n(?:[ \t]+- .*\n)+/m, "")
    .split("\n")
    .filter(
      (line) =>
        !/^(modified|source_commit): /.test(line) &&
        !line.startsWith("<!-- Generated from TheBigVaultOfDnD"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ---------------------------------------------------------------------------
// Filesystem / git
// ---------------------------------------------------------------------------

async function walk(root, directory, ignore, output = []) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name)
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/")
    if (ignore.some((name) => relative === name || relative.startsWith(`${name}/`))) continue
    if (item.isDirectory()) await walk(root, absolute, ignore, output)
    else if (item.isFile()) output.push(relative)
  }
  return output
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function vaultRevision(vault, relativePath) {
  try {
    const commit = git(vault, ["log", "-1", "--format=%H", "--", relativePath]).trim()
    return commit ? { commit: commit.slice(0, 12) } : null
  } catch {
    return null
  }
}

/**
 * The `modified` date for a generated page: the publish date when readers will see a change,
 * otherwise the page's existing date (or, for pages first published by hand, the date of
 * the site commit that last changed them).
 */
async function publishedDate(output, rendered, publishDate, previousOutputs = []) {
  // A moved note has no file at its new path yet: compare with where it used to be.
  const location = [output, ...previousOutputs].find((file) =>
    existsSync(path.join(repositoryRoot, file)),
  )
  if (!location) return publishDate
  const current = await readFile(path.join(repositoryRoot, location), "utf8")
  if (publicFingerprint(current) !== publicFingerprint(rendered)) return publishDate
  const existing = current.match(/^modified: (\S+)$/m)?.[1]
  if (existing) return existing
  return (await firstPublished(location, publicFingerprint(rendered))) ?? publishDate
}

/** Date of the oldest commit in the unbroken run of history where the page read the same. */
async function firstPublished(output, fingerprint) {
  let date = null
  try {
    const history = git(repositoryRoot, ["log", "--format=%H %cs", "--", output])
    for (const line of history.trim().split("\n").filter(Boolean)) {
      const [commit, commitDate] = line.split(" ")
      const text = git(repositoryRoot, ["show", `${commit}:${output}`])
      if (publicFingerprint(text) !== fingerprint) break
      date = commitDate
    }
  } catch {
    // Not committed yet, or the path was renamed: fall back to the publish date.
  }
  return date
}

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function dirtyPaths(vault) {
  try {
    return new Set(
      git(vault, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
    )
  } catch {
    return null // not a git checkout
  }
}

async function formatMarkdown(text, filepath) {
  const prettier = await import("prettier")
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

async function readLock(config) {
  const lockPath = path.join(repositoryRoot, config.lockFile)
  if (!existsSync(lockPath)) return { files: {}, assets: {}, indexes: {} }
  return JSON.parse(await readFile(lockPath, "utf8"))
}

async function removeEmptyParents(file) {
  let directory = path.dirname(file)
  while (directory.startsWith(contentRoot) && directory !== contentRoot) {
    try {
      await rmdir(directory)
    } catch {
      return
    }
    directory = path.dirname(directory)
  }
}

function indexRegion(text, file) {
  const opening = text.includes(CATALOGUE_START) ? CATALOGUE_START : INDEX_START
  const closing = opening === CATALOGUE_START ? CATALOGUE_END : INDEX_END
  const start = text.indexOf(opening)
  const end = text.indexOf(closing)
  if (start === -1 || end === -1 || end < start)
    throw new Error(`${file} needs ${INDEX_START} and ${INDEX_END} markers`)
  return { start: start + opening.length, end }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function check(config) {
  const lock = await readLock(config)
  const problems = []
  const verify = async (file, expected) => {
    const absolute = path.join(repositoryRoot, file)
    if (!existsSync(absolute)) return problems.push(`missing generated file: ${file}`)
    if (sha256(await readFile(absolute)) !== expected)
      problems.push(`hand-edited generated file: ${file}`)
  }
  for (const [file, entry] of Object.entries(lock.files)) await verify(file, entry.sha256)
  for (const [file, entry] of Object.entries(lock.assets)) await verify(file, entry.sha256)
  for (const [file, expected] of Object.entries(lock.indexes)) {
    const text = await readFile(path.join(repositoryRoot, file), "utf8")
    const { start, end } = indexRegion(text, file)
    if (sha256(text.slice(start, end)) !== expected)
      problems.push(`hand-edited works list in ${file}`)
  }
  for (const author of config.managedAuthors ?? []) {
    const directory = path.join(contentRoot, "authors", author)
    if (!existsSync(directory)) continue
    for (const file of await walk(repositoryRoot, directory, [])) {
      if (file === `content/authors/${author}/index.md`) continue
      if (!lock.files[file]) problems.push(`file not produced by vault sync: ${file}`)
    }
  }
  if (problems.length) {
    console.error(problems.map((problem) => `✗ ${problem}`).join("\n"))
    console.error(
      "\nPublished works are generated from TheBigVaultOfDnD. Edit the vault note and run `npm run sync:vault`.",
    )
    process.exitCode = 1
    return
  }
  console.log(
    `Vault sync check passed: ${Object.keys(lock.files).length} works, ${Object.keys(lock.assets).length} assets unchanged since generation`,
  )
}

async function sync(config, { vault, dryRun, allowDirty, publishDate }) {
  if (!existsSync(vault)) throw new Error(`Vault not found: ${vault} (use --vault or VAULT_DIR)`)
  const lock = await readLock(config)
  const files = await walk(vault, vault, config.ignoreFolders ?? [])
  const byBasename = new Map()
  for (const file of files) {
    const key = path.basename(file).toLowerCase()
    byBasename.set(key, [...(byBasename.get(key) ?? []), file])
  }

  // 1. Collect published notes.
  const notes = []
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    const markdown = await readFile(path.join(vault, file), "utf8")
    const { data, body } = splitFrontmatter(markdown)
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw new Error(`${file}: frontmatter must be a mapping`)
    if (data.publish !== undefined && typeof data.publish !== "boolean")
      throw new Error(`${file}: publish must be a YAML boolean`)
    if (data.publish !== true) continue
    for (const key of ["title", "author", "category", "subcategory", ...PASSTHROUGH_FIELDS]) {
      if (data[key] !== undefined && typeof data[key] !== "string")
        throw new Error(`${file}: ${key} must be text`)
    }
    for (const key of ["catalogues", "tags"]) {
      if (
        data[key] !== undefined &&
        ![data[key]].flat().every((value) => typeof value === "string")
      )
        throw new Error(`${file}: ${key} must contain text`)
    }
    const metadata = deriveMetadata(file, data, config)
    const output = `content/${outputPathFor(file, metadata, config)}`
    if (
      output.includes("\\") ||
      path.posix.normalize(output) !== output ||
      !output.startsWith("content/")
    )
      throw new Error(`${file}: unsafe output path`)
    const existing = lock.files[output]
    if (existsSync(path.join(repositoryRoot, output)) && !existing)
      throw new Error(`${file}: output is not owned by vault sync: ${output}`)
    notes.push({ source: file, data, body, metadata, output })
  }

  const errors = []
  const seenOutputs = new Map()
  for (const note of notes) {
    if (!note.metadata.category) errors.push(`${note.source}: no category rule matched`)
    const previous = seenOutputs.get(note.output)
    if (previous) errors.push(`${note.source} and ${previous} both publish to ${note.output}`)
    seenOutputs.set(note.output, note.source)
  }

  const dirty = dirtyPaths(vault)
  if (!allowDirty) {
    if (!dirty) errors.push(`${vault} is not a git checkout; pass --allow-dirty to sync anyway`)
    else
      for (const note of notes)
        if (dirty.has(note.source)) errors.push(`${note.source} has uncommitted changes`)
  }
  if (errors.length) throw new Error(errors.join("\n"))

  // 2. Link resolution: published vault notes first, then pages the site already owns.
  const names = new Set()
  for (const note of notes) {
    const name = path.basename(note.source, ".md").toLowerCase()
    if (names.has(name)) throw new Error(`Ambiguous published basename: ${name}`)
    names.add(name)
  }
  // Links name the page's full path rather than relying on Quartz's shortest-path guess, so
  // they stay correct when notes move between folders or share a file name across catalogues.
  const published = new Map(
    notes.map((note) => [
      path.basename(note.source, ".md").toLowerCase(),
      {
        target: note.output.slice("content/".length, -".md".length),
        display:
          note.metadata.category === "Catalogue"
            ? note.metadata.title
            : path.basename(note.source, ".md"),
      },
    ]),
  )
  const generatedOutputs = new Set(notes.map((note) => note.output))
  const sitePages = new Map(
    (await walk(repositoryRoot, contentRoot, []))
      .filter((file) => file.endsWith(".md") && !generatedOutputs.has(file) && !lock.files[file])
      .flatMap((file) => {
        const withoutExtension = file.slice("content/".length, -".md".length)
        return [
          [withoutExtension.toLowerCase(), withoutExtension],
          [path.basename(withoutExtension).toLowerCase(), path.basename(withoutExtension)],
        ]
      }),
  )
  const resolveNote = (name) => {
    const key = name.replace(/\.md$/i, "").toLowerCase()
    return published.get(path.basename(key)) ?? sitePages.get(key) ?? null
  }

  // 3. Render each note.
  const plannedFiles = {}
  const plannedAssets = {}
  const warnings = []
  for (const note of notes) {
    const assetDirectory =
      note.metadata.catalogues?.map((name) => config.catalogues?.[name]?.assets).find(Boolean) ??
      `assets/${slug(note.metadata.author)}`
    const resolveAsset = (name) => {
      const candidates = byBasename.get(path.basename(name).toLowerCase()) ?? []
      const suffixMatches = candidates.filter((candidate) => candidate.endsWith(name))
      const pool = suffixMatches.length ? suffixMatches : candidates
      if (!pool.length) return null
      if (pool.length !== 1) throw new Error(`Ambiguous image reference: ${name}`)
      const source = pool[0]
      const publicPath = `${assetDirectory}/${path.basename(source)}`
      const planned = plannedAssets[`content/${publicPath}`]
      if (planned && planned.source !== source)
        throw new Error(
          `Two different images publish to ${publicPath}: ${planned.source}, ${source}`,
        )
      plannedAssets[`content/${publicPath}`] = { source }
      return publicPath
    }

    const revision = vaultRevision(vault, note.source)
    const linked = rewriteLinks(stripComments(note.body), { resolveNote, resolveAsset })
    warnings.push(...linked.warnings.map((warning) => `${note.source}: ${warning}`))
    // Where this note was published before: those URLs redirect. A vault move changes the
    // note's path but not its (unique) file name, so the file name identifies it; an output
    // still produced this run belongs to another page.
    const sameNote = (entry) =>
      path.basename(entry.source).toLowerCase() === path.basename(note.source).toLowerCase()
    const previous = Object.entries(lock.files).filter(
      ([output, entry]) =>
        sameNote(entry) && output !== note.output && !generatedOutputs.has(output),
    )
    const own = note.output.slice("content/".length, -".md".length)
    const aliases = [
      ...new Set([
        ...previous.flatMap(([output, entry]) => [
          output.slice("content/".length, -".md".length),
          ...(entry.aliases ?? []),
        ]),
        ...(lock.files[note.output]?.aliases ?? []),
      ]),
    ].filter((alias) => alias !== own)
    const frontmatter = {
      ...note.metadata,
      ...(aliases.length ? { aliases } : {}),
      source_commit: dirty?.has(note.source) ? "uncommitted" : (revision?.commit ?? "unknown"),
    }
    const document = [
      `---\n${YAML.stringify(frontmatter).trim()}\n---`,
      `<!-- Generated from TheBigVaultOfDnD: ${note.source}. Edit the vault note, then run npm run sync:vault. -->`,
      normaliseHeadings(linked.body, note.metadata.title),
    ].join("\n\n")
    const absolute = path.join(repositoryRoot, note.output)
    const undated = await formatMarkdown(`${document}\n`, absolute)
    const modified =
      note.data.modified ??
      (await publishedDate(
        note.output,
        undated,
        publishDate,
        previous.map(([output]) => output),
      ))
    let formatted = undated.replace(/\nsource_commit: /, `\nmodified: ${modified}\nsource_commit: `)
    const current = existsSync(absolute) ? await readFile(absolute, "utf8") : null
    if (
      current &&
      lock.files[note.output]?.source === note.source &&
      publicFingerprint(current) === publicFingerprint(formatted) &&
      (!note.data.modified || splitFrontmatter(current).data.modified === note.data.modified)
    ) {
      formatted = current
    }
    plannedFiles[note.output] = {
      source: note.source,
      commit: splitFrontmatter(formatted).data.source_commit,
      sha256: sha256(formatted),
      text: formatted,
      metadata: note.metadata,
      aliases,
    }
  }
  for (const [output, asset] of Object.entries(plannedAssets))
    asset.sha256 = sha256(await readFile(path.join(vault, asset.source)))

  // 4. Author index works lists.
  const plannedIndexes = {}
  for (const author of config.managedAuthors ?? []) {
    const file = `content/authors/${author}/index.md`
    const absolute = path.join(repositoryRoot, file)
    if (!existsSync(absolute)) continue
    const works = Object.entries(plannedFiles)
      .filter(
        ([output, entry]) =>
          entry.metadata.author === author && output.startsWith("content/authors/"),
      )
      .map(([output, entry]) => ({ ...entry.metadata, basename: path.basename(output, ".md") }))
    const current = await readFile(absolute, "utf8")
    const { start, end } = indexRegion(current, file)
    const spliced = `${current.slice(0, start)}\n\n${renderAuthorIndex(works, config.authorIndex)}\n\n${current.slice(end)}`
    const formatted = await formatMarkdown(spliced, absolute)
    const region = indexRegion(formatted, file)
    plannedIndexes[file] = {
      text: formatted,
      sha256: sha256(formatted.slice(region.start, region.end)),
    }
  }

  // Catalogue navigation is derived from published catalogue pages.
  const catalogueLinks = Object.entries(plannedFiles)
    .filter(([, entry]) => entry.metadata.category === "Catalogue")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => {
      const presentation = config.catalogueNavigation?.[entry.metadata.title] ?? {}
      const title = presentation.label ?? entry.metadata.title
      return `- **[[${file.slice("content/".length, -3)}|${title}]]**.${presentation.description ? ` ${presentation.description}` : ""}`
    })
    .join("\n")
  for (const file of ["content/index.md", "content/catalogues/index.md"]) {
    const current = await readFile(path.join(repositoryRoot, file), "utf8")
    if (!current.includes(CATALOGUE_START)) throw new Error(`${file}: missing catalogue markers`)
    const region = indexRegion(current, file)
    const text = await formatMarkdown(
      `${current.slice(0, region.start)}\n\n${catalogueLinks}\n\n${current.slice(region.end)}`,
      path.join(repositoryRoot, file),
    )
    const next = indexRegion(text, file)
    plannedIndexes[file] = { text, sha256: sha256(text.slice(next.start, next.end)) }
  }

  // 5. Diff against disk and apply.
  const actions = []
  const readIfExists = async (file) =>
    existsSync(path.join(repositoryRoot, file)) ? readFile(path.join(repositoryRoot, file)) : null
  for (const [file, entry] of Object.entries(plannedFiles)) {
    const current = await readIfExists(file)
    if (current === null) actions.push(["add", file])
    else if (sha256(current) !== entry.sha256) actions.push(["update", file])
  }
  for (const [file, entry] of Object.entries(plannedAssets)) {
    const current = await readIfExists(file)
    if (current === null) actions.push(["add", file])
    else if (sha256(current) !== entry.sha256) actions.push(["update", file])
  }
  for (const [file, entry] of Object.entries(plannedIndexes))
    if ((await readFile(path.join(repositoryRoot, file), "utf8")) !== entry.text)
      actions.push(["update", file])
  for (const file of [...Object.keys(lock.files), ...Object.keys(lock.assets)])
    if (!plannedFiles[file] && !plannedAssets[file] && existsSync(path.join(repositoryRoot, file)))
      actions.push(["remove", file])

  for (const warning of warnings) console.warn(`! ${warning}`)
  for (const [action, file] of actions) console.log(`${action.padEnd(6)} ${file}`)
  console.log(
    `${notes.length} published notes, ${Object.keys(plannedAssets).length} assets, ${actions.length} change(s)${dryRun ? " (dry run)" : ""}`,
  )
  if (dryRun) return

  for (const [action, file] of actions) {
    const absolute = path.join(repositoryRoot, file)
    if (action === "remove") {
      await rm(absolute)
      await removeEmptyParents(absolute)
      continue
    }
    await mkdir(path.dirname(absolute), { recursive: true })
    if (plannedAssets[file]) await copyFile(path.join(vault, plannedAssets[file].source), absolute)
    else await writeFile(absolute, (plannedFiles[file] ?? plannedIndexes[file]).text)
  }

  const sortedEntries = (object, pick) =>
    Object.fromEntries(
      Object.entries(object)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, pick(value)]),
    )
  const nextLock = {
    note: "Generated by scripts/sync-from-vault.mjs. Do not edit.",
    files: sortedEntries(plannedFiles, ({ source, commit, sha256, aliases }) => ({
      source,
      commit,
      sha256,
      ...(aliases.length ? { aliases } : {}),
    })),
    assets: sortedEntries(plannedAssets, ({ source, sha256 }) => ({ source, sha256 })),
    indexes: sortedEntries(plannedIndexes, ({ sha256 }) => sha256),
  }
  // Formatted like everything else in the repository: Prettier keeps short arrays (the
  // redirect aliases) on one line, which JSON.stringify would not.
  const lockPath = path.join(repositoryRoot, config.lockFile)
  await writeFile(
    lockPath,
    await formatMarkdown(`${JSON.stringify(nextLock, null, 2)}\n`, lockPath),
  )
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const config = YAML.parse(
    await readFile(path.join(repositoryRoot, "vault-sync.config.yaml"), "utf8"),
  )
  const flag = (name) => argv.includes(name)
  const valueOf = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  if (flag("--check")) return check(config)
  const vault = path.resolve(
    repositoryRoot,
    valueOf("--vault") ?? process.env.VAULT_DIR ?? config.vault,
  )
  const publishDate = valueOf("--date") ?? localDate()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error("--date must be YYYY-MM-DD")
  return sync(config, {
    vault,
    dryRun: flag("--dry-run"),
    allowDirty: flag("--allow-dirty"),
    publishDate,
  })
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
