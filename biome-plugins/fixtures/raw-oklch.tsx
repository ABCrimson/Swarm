// The TSX fixture for `pnpm check:raw-oklch`: the gate must report exactly
// the four literals marked RAW and accept the token forms.

/** RAW: a known exception of AIChat.tsx, used in a file that does not list it. */
export const borrowed = "bg-[oklch(0.10_0.02_220/0.9)]";

export const Raw = () => (
  // RAW: the Tailwind arbitrary value; RAW: the inline style value.
  <div className="bg-[oklch(0.5_0.1_10)]" style={{ color: "oklch(0.6 0.1 20 / 0.5)" }}>
    {/* RAW: a template-literal chunk. */}
    {`text-[oklch(0.7_0.1_30)]`}
  </div>
);

export const Tokens = () => (
  <div
    className="bg-plasma/15 text-fg"
    style={{ color: "oklch(from var(--color-plasma) l c h / 0.15)" }}
  />
);
