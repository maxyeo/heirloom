import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGedcom } from "@/lib/gedcom";
import { mapGedcom } from "@/lib/gedcom-map";
import { rowsFromMapping } from "@/lib/import-rows";

import { grampsCorpus } from "./corpus";

/**
 * Open this application's exports in Gramps, and say what Gramps thought
 * (`YEO-91`).
 *
 * ## Why a container
 *
 * `YEO-51` named Gramps in an acceptance criterion because it is free and
 * **strict**, and then met that criterion by proxy: Gramps needs PyGObject
 * and GTK, `pip install gramps` succeeds and dies on `import gi`, and two
 * permissive third-party parsers were run instead. Permissive parsers
 * agreeing is a weaker claim than a strict one accepting, which is the whole
 * reason Gramps was named.
 *
 * Debian packages Gramps with that stack already assembled, so a four-line
 * `Dockerfile` gets the real program running and `gramps -C … -i …` imports a
 * file with no display attached. That is the entire trick, and it is why this
 * file exists rather than another paragraph of apology in `docs/gedcom.md`.
 *
 * ## Why it is not a test
 *
 * `npm test` runs in CI's bare job with no Docker and no network, and a suite
 * that needs a 230 MB apt install is not a suite anybody runs before pushing.
 * This is a command — `npm run gramps:check` — run deliberately when the
 * export changes, and its result is written down in `test/gramps/README.md`
 * so that a reader who cannot run it still knows what it said and when.
 *
 * The parts that *can* be a test are: `lib/gedcom-round-trip.test.ts` holds
 * the export to a fixed point, and `lib/gedcom-map.test.ts` holds the one
 * defect this run found — `PEDI stepchild`, the spelling Gramps writes — to
 * the fix.
 *
 * ## What it checks, in order
 *
 * 1. Every file in `test/gramps/corpus.ts` imports into a fresh Gramps tree,
 *    and Gramps' own import report is printed verbatim.
 * 2. A **negative control**: `test/fixtures/gedcom/dirty-third-party.ged`,
 *    which is not our export and is dirty on purpose. Without it, "No errors
 *    detected" is unfalsifiable — a run that could not fail proves nothing,
 *    and this is the line that shows the check has teeth.
 * 3. The out-and-back leg: Gramps re-exports what it imported, and this
 *    application reads *that* file. A reader can accept a file and still lose
 *    what is in it, so the counts and the issue list on the way home are the
 *    part that says nothing was dropped in the middle.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/gedcom/", import.meta.url));

/** The tag the image is built under. Local to this machine; never pushed. */
const IMAGE = "heirloom-gramps";

/** The one fixture handed to Gramps unmodified, to prove the check can fail. */
const CONTROL = "dirty-third-party.ged";

/**
 * Gramps' own noise, which is about the container rather than about the file.
 *
 * Three lines appear on every run: PyICU is not installed (Debian keeps it out
 * of the dependency set), glibc in a slim image has no locales generated, and
 * GTK cannot find an icon theme with no display attached. None of them is
 * produced by reading GEDCOM, and leaving them in would bury the four lines
 * that are.
 */
const CONTAINER_NOISE =
  /ICU not loaded|Locale not supported|fallback 'C' locale|Gtk-CRITICAL|Gtk-WARNING|^\s*$/;

/**
 * Gramps' progress meters, which are a terminal animation rather than output.
 *
 * `gramps` writes a percentage per record and a phase name per object on the
 * same line it later puts the import report on, so the report cannot simply
 * be grepped out — the meter has to be erased from around it instead.
 */
const PROGRESS = /[0-9]+%|(?: ?Writing (?:individuals|families|[a-z]+))+/g;

/**
 * A command, for its standard output.
 *
 * `stderr` is captured rather than inherited, because Gramps writes the
 * container's three complaints there on every single invocation and they
 * would otherwise reach the terminal ahead of the output they are being
 * filtered out of. A non-zero exit still throws, carrying `stderr` on the
 * error, so nothing is being swallowed — only reordered.
 */
