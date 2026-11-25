// Public surface of the config slice.
export {
  BUILTIN_AGENT_IDS,
  loadAgents,
  type Agent,
  type AgentOwner,
  type BrokenAgent,
  type LoadAgentsOptions,
  type LoadedAgents,
  type ModelDriverId,
} from "./agents.js";
export { DEFAULT_WORKTREE_FOLDER, loadRepos, type LoadReposOptions, type Repo } from "./repos.js";
export { CONFIG_FORMAT, formatProblem, type ConfigError, type ConfigProblem } from "./yaml-file.js";
export {
  addRepo,
  removeRepo,
  suggestRepo,
  updateRepo,
  type AddRepoInput,
  type RepoEditError,
  type RepoEditOptions,
  type RepoSuggestion,
  type UpdateRepoInput,
} from "./repos-edit.js";
