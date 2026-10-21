import { describe, expect, it } from "vitest";
import { toYaml } from "@/lib/yaml";
import { BROKEN_APP, DOCS_SITE, SALES_DASHBOARD } from "../../e2e/data";

describe("toYaml", () => {
  it("writes an App's spec as block-style YAML", () => {
    const { source, runtime, access } = DOCS_SITE;
    expect(toYaml({ kind: "App", spec: { source, runtime, access } })).toBe(
      [
        "kind: App",
        "spec:",
        "  source:",
        "    type: git",
        "    git:",
        "      url: https://github.com/example/docs",
        "      ref: main",
        "  runtime:",
        "    replicas: 1",
        "    env:",
        "      - name: LOG_LEVEL",
        "        value: info",
        "    secretKeys:",
        "      - API_KEY",
        "  access:",
        "    public: false",
        "    groups:",
        "      - analytics",
        "    users:",
        "      - grace",
        "    managers:",
        "      users:",
        "        - dave",
        "      groups:",
        "        - docs-team",
        "    subdomain: docs-site",
        "",
      ].join("\n"),
    );
  });

  it("quotes strings that would read as another type or break the syntax", () => {
    expect(toYaml(BROKEN_APP.status)).toBe(
      [
        "phase: Failed",
        'url: ""',
        "message: CrashLoopBackOff",
        "replicas:",
        "  desired: 1",
        "  ready: 0",
        "conditions:",
        "  - type: Validated",
        '    status: "True"',
        "    reason: Valid",
        '    message: ""',
        '    lastTransitionTime: "2026-10-19T12:00:00Z"',
        "  - type: WorkloadReady",
        '    status: "False"',
        "    reason: CrashLoopBackOff",
        "    message: Back-off restarting container",
        '    lastTransitionTime: "2026-10-19T12:00:00Z"',
        "",
      ].join("\n"),
    );
    expect(toYaml(SALES_DASHBOARD.status.message)).toBe("Scaled to zero\n");
    const tricky = {
      yes: "no",
      version: "1.0",
      negative: "-1",
      pair: "a: b",
      comment: "x #y",
      colon: "ends:",
      dash: "- item",
      star: "*ref",
      padded: " pad",
      tab: "a\tb",
      bell: "\u0007",
      apostrophe: "it's",
      "key with: colon": 1,
    };
    expect(toYaml(tricky)).toBe(
      [
        '"yes": "no"',
        'version: "1.0"',
        'negative: "-1"',
        'pair: "a: b"',
        'comment: "x #y"',
        'colon: "ends:"',
        'dash: "- item"',
        'star: "*ref"',
        'padded: " pad"',
        'tab: "a\\tb"',
        'bell: "\\u0007"',
        "apostrophe: it's",
        '"key with: colon": 1',
        "",
      ].join("\n"),
    );
  });

  it("writes numbers, booleans, null and empty collections as flow scalars", () => {
    expect(
      toYaml({
        n: 3,
        f: 0.5,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        ninf: Number.NEGATIVE_INFINITY,
        t: true,
        none: null,
        list: [],
        map: {},
        skipped: undefined,
      }),
    ).toBe(
      [
        '"n": 3',
        "f: 0.5",
        "nan: .nan",
        "inf: .inf",
        "ninf: -.inf",
        "t: true",
        "none: null",
        "list: []",
        "map: {}",
        "",
      ].join("\n"),
    );
    expect(toYaml(null)).toBe("null\n");
    expect(toYaml([undefined, 1])).toBe("- null\n- 1\n");
  });

  it("nests arrays of arrays and maps under list items", () => {
    expect(toYaml([[1, 2], [], [{ a: 1, b: [true] }]])).toBe(
      ["- - 1", "  - 2", "- []", "- - a: 1", "    b:", "      - true", ""].join("\n"),
    );
  });

  it("writes multi-line strings as literal blocks, keeping their trailing newlines", () => {
    const files = {
      "index.html": "<h1>Hi</h1>\n\n<p>there</p>\n",
      clipped: "a\nb",
      kept: "a\n\n",
      indented: "  a\nb",
    };
    expect(toYaml({ files })).toBe(
      [
        "files:",
        "  index.html: |",
        "    <h1>Hi</h1>",
        "",
        "    <p>there</p>",
        "  clipped: |-",
        "    a",
        "    b",
        "  kept: |+",
        "    a",
        "",
        '  indented: "  a\\nb"',
        "",
      ].join("\n"),
    );
    expect(toYaml(["x\ny\n"])).toBe("- |\n  x\n  y\n");
  });
});
