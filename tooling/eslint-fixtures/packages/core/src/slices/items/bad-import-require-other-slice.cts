// `import = require` is the import form of .cts files; the boundary rules still see it.
import worktrees = require("../worktrees/index.js");

export const create = worktrees.createWorktree;
