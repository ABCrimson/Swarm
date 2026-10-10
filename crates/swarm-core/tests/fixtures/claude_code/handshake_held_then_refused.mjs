// A CLI that withholds its `initialize` reply until the test creates the
// release marker in its working directory, then refuses it.
export const config = { initialize: "held", released: "error" };
