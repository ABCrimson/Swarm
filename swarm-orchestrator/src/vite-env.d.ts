/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module "*.css" {}

// TC39 Observable proposal — required by jotai's atomWithObservable
interface SymbolConstructor {
  readonly observable: unique symbol;
}
