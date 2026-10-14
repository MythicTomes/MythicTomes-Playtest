import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot determine deployment commit")
await writeFile("public/deployment.json", `${JSON.stringify({ commit })}\n`)
