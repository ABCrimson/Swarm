// Progressive behaviour for the docs pages. Every page reads fully without
// it; it only adds what needs script.

// Copy buttons exist only where the Clipboard API does, so a reader without
// script or clipboard access never meets a button that cannot work.
const status = document.getElementById("copy-status");
if (navigator.clipboard?.writeText && status) {
  for (const block of document.querySelectorAll(".code")) {
    const code = block.querySelector("pre code");
    if (!code) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    // One reset timer per button, so a second click restarts the 2 s label
    // instead of an earlier timer cutting it short.
    let reset;
    button.addEventListener("click", async () => {
      clearTimeout(reset);
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        button.textContent = "Copied";
        announce("Copied");
      } catch {
        button.textContent = "Copy Failed";
        announce("Copy Failed");
      }
      reset = setTimeout(() => {
        button.textContent = "Copy";
      }, 2000);
    });
    block.append(button);
  }
}

// The live region is emptied first so the same message is announced again
// on a second copy.
function announce(message) {
  status.textContent = "";
  requestAnimationFrame(() => {
    status.textContent = message;
  });
}

// The contents list marks the section being read: the last heading whose top
// is in the upper quarter of the viewport or above it. It is computed from
// positions on every scroll (at most once a frame), not from headings
// crossing a line, so it is right after Home, End, Page Up or a jump.
const links = new Map(
  Array.from(document.querySelectorAll('.toc a[href^="#"]'), (a) => [
    decodeURIComponent(a.hash.slice(1)),
    a,
  ]),
);
const headings = Array.from(links.keys(), (id) => document.getElementById(id)).filter(
  (heading) => heading !== null,
);
if (headings.length > 0) {
  let current;
  let queued = false;
  const mark = () => {
    queued = false;
    const heading = headings.findLast((h) => h.getBoundingClientRect().top <= innerHeight / 4);
    const link = heading ? links.get(heading.id) : undefined;
    if (link === current) return;
    current?.removeAttribute("aria-current");
    link?.setAttribute("aria-current", "true");
    current = link;
  };
  addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(mark);
    },
    { passive: true },
  );
  mark();
}