function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Gramps' output, with the container's complaints and its progress bar out.
 *
 * Split on a bare `\r` as well as on a newline, because that is what the
 * progress meter actually is: one physical line rewritten a few hundred times.
 * Erasing the percentages is not enough on its own — the carriage returns are
 * left behind, and anything that later normalises line endings (Prettier, on
 * the transcript pasted into `README.md`) turns each one into a blank line.
 */
function readable(output: string): string {
  return output
    .replaceAll(PROGRESS, "")
    .split(/\r\n|[\n\r]/)
    .map((line) => line.trimEnd())
    .filter((line) => !CONTAINER_NOISE.test(line))
    .join("\n");
}

/**
 * Import each file into a tree of its own, and re-export the ones we read back.
 *
 * One container for the whole run: building the image is the slow part, and a
 * container per file would pay the start-up cost five times over for no
 * isolation that `-C <name>` does not already give.
 */
function grampsScript(names: readonly string[]): string {
  const lines = [
    // Gramps writes its settings under $HOME and the image has no home for
    // the user Docker runs as, so it is given one that lives and dies here.
    "set -e",
    "mkdir -p /tmp/home",
    "export HOME=/tmp/home",
  ];

  for (const name of names) {
    const tree = name.replace(/\.ged$/, "");
    lines.push(`echo "=== ${name} ==="`);
    lines.push(
      `gramps -C "${tree}" -i "/corpus/${name}" -e "/out/${tree}.from-gramps.ged" 2>&1`,
    );
  }

  lines.push(`echo "=== ${CONTROL} (negative control) ==="`);
  lines.push(`gramps -C control -i "/fixtures/${CONTROL}" 2>&1`);

  return lines.join("\n");
}

/** What this application reads back out of the file Gramps wrote. */
function readBack(path: string): string {
  const mapping = mapGedcom(parseGedcom(readFileSync(path)));
  const rows = rowsFromMapping(mapping);

  const relations = [...new Set(rows.unionChildren.map((one) => one.relation))];

  return [
    `${rows.individuals.length} individuals, ${rows.unions.length} unions, ${rows.unionChildren.length} child links`,
    `relations: ${relations.sort().join(", ")}`,
    mapping.issues.length === 0
      ? "issues: none"
      : `issues:\n  ${mapping.issues.map((one) => one.message).join("\n  ")}`,
  ].join("\n");
}

const corpus = grampsCorpus();
const names = Object.keys(corpus);

const work = mkdtempSync(join(tmpdir(), "heirloom-gramps-"));
const corpusDir = join(work, "corpus");
const outDir = join(work, "out");
mkdirSync(corpusDir);
mkdirSync(outDir);

for (const [name, text] of Object.entries(corpus)) {
  writeFileSync(join(corpusDir, name), text);
}

console.log(`Building ${IMAGE} from test/gramps/Dockerfile…`);
run("docker", ["build", "--quiet", "--tag", IMAGE, HERE]);

// `--version` prints the whole environment. The four lines below are the ones
// that say *which* Gramps this was and that the GTK stack the previous attempt
// died on is actually present.
const version = readable(
  run("docker", ["run", "--rm", IMAGE, "bash", "-c", "gramps --version 2>&1"]),
)
  .split("\n")
  .filter((line) => /^ (?:gramps|Python|Gtk\+*|pygobject) *:/.test(line))
  .join("\n");

console.log(version);

console.log(
  readable(
    run("docker", [
      "run",
      "--rm",
      "--volume",
      `${corpusDir}:/corpus:ro`,
      "--volume",
      `${FIXTURES}:/fixtures:ro`,
      "--volume",
      `${outDir}:/out`,
      IMAGE,
      "bash",
      "-c",
      grampsScript(names),
    ]),
  ),
);

console.log("=== read back into this application ===");
for (const name of names) {
  const tree = name.replace(/\.ged$/, "");
  console.log(`--- ${tree}.from-gramps.ged ---`);
  console.log(readBack(join(outDir, `${tree}.from-gramps.ged`)));
}
