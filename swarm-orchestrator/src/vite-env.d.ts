/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module "*.css" {}

/** App version injected at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;

// TC39 Observable proposal — required by jotai's atomWithObservable
interface SymbolConstructor {
  readonly observable: unique symbol;
}
