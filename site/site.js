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
// is at or above the root's scroll-padding line, where an anchor jump puts its
// target. It is computed from positions on every scroll or hash change (at
// most once a frame), not from headings crossing a line, so it is right after
// Home, End, Page Up or a jump.
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
  const root = document.documentElement;
  const mark = () => {
    queued = false;
    // An anchor jump puts its heading at the root's scroll padding, just
    // under the sticky header; the pixel absorbs rounding.
    const line = Number.parseFloat(getComputedStyle(root).scrollPaddingTop) + 1;
    // At the end of the page a jump cannot lift its heading to that line, so
    // a jump target still on screen there wins.
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const top = target?.getBoundingClientRect().top ?? -1;
    const atEnd = scrollY + innerHeight >= root.scrollHeight - 1;
    const heading =
      atEnd && headings.includes(target) && top >= 0 && top < innerHeight
        ? target
        : headings.findLast((h) => h.getBoundingClientRect().top <= line);
    const link = heading ? links.get(heading.id) : undefined;
    if (link === current) return;
    current?.removeAttribute("aria-current");
    link?.setAttribute("aria-current", "true");
    current = link;
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  // A jump to a heading already on screen at the end of the page scrolls
  // nothing, so the hash change itself also re-marks.
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("hashchange", schedule);
  mark();
}
