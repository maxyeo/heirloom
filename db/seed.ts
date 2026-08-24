import "../lib/load-env";

import { slugFromTitle } from "../lib/entry-slug";
import { db, schema } from "./index";
import { assertSeedTarget } from "./seed-guard";
import { THOMAS_ENTRY_ID, seedFamily, seedPerson } from "./seed-family";

/** Who the seeded entry and its first revision are attributed to. */
const SEED_AUTHOR = "seed@example.com";

/**
 * Seed script.
 *
 * The family itself is `db/seed-family.ts` — its shape, its dates, and the
 * reasoning behind both. This file only writes it, and deliberately decides
 * nothing: a fixture that lives in a script can only ever be read by running
 * the script, which is why the values moved out and `lib/tree-layout.seed.
 * test.ts` can now assert the layout of the very rows a developer sees after
 * `npm run db:seed`.
 *
 * The entry is written first, because `individuals.page_id` is a foreign key
 * and Thomas carries his already. It is one page and one revision, written
 * together, because that is the invariant `lib/create-page.ts` holds: an
 * entry's history starts at the moment the entry does. The body is the stub
 * an author would be dropped into the editor to replace.
 */

const ENTRY_BODY_HTML = "<p>Thomas Hale was born in 1898 and died in 1947.</p>";

async function main() {
  // Refuse before opening a connection, let alone deleting anything, unless
  // the resolved DATABASE_URL is a host this script was told it may destroy.
  // See db/seed-guard.ts.
  const guard = assertSeedTarget(process.env.DATABASE_URL, process.env);
  if (!guard.allowed) {
    console.error(guard.message);
    process.exit(1);
  }

  console.log("Clearing existing data...");
  await db.delete(schema.unionChildren);
  await db.delete(schema.unions);
  await db.delete(schema.individuals);
  await db.delete(schema.revisions);
  await db.delete(schema.pages);

  console.log("Writing an entry, for the person it is about to point at...");
  const title = `${seedPerson.thomas.givenName} ${seedPerson.thomas.surname}`;
  await db.insert(schema.pages).values({
    id: THOMAS_ENTRY_ID,
    slug: slugFromTitle(title),
    title,
    bodyHtml: ENTRY_BODY_HTML,
    updatedBy: SEED_AUTHOR,
  });
  await db.insert(schema.revisions).values({
    pageId: THOMAS_ENTRY_ID,
    title,
    bodyHtml: ENTRY_BODY_HTML,
    createdBy: SEED_AUTHOR,
  });

  console.log("Inserting individuals...");
  await db.insert(schema.individuals).values(seedFamily.people);

  console.log("Inserting unions...");
  await db.insert(schema.unions).values(seedFamily.unions);

  console.log("Linking children to unions...");
  await db.insert(schema.unionChildren).values(seedFamily.childLinks);

  console.log(
    `Done. ${seedFamily.people.length} people, ` +
      `${seedFamily.unions.length} unions, ` +
      `${seedFamily.childLinks.length} child links, 1 entry.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
