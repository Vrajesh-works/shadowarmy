import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findRunExpressions } from "../scripts/check-workflow-expressions.ts";

describe("findRunExpressions", () => {
  it("flags expressions inside run: scripts with their line", () => {
    const workflow = [
      "on: issues",
      "jobs:",
      "  work:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo safe",
      "      - name: unsafe",
      "        run: |",
      "          echo hello",
      '          echo "${{ github.event.issue.title }}"',
    ].join("\n");
    assert.deepEqual(findRunExpressions(workflow, "w.yml"), [
      {
        file: "w.yml",
        line: 8,
        message: "jobs.work.steps[1].run contains a ${{ }} expression; pass the value through env: instead",
      },
    ]);
  });

  it("flags every expression, not only github.event", () => {
    const workflow = "jobs:\n  a:\n    steps:\n      - run: git checkout ${{ inputs.branch }}\n";
    assert.equal(findRunExpressions(workflow, "w.yml").length, 1);
  });

  it("allows expressions outside run: and values passed through env:", () => {
    const workflow = [
      "concurrency: shadowarmy-${{ github.event.issue.number }}",
      "jobs:",
      "  a:",
      "    if: ${{ github.event.label.name == 'arise' }}",
      "    steps:",
      "      - uses: actions/checkout@0000000000000000000000000000000000000000",
      "        with:",
      "          ref: ${{ inputs.ref }}",
      "      - env:",
      "          TITLE: ${{ github.event.issue.title }}",
      '        run: echo "$TITLE"',
    ].join("\n");
    assert.deepEqual(findRunExpressions(workflow, "w.yml"), []);
  });

  it("checks composite actions", () => {
    const action = "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ${{ inputs.x }}\n";
    assert.equal(findRunExpressions(action, "action.yml")[0]?.message.startsWith("runs.steps[0].run"), true);
  });

  it("reports invalid YAML instead of passing it", () => {
    assert.match(findRunExpressions("jobs: [\n", "w.yml")[0]?.message ?? "", /invalid YAML/);
  });
});
