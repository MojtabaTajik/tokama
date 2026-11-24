// Public surface of the templates slice.
export { BUILTIN_TEMPLATES } from "./builtin.js";
export { templateJsonSchema } from "./json-schema.js";
export { loadBuiltins, loadTemplates, TEMPLATES_DIR, type LoadInput, type RepoLocation, type TemplateLoad } from "./load.js";
export { validateTemplate, type AgentLocation, type TemplateProblem, type ValidateContext } from "./validate.js";
