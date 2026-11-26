import { basename, dirname, join } from "node:path";

/**
 * The folders that hold the running engine's code, from the folder of its entry file. In an app
 * bundle that is the engine folder (`<engine>/dist/main.js`); in a checkout it is the checkout,
 * found by its pnpm-workspace.yaml (`<checkout>/apps/engine/dist/main.js`). The tree is never
 * searched upwards: a bundle that sits inside a checkout is still a bundle.
 */
export function engineCodeRoots(entryDir: string, isFile: (path: string) => boolean): string[] {
  const engine = dirname(entryDir);
  const apps = dirname(engine);
  const checkout = dirname(apps);
  if (basename(engine) === "engine" && basename(apps) === "apps" && isFile(join(checkout, "pnpm-workspace.yaml"))) return [checkout];
  return [engine];
}
