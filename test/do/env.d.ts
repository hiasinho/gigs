// Just enough of the workerd test module's types for tsc (cloudflare:workers is in src/workerd.d.ts).
declare module "cloudflare:test" {
  export const env: unknown;
  export const SELF: { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
  export function runInDurableObject<R>(stub: unknown, fn: (instance: unknown, state: { storage: unknown }) => R | Promise<R>): Promise<R>;
}
interface DurableObjectNamespace {
  newUniqueId(): unknown;
  get(id: unknown): unknown;
}
