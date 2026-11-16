// Just enough of the workerd test modules' types for tsc, which checks this repo with Bun's types.
declare module "cloudflare:workers" {
  export abstract class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }
}
declare module "cloudflare:test" {
  export const env: unknown;
  export function runInDurableObject<R>(stub: unknown, fn: (instance: unknown, state: { storage: unknown }) => R | Promise<R>): Promise<R>;
}
interface DurableObjectNamespace {
  newUniqueId(): unknown;
  get(id: unknown): unknown;
}
