// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeForDisplay } from "#lib/display-escape";

describe("escapeForDisplay", () => {
  it("leaves ordinary text, including non-ASCII letters, alone", () => {
    expect(escapeForDisplay("src/lib/naïve file.ts")).toBe("src/lib/naïve file.ts");
  });

  it("doubles backslashes so a Windows path stays unambiguous", () => {
    expect(escapeForDisplay("C:\\proj\\notes.txt")).toBe("C:\\\\proj\\\\notes.txt");
  });

  it("spells newline, carriage return and tab", () => {
    expect(escapeForDisplay("a\nb\rc\td")).toBe("a\\nb\\rc\\td");
  });

  it("never lets a real newline look like a backslash followed by n", () => {
    expect(escapeForDisplay("\n")).toBe("\\n");
    expect(escapeForDisplay("\\n")).toBe("\\\\n");
  });

  it("shows other controls and zero-width characters as backslash-u escapes", () => {
    expect(escapeForDisplay("a\u0000b\u001bc\u007f")).toBe("a\\u0000b\\u001Bc\\u007F");
    expect(escapeForDisplay("x\u200By\u2060z\uFEFF")).toBe("x\\u200By\\u2060z\\uFEFF");
  });

  it("defuses a Trojan Source right-to-left override in a path", () => {
    expect(escapeForDisplay("/proj/a\u202Eb.js")).toBe("/proj/a\\u202Eb.js");
  });

  it("braces the escape above U+FFFF", () => {
    expect(escapeForDisplay("\u{E0041}")).toBe("\\u{E0041}");
  });

  it("escapes once: an emitted escape is not escaped again", () => {
    expect(escapeForDisplay("\\\n")).toBe("\\\\\\n");
  });
});

// Every non-test source module, as text (Vite's raw import).
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("escapeForDisplay's home", () => {
  // knip's `exports` rule only warns, so nothing else stops a second copy.
  it("is defined only in #lib/display-escape and imported only from there", () => {
    const entries = Object.entries(sources);
    const definers = entries
      .filter(([, text]) =>
        /\bfunction\s*\*?\s*escapeForDisplay\b|\b(?:const|let|var)\s+escapeForDisplay\b|\bexport\s*\{[^}]*\bescapeForDisplay\b[^}]*\}/.test(
          text,
        ),
      )
      .map(([path]) => path);
    const strays = entries
      .filter(([, text]) =>
        /import\s*\{[^}]*\bescapeForDisplay\b[^}]*\}\s*from\s*["'](?!#lib\/display-escape["'])/.test(
          text,
        ),
      )
      .map(([path]) => path);

    expect(entries.length).toBeGreaterThan(50);
    expect(definers).toStrictEqual(["/src/lib/display-escape.ts"]);
    expect(strays).toStrictEqual([]);
  });
});
