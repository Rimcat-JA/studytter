import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "../test/sqlite";
import { countVisibleUnread, selectFeedCandidates } from "./feed-candidates";

describe("feed candidates", () => {
  let fixture: ReturnType<typeof openTestDatabase>;
  beforeEach(() => {
    fixture = openTestDatabase();
    for (const [subject, enabled] of [["visible", 1], ["hidden", 0]] as const) {
      fixture.sqlite.prepare("INSERT INTO subjects VALUES(?,?,?,'seed','ja','mixed','{}',?,0)").run(subject, subject, subject, enabled);
      fixture.sqlite.prepare("INSERT INTO atoms VALUES(?,?,?,'topic','fact',0,'core',NULL,'p1',1,0)").run(subject, subject, `m-${subject}`);
    }
  });
  afterEach(() => fixture.close());
  const addPost = (id: string, subject = "visible", created = 0, status = "unread") => {
    fixture.sqlite.prepare("INSERT INTO posts VALUES(?,?,?,?,'quiz','persona','question',NULL,0,?,0,?)")
      .run(id, subject, subject, `${subject}:topic`, status, created);
  };
  it("ignores hidden subjects and disabled atoms when counting unread", async () => {
    addPost("v");
    for (let n = 0; n < 400; n++) addPost(`h${n}`, "hidden");
    expect(await countVisibleUnread(fixture.db)).toBe(1);
    expect(await countVisibleUnread(fixture.db, "hidden")).toBe(0);
    fixture.sqlite.exec("UPDATE atoms SET enabled=0 WHERE atom_id='visible'");
    expect(await countVisibleUnread(fixture.db)).toBe(0);
  });
  it("keeps old due reviews eligible beyond 250 newer posts and joins ranking state", async () => {
    addPost("old-review", "visible", 1, "consumed");
    fixture.sqlite.exec("INSERT INTO atom_memory VALUES('visible',1,1,1,0)");
    fixture.sqlite.exec("INSERT INTO bandit_arms VALUES('visible:topic','quiz',3,2)");
    for (let n = 0; n < 300; n++) addPost(`new${n}`, "visible", n + 2);
    // Same-atom posts are tied on urgency; reserve the old review deterministically.
    fixture.sqlite.exec("UPDATE posts SET atom_id='new-atom' WHERE id!='old-review'; INSERT INTO atoms VALUES('new-atom','visible','m','new','fact',0,'core',NULL,'p2',1,0)");
    const rows = await selectFeedCandidates(fixture.db, undefined, {}, 10 * 86_400_000);
    expect(rows.find((row) => row.id === "old-review")).toMatchObject({ alpha: 3, beta: 2, stability_days: 1 });
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
  it("restores save/unsave state deterministically even at the same timestamp", async () => {
    addPost("v");
    fixture.sqlite.exec("INSERT INTO interactions VALUES('save','v','save',NULL,1)");
    expect(await selectFeedCandidates(fixture.db, undefined, { savedOnly: true })).toHaveLength(1);
    fixture.sqlite.exec("INSERT INTO interactions VALUES('unsave','v','unsave',NULL,1)");
    expect(await selectFeedCandidates(fixture.db, undefined, { savedOnly: true })).toHaveLength(0);
  });
});
