// Bare DO host for the DoSqlDriver contract tests — the tests reach its
// state.storage via cloudflare:test's runInDurableObject; the class itself
// does nothing.

export class DriverHost {
  constructor(readonly state: unknown) {}
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("mh-do-driver-test");
  },
};
