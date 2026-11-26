// Public surface of the templates slice.
export { BUILTIN_TEMPLATES } from "./builtin.js";
export { TEMPLATE_SCHEMA_FILES, templateJsonSchema, templateJsonSchemaText } from "./json-schema.js";
export { loadBuiltins, loadTemplates, TEMPLATES_DIR, type LoadInput, type RepoLocation, type TemplateLoad } from "./load.js";
export { validateTemplate, type AgentLocation, type TemplateProblem, type ValidateContext } from "./validate.js";
export { templateWarnings } from "./warnings.js";
