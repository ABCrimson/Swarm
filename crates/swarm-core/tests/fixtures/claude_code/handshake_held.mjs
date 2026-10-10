// A CLI that withholds its `initialize` reply until the test creates the
// release marker in its working directory, then answers it. Lets a test
// act (kill the worker) while the session's handshake is in flight.
export const config = { initialize: "held" };
