const SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // sans l, o, 0, 1 (ambigus)

function randomSuffix(length = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join("");
}

// "Afro Night — Cotonou 2026 !" -> "afro-night-cotonou-2026-x7k2"
export function generateSlug(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${base || "evenement"}-${randomSuffix()}`;
}
