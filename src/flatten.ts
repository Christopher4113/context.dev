export type Leaf = { path: string; value: string | number | boolean };

// Sibling keys that name an array item, so "plans[2].price" can read as "Business plan price".
const ID_KEYS = ["name", "title", "label", "plan", "id", "full_name"];

/** Turn json_content into leaf fields. Nulls and empty strings are skipped: nothing to verify. */
export function flatten(value: unknown, path = ""): Leaf[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => flatten(v, `${path}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, path ? `${path}.${k}` : k),
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ path, value }];
  }
  return [];
}

/** Readable label for a path, using an array item's name when it has one: "plans › Business › price per user monthly". */
export function label(root: unknown, path: string): string {
  const parts: string[] = [];
  let node: any = root;
  for (const seg of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (seg.startsWith("[")) {
      node = node?.[Number(seg.slice(1, -1))];
      const id = node && typeof node === "object" ? ID_KEYS.map((k) => node[k]).find((v) => typeof v === "string" && v) : undefined;
      parts.push(id ?? `#${Number(seg.slice(1, -1)) + 1}`);
    } else {
      node = node?.[seg];
      parts.push(seg.replace(/_/g, " "));
    }
  }
  return parts.join(" › ");
}

/** Deterministic fallback claim, used when the LLM phraser is unavailable. */
export function templateClaim(root: unknown, leaf: Leaf): string {
  return `${label(root, leaf.path)}: ${leaf.value}`;
}
