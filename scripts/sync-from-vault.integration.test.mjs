import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  renameSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
test("published projection lifecycle and private-only no-op", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "vault-export-test-"))
  const site = path.join(temporary, "site"),
    vault = path.join(temporary, "vault")
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  const write = (dir, file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  const commit = (dir) => {
    git(dir, "add", ".")
    git(dir, "commit", "--allow-empty", "-qm", "fixture")
  }
  const sync = () =>
    execFileSync(
      process.execPath,
      [path.join(site, "scripts/sync-from-vault.mjs"), "--vault", vault],
      { encoding: "utf8", stdio: "pipe" },
    )
  const note = (body) => `---\npublish: true\ncategory: Rules\n---\n${body}\n`
  try {
    for (const dir of [site, vault]) {
      mkdirSync(dir)
      git(dir, "init", "-q")
      git(dir, "config", "user.name", "Test")
      git(dir, "config", "user.email", "test@example.com")
    }
    write(site, "scripts/placeholder", "")
    copyFileSync(
      path.join(root, "scripts/sync-from-vault.mjs"),
      path.join(site, "scripts/sync-from-vault.mjs"),
    )
    symlinkSync(path.join(root, "node_modules"), path.join(site, "node_modules"))
    write(site, ".gitignore", "node_modules\n")
    write(
      site,
      "vault-sync.config.yaml",
      'defaultAuthor: Test\nmanagedAuthors: []\ncategoryRules: []\nlockFile: vault-sync.lock.json\nignoreFolders: [.git]\noutputPaths:\n  Rules: "authors/{author}/{file}"\n  Catalogue: "catalogues/{title}.md"\n',
    )
    for (const file of ["index.md", "catalogues/index.md"])
      write(
        site,
        `content/${file}`,
        "Intro\n\n<!-- vault-sync:catalogues:start -->\n\n<!-- vault-sync:catalogues:end -->\n",
      )
    write(vault, "Rule.md", note("Public text %%private%%"))
    commit(vault)
    sync()
    commit(site)
    const clean = () => assert.equal(git(site, "status", "--porcelain"), "")
    sync()
    clean()
    write(vault, "Private.md", "private-only")
    write(vault, "unreferenced.png", "unused")
    commit(vault)
    sync()
    clean()
    write(
      vault,
      "Rule.md",
      note("Public text %%changed secret%%").replace(
        "category: Rules",
        "category: Rules\ninternal_status: edited",
      ),
    )
    commit(vault)
    sync()
    clean()
    write(vault, "Rule.md", note("Updated public text ![[image.png]]"))
    write(vault, "image.png", "one")
    commit(vault)
    sync()
    assert.match(
      readFileSync(path.join(site, "content/authors/Test/Rule.md"), "utf8"),
      /Updated public text/,
    )
    commit(site)
    write(vault, "image.png", "two")
    commit(vault)
    sync()
    assert.match(git(site, "status", "--porcelain"), /image.png/)
    commit(site)
    write(vault, "Collection.md", "---\npublish: true\ncategory: Catalogue\n---\n[[Rule]]\n")
    commit(vault)
    sync()
    assert.match(readFileSync(path.join(site, "content/index.md"), "utf8"), /Collection/)
    commit(site)
    renameSync(path.join(vault, "Rule.md"), path.join(vault, "Renamed.md"))
    commit(vault)
    sync()
    assert.match(git(site, "status", "--porcelain"), /D .*Rule.md/)
    commit(site)
    write(
      vault,
      "Renamed.md",
      note("Updated public text").replace("publish: true", "publish: false"),
    )
    commit(vault)
    sync()
    assert.match(git(site, "status", "--porcelain"), /D .*image.png/)
    commit(site)
    rmSync(path.join(vault, "Collection.md"))
    commit(vault)
    sync()
    assert.doesNotMatch(
      readFileSync(path.join(site, "content/index.md"), "utf8"),
      /\[\[.*Collection/,
    )
    commit(site)
    write(vault, "Bad.md", '---\npublish: "true"\n---\nText')
    commit(vault)
    assert.throws(sync, /publish must be a YAML boolean/)
    rmSync(path.join(vault, "Bad.md"))
    write(vault, "Missing.md", note("![[absent.png]]"))
    commit(vault)
    assert.throws(sync, /absent.png/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
