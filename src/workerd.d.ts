// Just enough of the workerd runtime modules' types for tsc, which checks this repo with Bun's types.
declare module "cloudflare:workers" {
  export abstract class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }
}
