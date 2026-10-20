/*
 * A small YAML serializer for showing JSON-shaped data (the App manifest) the
 * way Kubernetes users expect to read and `kubectl apply` it. It emits block
 * style only, quotes any string a YAML 1.1 or 1.2 parser could read as
 * something other than that string, and writes multi-line strings as literal
 * blocks so inline source files stay readable.
 */

const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
// Characters that start a YAML indicator, so a plain scalar cannot begin with them.
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
// Control characters other than tab and newline: never plain, never in a literal block.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

type Collection = unknown[] | Record<string, unknown>;

function isCollection(value: unknown): value is Collection {
  return typeof value === "object" && value !== null;
}

function isEmpty(value: Collection): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

function needsQuotes(s: string): boolean {
  return (
    s === "" ||
    s !== s.trim() ||
    RESERVED.test(s) ||
    INDICATOR.test(s) ||
    // Numbers, versions, dates and times all start this way.
    /^[-+.]?\d/.test(s) ||
    /: |:$| #|[\t\n]/.test(s) ||
    CONTROL.test(s)
  );
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (!Number.isFinite(value)) return value > 0 ? ".inf" : "-.inf";
    return String(value);
  }
  if (Array.isArray(value)) return "[]";
  if (isCollection(value)) return "{}";
  const s = String(value);
  // A JSON string is a valid YAML double-quoted scalar.
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

/**
 * `prefix` followed by `value`: a scalar on the same line, or, for a
 * multi-line string, a literal block indented to `depth`. Strings a literal
 * block cannot hold unchanged (a leading space would need an indentation
 * indicator; control characters) are quoted instead.
 */
function scalarLines(prefix: string, value: unknown, depth: number): string[] {
  if (
    typeof value !== "string" ||
    !value.includes("\n") ||
    /^\s/.test(value) ||
    CONTROL.test(value)
  ) {
    return [prefix + scalar(value)];
  }
  const trailing = value.length - value.replace(/\n+$/, "").length;
  const chomp = trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+";
  const body = trailing === 0 ? value : value.slice(0, -1);
  const pad = "  ".repeat(depth);
  return [prefix + chomp, ...body.split("\n").map((line) => (line ? pad + line : ""))];
}

function lines(value: unknown, depth: number): string[] {
  const pad = "  ".repeat(depth);
  if (!isCollection(value) || isEmpty(value)) return scalarLines(pad, value, depth);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isCollection(item) && !isEmpty(item)) {
        const [first = "", ...rest] = lines(item, depth + 1);
        return [`${pad}- ${first.trimStart()}`, ...rest];
      }
      return scalarLines(`${pad}- `, item, depth + 1);
    });
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined) return [];
    const head = `${pad}${scalar(key)}:`;
    if (isCollection(item) && !isEmpty(item)) return [head, ...lines(item, depth + 1)];
    return scalarLines(`${head} `, item, depth + 1);
  });
}

/** Serialize JSON-shaped data as a block-style YAML document ending in a newline. */
export function toYaml(value: unknown): string {
  return `${lines(value, 0).join("\n")}\n`;
}
