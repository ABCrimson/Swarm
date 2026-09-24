// A CLI that never answers `initialize`; it writes its pid file so the
// test can check the spawn failure reaped it.
export const config = { initialize: "never", writePid: true };
