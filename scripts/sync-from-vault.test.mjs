import assert from "node:assert/strict"
import test from "node:test"
import {
  deriveMetadata,
  normaliseHeadings,
  outputPathFor,
  publicFingerprint,
  renderAuthorIndex,
  rewriteLinks,
  splitFrontmatter,
  stripComments,
} from "./sync-from-vault.mjs"

const config = {
  defaultAuthor: "Ekenwars",
  categoryRules: [
    { pattern: "^Homebrew Vault/Races/", category: "Species", subcategory: "Legacy Species" },
    { pattern: "^Homebrew Vault/Subclasses/(?<subcategory>[^/]+)/", category: "Subclass" },
  ],
  outputPaths: {
    Species: "authors/{author}/Species/{file}",
    Subclass: "authors/{author}/Subclasses/{subcategory}/{file}",
  },
  catalogues: { "Hongshan Playtest": { tag: "hongshan" } },
}

test("derives metadata from the vault path and catalogue", () => {
  const metadata = deriveMetadata(
    "Homebrew Vault/Subclasses/Monk/Way of the Lion Dance.md",
    { publish: true, catalogues: ["Hongshan Playtest"] },
    config,
  )
  assert.deepEqual(metadata, {
    title: "Way of the Lion Dance",
    author: "Ekenwars",
    category: "Subclass",
    subcategory: "Monk",
    catalogues: ["Hongshan Playtest"],
    tags: ["hongshan", "subclass", "monk"],
  })
  assert.equal(
    outputPathFor("Homebrew Vault/Subclasses/Monk/Way of the Lion Dance.md", metadata, config),
    "authors/Ekenwars/Subclasses/Monk/Way of the Lion Dance.md",
  )
})

test("frontmatter values override derived ones", () => {
  const metadata = deriveMetadata(
    "Homebrew Vault/Races/Ratfolk.md",
    { title: "Rat Folk", subcategory: "Species", tags: ["custom"] },
    config,
  )
  assert.equal(metadata.title, "Rat Folk")
  assert.equal(metadata.subcategory, "Species")
  assert.deepEqual(metadata.tags, ["custom"])
})

const settingConfig = {
  defaultAuthor: "Ekenwars",
  settings: { "Setting A": "Alpha" },
  categoryRules: [
    { pattern: "Catalogue\\.md$", category: "Catalogue" },
    { pattern: "^Homebrew Vault/Races/", category: "Species", subcategory: "Legacy Species" },
    { pattern: "^Homebrew Vault/Subclasses/(?<subcategory>[^/]+)/", category: "Subclass" },
  ],
  categoryFolders: { Subclass: "Subclasses" },
  flatCategories: ["Species"],
  catalogues: {
    Alpha: { tag: "alpha", folder: "AlphaSite" },
    Beta: { tag: "beta", folder: "Beta" },
  },
}

test("a note's catalogue and category come from its setting folder", () => {
  const metadata = deriveMetadata("Setting A/Brand New Folder/Thing.md", {}, settingConfig)
  assert.equal(metadata.category, "Brand New Folder")
  assert.deepEqual(metadata.catalogues, ["Alpha"])
  assert.deepEqual(metadata.tags, ["alpha", "brand-new-folder"])
  assert.equal(
    outputPathFor("Setting A/Brand New Folder/Thing.md", metadata, settingConfig),
    "catalogues/AlphaSite/Brand New Folder/Thing.md",
  )
  const nested = deriveMetadata("Setting A/Classes/Monk/Thing.md", {}, settingConfig)
  assert.equal(nested.subcategory, "Monk")
  assert.equal(
    outputPathFor("Setting A/Classes/Monk/Thing.md", nested, settingConfig),
    "catalogues/AlphaSite/Classes/Monk/Thing.md",
  )
})

test("properties beat the setting folder and legacy rules fill the gaps", () => {
  const moved = deriveMetadata(
    "Setting A/Rules/Thing.md",
    { catalogues: ["Beta"], category: "Lore" },
    settingConfig,
  )
  assert.deepEqual([moved.category, moved.catalogues], ["Lore", ["Beta"]])
  assert.equal(
    outputPathFor("Setting A/Rules/Thing.md", moved, settingConfig),
    "catalogues/Beta/Lore/Thing.md",
  )

  const legacy = deriveMetadata(
    "Homebrew Vault/Subclasses/Monk/Way.md",
    { catalogues: ["Beta"] },
    settingConfig,
  )
  assert.equal(
    outputPathFor("Homebrew Vault/Subclasses/Monk/Way.md", legacy, settingConfig),
    "catalogues/Beta/Subclasses/Monk/Way.md",
  )
})

