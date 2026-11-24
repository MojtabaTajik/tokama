// Lets Node run the adapter's TypeScript sources directly (`node --import resolve-ts.ts hook.ts`):
// a relative `.js` import that does not exist is resolved to the `.ts` file next to it, as the
// build would have produced. Tests only; the engine runs the built `.js` files.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
