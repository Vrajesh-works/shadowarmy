import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDiff, parseRawDiff, protectedReason, type ChangedFile } from "../src/diffGuard.ts";

const mb = 1024 * 1024;

function guard(files: ChangedFile[], orderText = "Add a feature.", maxFileSizeMb = 5) {
  return checkDiff({ files, orderText, maxFileSizeMb });
}

describe("diff guard", () => {
  it("accepts ordinary changes", () => {
    const result = guard([
      { status: "M", path: "src/index.ts", size: 100 },
      { status: "A", path: "docs/guide.md", size: 2000 },
      { status: "D", path: "old.txt" },
    ]);
    assert.deepEqual(result, { ok: true, violations: [], exceptions: [] });
  });

  it("rejects every protected path that the order does not name", () => {
    const paths = [
      ".shadowarmy/state.json",
      ".github/workflows/ci.yml",
      "CLAUDE.md",
      "packages/web/CLAUDE.md",
      "CLAUDE.local.md",
      "AGENTS.md",
      "lib/AGENTS.md",
      ".claude/settings.json",
      "app/.claude/commands/x.md",
    ];
    for (const path of paths) {
      for (const status of ["A", "M", "D"] as const) {
        const result = guard([{ status, path, size: 10 }]);
        assert.equal(result.ok, false, `${status} ${path}`);
        assert.match(result.violations[0]?.reason ?? "", /the order does not ask for it/);
      }
    }
  });

  it("checks both sides of a rename", () => {
    assert.equal(guard([{ status: "R", oldPath: "CLAUDE.md", path: "docs/notes.md", size: 1 }]).ok, false);
    assert.equal(guard([{ status: "R", oldPath: "notes.md", path: "AGENTS.md", size: 1 }]).ok, false);
  });

  it("allows a protected path the order names exactly, and records the exception", () => {
    const result = guard([{ status: "M", path: "CLAUDE.md", size: 10 }], "Add a testing section to CLAUDE.md.");
    assert.deepEqual(result, { ok: true, violations: [], exceptions: ["CLAUDE.md"] });
    const ci = guard([{ status: "A", path: ".github/workflows/test.yml", size: 10 }], "Add a CI workflow under .github/workflows that runs npm test.");
    assert.deepEqual(ci.exceptions, [".github/workflows/test.yml"]);
  });

  it("does not treat a longer path in the order as naming a shorter one", () => {
    assert.equal(guard([{ status: "M", path: "CLAUDE.md", size: 1 }], "Update docs/CLAUDE.md").ok, false);
    assert.equal(guard([{ status: "M", path: "AGENTS.md", size: 1 }], "Rename AGENTS.md.bak").ok, false);
    assert.equal(guard([{ status: "M", path: "AGENTS.md", size: 1 }], "Edit `AGENTS.md`, please").ok, true);
  });

  it("rejects markers, oversized files and submodules even when named", () => {
    const named = "Edit big.bin, notes.md and vendor/lib";
    const result = guard(
      [
        { status: "A", path: "notes.md", size: 10, hasMarker: true },
        { status: "A", path: "big.bin", size: 6 * mb },
        { status: "A", path: "vendor/lib", mode: "160000" },
        { status: "A", path: "ok.bin", size: 5 * mb },
      ],
      named,
    );
    assert.deepEqual(
      result.violations.map((v) => `${v.path}: ${v.reason}`),
      [
        "notes.md: contains a shadowarmy status or state marker",
        "big.bin: is 6.0 MB, over the 5 MB limit",
        "vendor/lib: submodule changes are not allowed",
      ],
    );
  });

  it("knows which paths are protected", () => {
    assert.equal(protectedReason("src/claude.md"), null);
    assert.equal(protectedReason(".github/dependabot.yml"), null);
    assert.equal(protectedReason("docs/.shadowarmy/x"), null);
    assert.notEqual(protectedReason(".github/workflows/x.yml"), null);
  });
});

describe("parseRawDiff", () => {
  it("parses adds, modifies, deletes, renames and odd file names", () => {
    const z = "0".repeat(40);
    const n = "a".repeat(40);
    const raw = [
      `:000000 100644 ${z} ${n} A`, "new file.txt",
      `:100644 100644 ${z} ${n} M`, "src/a.ts",
      `:100644 000000 ${n} ${z} D`, "gone\nwith newline",
      `:100644 100644 ${z} ${n} R087`, "old.md", "new.md",
      `:000000 160000 ${z} ${n} A`, "sub",
      "",
    ].join("\0");
    assert.deepEqual(parseRawDiff(raw), [
      { status: "A", path: "new file.txt", mode: "100644", blob: n },
      { status: "M", path: "src/a.ts", mode: "100644", blob: n },
      { status: "D", path: "gone\nwith newline", mode: "000000", blob: z },
      { status: "R", oldPath: "old.md", path: "new.md", mode: "100644", blob: n },
      { status: "A", path: "sub", mode: "160000", blob: n },
    ]);
  });

  it("rejects unexpected records", () => {
    assert.throws(() => parseRawDiff("garbage\0x\0"), /unexpected git diff --raw record/);
  });
});
