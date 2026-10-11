import assert from "node:assert/strict"
import test from "node:test"
import {
  deriveMetadata,
  normaliseHeadings,
  outputPathFor,
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
