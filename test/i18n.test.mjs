// test/i18n.test.mjs — locale resolution and the BCP 47 merge chain (i18n.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidateTags, resolveLocale, detectLocale, makeT } from "../i18n.mjs";

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");

test("candidateTags infers script from region, most-specific first", () => {
  const zhTW = candidateTags("zh-TW");
  assert.ok(zhTW.includes("zh-Hant"), `expected zh-Hant in ${zhTW}`);
  assert.ok(zhTW.includes("zh-TW"));
  assert.equal(zhTW.at(-1), "zh"); // least specific comes last
  assert.equal(zhTW[0], "zh-Hant-TW"); // most specific comes first

  const ptBR = candidateTags("pt-BR");
  assert.ok(ptBR.includes("pt-BR"));
  assert.equal(ptBR.at(-1), "pt");

  assert.deepEqual(candidateTags("fr"), ["fr-Latn", "fr"]);
});

test("candidateTags is defensive against garbage input", () => {
  assert.deepEqual(candidateTags(""), []);
  assert.doesNotThrow(() => candidateTags("!!bad!!"));
  assert.equal(resolveLocale("!!bad!!"), "en"); // garbage resolves to en
});

test("resolveLocale maps variants to the best existing file, else en", () => {
  // Simplified variants resolve to the base zh.json; Traditional variants
  // resolve to the shipped zh-Hant.json (region infers the script).
  assert.equal(resolveLocale("zh-CN"), "zh");
  assert.equal(resolveLocale("zh-Hans"), "zh");
  assert.equal(resolveLocale("zh-TW"), "zh-Hant");
  assert.equal(resolveLocale("zh-Hant-HK"), "zh-Hant");
  // Variants without their own file fall back to the base language.
  assert.equal(resolveLocale("pt-BR"), "pt");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("de-CH"), "de");
  assert.equal(resolveLocale("xx-YY"), "en"); // unknown → en
});

test("detectLocale parses POSIX-style env values and handles C/POSIX", () => {
  assert.equal(detectLocale({ TMCON_LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(detectLocale({ TMCON_LANG: "zh_TW.UTF-8" }), "zh-Hant");
  assert.equal(detectLocale({ LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(detectLocale({ TMCON_LANG: "fr" }), "fr");
  assert.equal(detectLocale({ LANG: "C.UTF-8" }), "en");
  assert.equal(detectLocale({ LANG: "POSIX" }), "en");
  assert.equal(detectLocale({}), "en");
  // TMCON_LANG takes priority over LANG.
  assert.equal(detectLocale({ TMCON_LANG: "de", LANG: "ja_JP.UTF-8" }), "de");
});

test("makeT falls back through the chain to the most specific existing file", () => {
  assert.equal(makeT("en").locale, "en");
  assert.equal(makeT("ja").t("action.send"), "送信");
  // zh-Hant ships, so it resolves to itself with Traditional text.
  assert.equal(makeT("zh-Hant").locale, "zh-Hant");
  // No zh-Hant-HK file ships, so it falls back to the zh-Hant file.
  assert.equal(makeT("zh-Hant-HK").locale, "zh-Hant");
  // No pt-BR file ships, so it falls back to the base pt file.
  assert.equal(makeT("pt-BR").locale, "pt");
});

test("makeT merges a partial variant file over its base language then en", () => {
  // Use a variant with no shipped file (base language "de" does ship).
  const variant = join(LOCALES, "de-CH.json");
  if (existsSync(variant)) return; // don't clobber a real file if one is added
  const de = JSON.parse(readFileSync(join(LOCALES, "de.json"), "utf8"));
  try {
    // Partial file: overrides one key only.
    writeFileSync(
      variant,
      JSON.stringify({ "action.send": "Absenden" }),
      "utf8",
    );

    assert.equal(resolveLocale("de-CH"), "de-CH"); // now the variant wins
    const { t, locale } = makeT("de-CH");
    assert.equal(locale, "de-CH");
    assert.equal(t("action.send"), "Absenden"); // from the variant
    assert.equal(t("action.new"), de["action.new"]); // inherited from de
    assert.ok(t("action.stop")); // inherited (de or en), never blank
  } finally {
    rmSync(variant, { force: true });
  }
});
