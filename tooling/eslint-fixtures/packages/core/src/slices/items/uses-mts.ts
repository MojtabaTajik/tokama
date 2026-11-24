// allowed: proves the resolver maps a .mjs specifier to a .mts file (an unresolved import fails).
import { helper } from "./helper.mjs";

export const value = helper;
