// The helpers this build of Tokama has. A helper is added here as one definition (its answer's
// shape is in the engine API, its inputs in `definition.ts`).
import type { HelperId } from "../../kernel/schemas/index.js";
import type { HelperDefinition } from "./definition.js";
import { suggestChecks } from "./suggest-checks.js";

export const BUILTIN_HELPERS: readonly HelperDefinition[] = [suggestChecks];

export const findHelper = (definitions: readonly HelperDefinition[], id: HelperId): HelperDefinition | undefined => definitions.find((definition) => definition.id === id);
