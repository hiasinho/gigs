// Just enough of the workerd runtime modules' types for tsc, which checks this repo with Bun's types.
declare module "cloudflare:workers" {
  export abstract class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }
}
// Text imports (`with { type: "text" }`) of the agent skill.
declare module "*.md" {
  const text: string;
  export default text;
}
// Baked in by scripts/build.ts --version (bun build --define); undeclared at runtime otherwise.
declare const GIGS_VERSION: string | undefined;
