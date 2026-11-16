// Stands in for "bun:test" when the store tests run in workerd (vitest.config.ts aliases it).
// Each test runs inside its own fresh Durable Object, with its beforeEach/afterEach hooks, so the
// store's synchronous SQL calls happen in that object's context (they may not happen anywhere else).
import { env, runInDurableObject } from "cloudflare:test";
import * as vitest from "vitest";

export { expect, beforeAll, afterAll } from "vitest";

type Fn = () => unknown;
interface Scope { before: Fn[]; after: Fn[]; parent?: Scope }
let scope: Scope = { before: [], after: [] };

export function beforeEach(fn: Fn) { scope.before.push(fn); }
export function afterEach(fn: Fn) { scope.after.push(fn); }

export function describe(name: string, fn: () => void) {
  vitest.describe(name, () => {
    const parent = scope;
    scope = { before: [], after: [], parent };
    try { fn(); } finally { scope = parent; }
  });
}
describe.skip = (name: string, _fn: () => void) => vitest.describe.skip(name, () => { vitest.test.skip("bun only", () => {}); });

export function test(name: string, fn: Fn, timeout?: number) {
  const chain: Scope[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) chain.unshift(s);
  vitest.test(name, async () => {
    const ns = (env as { DB: DurableObjectNamespace }).DB;
    await runInDurableObject(ns.get(ns.newUniqueId()), async (_instance: unknown, state: { storage: unknown }) => {
      globalThis.gigsTestStorage = state.storage as typeof globalThis.gigsTestStorage;
      try {
        for (const s of chain) for (const hook of s.before) await hook();
        await fn();
      } finally {
        for (const s of [...chain].reverse()) for (const hook of [...s.after].reverse()) await hook();
        globalThis.gigsTestStorage = undefined;
      }
    });
  }, timeout);
}
test.skip = (name: string, _fn: Fn, _timeout?: number) => vitest.test.skip(name, () => {});
test.each = <T>(rows: readonly T[]) => (name: string, fn: (row: T) => unknown) => {
  for (const row of rows) test(name.replace("%s", String(row)), () => fn(row));
};