test("flat categories keep their subcategory out of the path", () => {
  const species = deriveMetadata(
    "Homebrew Vault/Races/Ratfolk.md",
    { catalogues: "Beta" },
    settingConfig,
  )
  assert.equal(species.subcategory, "Legacy Species")
  assert.equal(
    outputPathFor("Homebrew Vault/Races/Ratfolk.md", species, settingConfig),
    "catalogues/Beta/Species/Ratfolk.md",
  )
})

test("a catalogue note becomes its Overview, found by property or title", () => {
  const byProperty = deriveMetadata(
    "Setting A/Alpha Catalogue.md",
    { catalogues: ["Alpha"] },
    settingConfig,
  )
  assert.equal(byProperty.category, "Catalogue")
  assert.equal(
    outputPathFor("Setting A/Alpha Catalogue.md", byProperty, settingConfig),
    "catalogues/AlphaSite/Overview.md",
  )
  const byTitle = deriveMetadata("Elsewhere/Beta Catalogue.md", { title: "Beta" }, settingConfig)
  assert.equal(
    outputPathFor("Elsewhere/Beta Catalogue.md", byTitle, settingConfig),
    "catalogues/Beta/Overview.md",
  )
})

test("placement problems name the file and the fix", () => {
  const loose = deriveMetadata("Setting A/Loose.md", {}, settingConfig)
  assert.throws(
    () => outputPathFor("Setting A/Loose.md", loose, settingConfig),
    /Setting A\/Loose\.md: no category/,
  )
  const homeless = deriveMetadata("Elsewhere/Thing.md", { category: "Rules" }, settingConfig)
  assert.throws(
    () => outputPathFor("Elsewhere/Thing.md", homeless, settingConfig),
    /Elsewhere\/Thing\.md: not placed in any catalogue.*Setting A/,
  )
  assert.throws(
    () =>
      outputPathFor(
        "Setting A/x/Thing.md",
        { category: "..", catalogues: ["Alpha"] },
        settingConfig,
      ),
    /cannot be used as a folder name/,
  )
})

test("links to full paths keep the author's text, including inside tables", () => {
  const resolveNote = () => ({ target: "catalogues/A/Rules/Hunting", display: "Hunting" })
  const rewrite = (body) => rewriteLinks(body, { resolveNote, resolveAsset: () => null }).body
  assert.equal(rewrite("See [[Hunting]]."), "See [[catalogues/A/Rules/Hunting|Hunting]].")
  assert.equal(
    rewrite("See [[Hunting|the rules]]."),
    "See [[catalogues/A/Rules/Hunting|the rules]].",
  )
  assert.equal(rewrite("See [[Hunting#Gear]]."), "See [[catalogues/A/Rules/Hunting#Gear]].")
  assert.equal(rewrite("| [[Hunting]] | x |"), "| [[catalogues/A/Rules/Hunting\\|Hunting]] | x |")
  assert.equal(rewrite("![[Hunting]]"), "![[catalogues/A/Rules/Hunting]]")
})

test("redirect aliases are not part of what readers see", () => {
  const page = "---\ntitle: A\naliases:\n  - old/path\n  - older/path\ntags:\n  - x\n---\nBody"
  assert.equal(
    publicFingerprint(page),
    publicFingerprint(page.replace(/aliases:\n(  - .*\n)+/, "")),
  )
  assert.notEqual(publicFingerprint(page), publicFingerprint(page.replace("Body", "Changed")))
})

test("splits frontmatter and tolerates CRLF", () => {
  const { data, body } = splitFrontmatter("---\r\npublish: true\r\n---\r\n\r\nBody\r\n")
  assert.equal(data.publish, true)
  assert.equal(body, "\nBody\n")
})

test("promotes a leading title heading to H2 and keeps relative depth", () => {
  const out = normaliseHeadings("### Oath\n\n#### Level 3: A\n\n##### Spells", "Oath")
  assert.equal(out, "## Oath\n\n### Level 3: A\n\n#### Spells")
})

