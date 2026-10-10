/**
 * Web Worker entry point for ELK graph layout computation.
 *
 * This worker *is* elkjs's own worker script: importing
 * `elkjs/lib/elk-worker.js` for its side effect registers `self.onmessage`
 * to receive elkjs's internal `register`/`layout`/`algorithms`/`options`/
 * `categories` protocol and run the layered layout algorithm synchronously
 * in this thread, posting results straight back via `self.postMessage`.
 *
 * elkjs's own `ELK` class (constructed on the main thread in
 * `src/hooks/useElkLayout.ts`) drives this worker through its documented
 * `workerFactory` option, using this file as the single, non-nested Worker.
 *
 * We deliberately do NOT construct an `ELK` instance in here. Doing so
 * requires supplying `workerUrl`/`workerFactory` (the constructor throws
 * synchronously otherwise — see `elkjs/lib/elk-api.js`), and elkjs's
 * default worker mechanism would spawn *another*, nested Worker to run the
 * algorithm. Any throw there happens during this module's evaluation,
 * before `self.onmessage` is assigned, so layout requests would go
 * unanswered and the caller's "Computing Layout" state would never resolve.
 *
 * Letting this worker directly *be* elkjs's worker script avoids
 * constructing any Worker at all in here, while still running the layout
 * algorithm off the main thread, in this dedicated worker's own thread.
 *
 * @module elk.worker
 */

/// <reference lib="webworker" />

import "elkjs/lib/elk-worker.js";
