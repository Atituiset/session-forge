import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

describe("runtime smoke", () => {
  test("bun:sqlite read/write", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.query("INSERT INTO t (name) VALUES (?)").run("hello");
    const row = db.query("SELECT id, name FROM t").get();
    expect(row).toEqual({ id: 1, name: "hello" });
  });
});
