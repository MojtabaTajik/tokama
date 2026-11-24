# templates

The template file format (`.tokama/templates/<id>.yaml` in a repo), loading, validation and the built-in templates.
Turns each file into a `TemplateRecord` (kernel/schemas) referred to as `<repo>/<id>` or `builtin/<id>`, or into problems in plain words with line numbers.
Reads files only through kernel/fs-safe; instruction files must stay inside the templates folder.
Must not run templates, start agents or know where agents come from: the caller passes each agent's id and whether it runs in the cloud.
