// allowed: workflow-engine composes other slices through their public entries.
import { createItem } from "../items/index.js";
import { createWorktree } from "../worktrees/index.js";

export const runItem = () => [createItem({ version: 1 }), createWorktree()];