test("inserts the title when a note starts with prose", () => {
  const out = normaliseHeadings("Some flavour.\n\n## Traits", "Ratfolk")
  assert.equal(out, "## Ratfolk\n\nSome flavour.\n\n### Traits")
})

test("never rewrites headings, links or comments inside code fences", () => {
  const body = "## Title\n\n```statblock\n# not a heading\n[[Link]] %%x%%\n```"
  assert.equal(normaliseHeadings(body, "Title"), body)
  assert.equal(stripComments(body), body)
  const { body: linked } = rewriteLinks(body, { resolveNote: () => null, resolveAsset: () => null })
  assert.equal(linked, body)
})

test("strips private Obsidian comments", () => {
  assert.equal(stripComments("Rules %%private DM note%%text"), "Rules text")
  assert.equal(stripComments("A\n%%\nmulti\nline\n%%\nB"), "A\n\nB")
})

test("rewrites embeds, keeps published links and unlinks private notes", () => {
  const published = new Map([
    ["ratfolk", "Ratfolk"],
    ["hongshan playtest catalogue", "Hongshan Playtest"],
  ])
  const { body, warnings } = rewriteLinks(
    [
      "![[Images/rat.png|300]]",
      "[[Ratfolk#Traits|the traits]]",
      "| [[Hongshan Playtest Catalogue\\|Catalogue]] |",
      "See [[White Gate Travel]] and [[DM Notes/Secret|the plan]].",
      "![[Private Note]]",
    ].join("\n"),
    {
      resolveNote: (name) => published.get(name.toLowerCase()) ?? null,
      resolveAsset: (name) => `assets/ekenwars/hongshan/${name.split("/").pop()}`,
    },
  )
  assert.equal(
    body,
    [
      "![[assets/ekenwars/hongshan/rat.png|300]]",
      "[[Ratfolk#Traits|the traits]]",
      "| [[Hongshan Playtest\\|Catalogue]] |",
      "See White Gate Travel and the plan.",
      "",
    ].join("\n"),
  )
  assert.equal(warnings.length, 3)
})

test("fails loudly when an embedded image is missing", () => {
  assert.throws(
    () => rewriteLinks("![[missing.png]]", { resolveNote: () => null, resolveAsset: () => null }),
    /missing\.png/,
  )
})

test("renders grouped author index sections", () => {
  const works = [
    {
      basename: "Hongshan Weapons",
      title: "Hongshan Weapon Expansion",
      category: "Rules and Mechanics",
      subcategory: "Hongshan",
    },
    {
      basename: "Survival Gear",
      title: "Survival Gear",
      category: "Rules and Mechanics",
      subcategory: "General",
    },
    { basename: "Ratfolk", title: "Ratfolk", category: "Species", subcategory: "Legacy Species" },
  ]
  const out = renderAuthorIndex(works, [
    {
      category: "Rules and Mechanics",
      heading: "Rules and Mechanics",
      label: "rules and mechanics",
      groupBySubcategory: true,
      lowercaseSubcategory: ["General"],
    },
    { category: "Species", heading: "Species", label: "species" },
  ])
  assert.match(
    out,
    /### General\n\n<details>\n<summary>Show general rules and mechanics<\/summary>/,
  )
  assert.match(
    out,
    /<summary>Show Hongshan rules and mechanics<\/summary>\n\n- \[\[Hongshan Weapons\|Hongshan Weapon Expansion\]\]/,
  )
  assert.match(
    out,
    /## Species\n\n<details>\n<summary>Show species<\/summary>\n\n- \[\[Ratfolk\|Ratfolk\]\]/,
  )
})

test("fingerprint ignores bookkeeping lines but not content", () => {
  const page = (date, commit, text) =>
    `---\ntitle: A\nmodified: ${date}\nsource_commit: ${commit}\n---\n\n<!-- Generated from TheBigVaultOfDnD: a.md. -->\n\n${text}\n`
  assert.equal(
    publicFingerprint(page("2026-09-10", "aaa", "Body")),
    publicFingerprint(page("2026-10-11", "bbb", "Body")),
  )
  assert.equal(
    publicFingerprint("---\ntitle: A\n---\n\nBody\n"),
    publicFingerprint(page("2026-10-11", "bbb", "Body")),
  )
  assert.notEqual(
    publicFingerprint(page("2026-09-10", "aaa", "Body")),
    publicFingerprint(page("2026-09-10", "aaa", "Body!")),
  )
})
