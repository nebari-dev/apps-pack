import { readFileSync } from 'node:fs';
import { visit } from 'unist-util-visit';

/** The nebari-operator release the pack is built against: one file at the repo root. */
export const NEBARI_OPERATOR_VERSION = readFileSync(
  new URL('../../.nebari-operator-version', import.meta.url),
  'utf8',
).trim();

const PINS = { NEBARI_OPERATOR_VERSION };
const TOKEN = /%(\w+)%/g;
const replace = (s) => s.replace(TOKEN, (m, name) => PINS[name] ?? m);

/**
 * Replace `%NAME%` placeholders in page text and link URLs with the repo's
 * pinned versions, so a pin bump needs no docs edit. Unknown names are left
 * as written (and fail the docs test that looks for leftovers).
 */
export function rehypePins() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type === 'text' && node.value.includes('%')) node.value = replace(node.value);
      if (node.type === 'element' && typeof node.properties?.href === 'string') {
        node.properties.href = replace(node.properties.href);
      }
    });
  };
}
