// i18n.mjs — a lightweight loader shared by server.mjs and bin/tmcon-cli.mjs.
//
// Text is externalized into locales/<lang>.json, sharing the same file and same
// format (flat keys + {name} interpolation) with the WebUI (fetch("/locales/…")).
//
// How the language is decided (common to server/CLI):
//   TMCON_LANG (explicit ja|en|zh-Hant… ) > LC_ALL > LC_MESSAGES > LANG.
//   Values like "ja_JP.UTF-8" or "zh_TW" are parsed as BCP 47 tags.
//
// Locale resolution follows BCP 47 / RFC 4647 "lookup": a requested tag is
// matched against the available locale files most-specific first, falling back
// to less-specific variants and finally to en. For example zh-TW resolves to
// zh-Hant.json if present, else zh.json, else en.json. The script subtag
// (Hans/Hant) is inferred from the region via Intl.Locale.maximize(), so a
// browser sending zh-TW correctly prefers a Traditional Chinese file.
//
// Locale files are keyed by BCP 47 tag: en.json, ja.json, zh.json,
// zh-Hant.json, pt-BR.json, … A variant file may be partial; missing keys are
// filled from its base language, then from en (see makeT's merge chain).
//
// Zero dependencies (Node 20+, which ships full ICU so Intl.Locale works). JSON
// import attributes require Node 20.10+, so instead read synchronously with
// readFileSync + JSON.parse (so t() can be used immediately).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "locales");

// Enumerate the *.json files in locales/. Adding one language file (named by its
// BCP 47 tag) is all it takes to support that language.
export function availableLocales() {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return ["en"];
  }
}

const load = (lc) => JSON.parse(readFileSync(join(DIR, `${lc}.json`), "utf8"));

// Candidate tags for a requested BCP 47 tag, most-specific first. The script
// subtag is inferred from the region (e.g. zh-TW → zh-Hant) via maximize().
//   zh-TW        → [zh-Hant-TW, zh-Hant, zh-TW, zh]
//   zh-Hant-HK   → [zh-Hant-HK, zh-Hant, zh-HK, zh]
//   pt-BR        → [pt-Latn-BR, pt-Latn, pt-BR, pt]
//   ja-JP        → [ja-Jpan-JP, ja-Jpan, ja-JP, ja]
export function candidateTags(tag) {
  let loc;
  try {
    loc = new Intl.Locale(tag);
  } catch {
    const base = String(tag || "")
      .split("-")[0]
      .toLowerCase();
    return base ? [base] : [];
  }
  let max = loc;
  try {
    max = loc.maximize();
  } catch {
    /* keep loc if maximize is unavailable */
  }
  const lang = loc.language;
  const script = loc.script || max.script;
  const region = loc.region;
  const out = [];
  const push = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };
  if (script && region) push(`${lang}-${script}-${region}`);
  if (loc.script && region) push(`${lang}-${loc.script}-${region}`);
  if (script) push(`${lang}-${script}`);
  if (region) push(`${lang}-${region}`);
  push(lang);
  return out;
}

// Resolve a requested BCP 47 tag to the name of an existing locale file (or en).
export function resolveLocale(tag) {
  const avail = new Map(availableLocales().map((n) => [n.toLowerCase(), n]));
  for (const cand of candidateTags(tag)) {
    const hit = avail.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return avail.has("en") ? "en" : (availableLocales()[0] ?? "en");
}

// Decide the locale from the environment. Returns the name of an existing file.
export function detectLocale(env = process.env) {
  const raw = (
    env.TMCON_LANG ||
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    ""
  ).trim();
  const up = raw.toUpperCase();
  if (!raw || up === "C" || up === "POSIX") return "en";
  // Drop the encoding (".UTF-8") and modifier ("@euro"); map "_" to "-".
  const tag = raw.split(/[.@]/)[0].replace(/_/g, "-");
  return resolveLocale(tag);
}

// The merge chain for a resolved locale name, least-specific first, always
// starting from en. "zh-Hant" → ["en", "zh", "zh-Hant"]; "ja" → ["en", "ja"].
function mergeChain(name) {
  const parts = String(name).split("-");
  const chain = ["en"];
  for (let i = 1; i <= parts.length; i++)
    chain.push(parts.slice(0, i).join("-"));
  return chain;
}

// Returns t(key, vars). Loads the merge chain (en base → base language →
// variant), so a partial variant file inherits missing keys from its base
// language and then en (unknown keys return the key name as-is). vars inserts
// {name} via replaceAll (the same rule as the WebUI's t()). `locale` is the most
// specific file that actually contributed.
export function makeT(locale = detectLocale()) {
  const avail = new Map(availableLocales().map((n) => [n.toLowerCase(), n]));
  let msg = {};
  let effective = "en";
  for (const name of mergeChain(locale)) {
    const actual = avail.get(name.toLowerCase());
    if (!actual) continue;
    try {
      msg = { ...msg, ...load(actual) };
      effective = actual;
    } catch {
      /* skip unreadable file */
    }
  }
  const t = (key, vars = {}) => {
    let v = msg[key] ?? key;
    for (const [k, r] of Object.entries(vars))
      v = v.replaceAll(`{${k}}`, String(r));
    return v;
  };
  return { t, locale: effective };
}
