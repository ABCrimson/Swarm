import { describe, expect, it } from "vitest";
import { tokenizeJson } from "#lib/syntax-highlight";

const typesAndValues = (input: string): [string, string][] =>
  tokenizeJson(input).map((t) => [t.type, t.value]);

describe("tokenizeJson", () => {
  it("classifies keys, strings, numbers, booleans, null and structure", () => {
    expect(typesAndValues('{"a": "x", "b": -1.5e3, "c": [true, false, null]}')).toStrictEqual([
      ["brace", "{"],
      ["key", '"a"'],
      ["colon", ":"],
      ["whitespace", " "],
      ["string", '"x"'],
      ["comma", ","],
      ["whitespace", " "],
      ["key", '"b"'],
      ["colon", ":"],
      ["whitespace", " "],
      ["number", "-1.5e3"],
      ["comma", ","],
      ["whitespace", " "],
      ["key", '"c"'],
      ["colon", ":"],
      ["whitespace", " "],
      ["brace", "["],
      ["boolean", "true"],
      ["comma", ","],
      ["whitespace", " "],
      ["boolean", "false"],
      ["comma", ","],
      ["whitespace", " "],
      ["null", "null"],
      ["brace", "]"],
      ["brace", "}"],
    ]);
  });

  it("keeps escaped quotes inside a string", () => {
    expect(typesAndValues(String.raw`["a\"b"]`)).toStrictEqual([
      ["brace", "["],
      ["string", String.raw`"a\"b"`],
      ["brace", "]"],
    ]);
  });

  it("highlights JSONC line and block comments as comments", () => {
    const input = '{\n  // compiler options\n  "strict": true /* for now */\n}';
    expect(
      tokenizeJson(input)
        .filter((t) => t.type === "comment")
        .map((t) => t.value),
    ).toStrictEqual(["// compiler options", "/* for now */"]);
  });

  it("does not color literals or digits inside a comment", () => {
    expect(typesAndValues("// true 42 null")).toStrictEqual([["comment", "// true 42 null"]]);
  });

  it("shows text that is not JSON as plain instead of dropping it", () => {
    expect(typesAndValues("[NaN, trueish] #")).toStrictEqual([
      ["brace", "["],
      ["plain", "NaN"],
      ["comma", ","],
      ["whitespace", " "],
      ["plain", "trueish"],
      ["brace", "]"],
      ["whitespace", " "],
      ["plain", "#"],
    ]);
  });

  it.each([
    ['{"a":1}'],
    ['{\n  "compact":1,"spaced" :  2\n}\n'],
    ['{\n  // comment\n  "a": [1, 2], /* block\n spanning lines */ "b": "c"\n}'],
    ['{"unterminated": "abc\n}'],
    ["/* unterminated block"],
    ["garbage ~ @ / \\ 'single' -"],
    [JSON.stringify({ nested: { list: [1, "two", null, { deep: true }] } }, null, 2)],
  ])("is lossless: the tokens join back into the input (%#)", (input) => {
    expect(
      tokenizeJson(input)
        .map((t) => t.value)
        .join(""),
    ).toBe(input);
  });

  it("gives every token its type's OKLCH color", () => {
    for (const token of tokenizeJson('{"a": [1, true, null, "s"]} // c ?')) {
      expect(token.color).toMatch(token.type === "whitespace" ? /^transparent$/ : /^oklch\(/);
    }
  });
});
