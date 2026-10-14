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
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        button.textContent = "Copied";
        announce("Copied");
      } catch {
        button.textContent = "Copy Failed";
        announce("Copy Failed");
      }
      setTimeout(() => {
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

// The contents list marks the section being read. Headings are observed in a
// band near the top of the viewport, the place a reader's eye returns to.
const links = new Map(
  Array.from(document.querySelectorAll('.toc a[href^="#"]'), (a) => [
    decodeURIComponent(a.hash.slice(1)),
    a,
  ]),
);
if (links.size > 0) {
  let current;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        current?.removeAttribute("aria-current");
        current = links.get(entry.target.id);
        current?.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "0px 0px -75% 0px" },
  );
  for (const id of links.keys()) {
    const heading = document.getElementById(id);
    if (heading) observer.observe(heading);
  }
}
