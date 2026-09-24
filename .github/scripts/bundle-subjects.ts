// Writes bundle-subjects.sha256 for actions/attest (`subject-checksums`):
// one `<sha256>  <file name>` line per bundle a release leg built, taken
// from tauri-action's `artifactPaths` output. Two kinds of entry are not
// subjects: the `.sig` files (signatures over the bundles, verified by
// verify-updater-manifest.sh) and the macOS `.app` directory (it ships
// inside the .dmg and the .app.tar.gz, which are attested).
//
// Usage (release.yml): ARTIFACT_PATHS='<artifactPaths JSON>' node .github/scripts/bundle-subjects.ts

import { hash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const paths: string[] = JSON.parse(process.env.ARTIFACT_PATHS ?? "[]");

let subjects = "";
for (const path of paths) {
  if (path.endsWith(".sig") || !(await stat(path)).isFile()) continue;
  subjects += `${hash("sha256", await readFile(path))}  ${basename(path)}\n`;
}
if (subjects === "") throw new Error("tauri-action reported no bundles to attest");

await writeFile("bundle-subjects.sha256", subjects);
process.stdout.write(subjects);
