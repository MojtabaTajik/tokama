# Template schema

`template.schema.json` is the JSON schema (draft 7) of the template file format, made from the
format's zod schema. Editors use it for autocomplete, hover text and inline errors while you write
a template. It checks the shape of the file only: agents that are not set up, `back:` targets that
point to no step, and the cloud data rules are checked by Tokama when it loads the template.

Do not edit the file by hand. After a change to the format, run:

```sh
pnpm build && pnpm --filter @tokama/core schema
```

A test fails while the file does not match the format.

## Use it in a repo

Copy `template.schema.json` into the repo as `.tokama/template.schema.json`. Tokama reads only
`.yaml` files in `.tokama/templates/`, so the copy is not taken for a template.

With the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
(or any editor that uses yaml-language-server), point one file at the schema with a first line:

```yaml
# yaml-language-server: $schema=../template.schema.json
format: 1
name: Quick fix
```

The path is relative to the template file. To cover every template in the repo at once, add this
to the repo's `.vscode/settings.json` instead:

```json
{
  "yaml.schemas": {
    "./.tokama/template.schema.json": ".tokama/templates/*.yaml"
  }
}
```
