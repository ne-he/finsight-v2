/**
 * Readable company names.
 *
 * EDGAR returns registrant names in the form they were filed, which is often
 * upper case with a legal suffix: "NVIDIA CORP", "MICROSOFT CORP". That reads
 * as shouting in a sentence like "What are MICROSOFT CORP's risk factors?".
 */

const SUFFIXES = new Set([
  "corp",
  "corp.",
  "corporation",
  "inc",
  "inc.",
  "co",
  "co.",
  "company",
  "ltd",
  "ltd.",
  "limited",
  "plc",
  "holdings",
  "group",
  "sa",
  "nv",
  "ag",
]);

/** Brands whose official spelling is all capitals and longer than an acronym. */
const ALL_CAPS_BRANDS = new Set(["NVIDIA", "ASML", "SAP", "IBM", "AMD", "HP"]);

export function displayName(company: string): string {
  const words = company.trim().split(/\s+/);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/,$/, ""))) {
    words.pop();
  }
  const last = words.length - 1;
  words[last] = words[last].replace(/,$/, "");

  return words
    .map((word) => {
      const isUpper = word === word.toUpperCase() && /[A-Z]/.test(word);
      if (!isUpper || word.length <= 3 || ALL_CAPS_BRANDS.has(word)) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/** "NVIDIA, Apple or Microsoft" */
export function joinNames(names: string[], conjunction = "or"): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}
