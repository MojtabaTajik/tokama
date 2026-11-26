# Template schema

`template-1.json` is the JSON schema (draft 7) of format 1 of the template file format, made from
the format's zod schema. `template.json` is the same schema for the newest format; pin
`template-1.json` so an editor keeps checking format 1 files against format 1. Editors use the
schema for autocomplete, hover text and inline errors while you write a template. It checks the
shape of the file only: agents that are not set up, `back:` targets that point to no step, and the
cloud data rules are checked by Tokama when it loads the template.

Do not edit the files by hand. After a change to the format, run:

```sh
pnpm build && pnpm --filter @tokama/core schema
```

A test fails while a file does not match the format.

## Use it in a repo

Editors fetch the schema from its address,
`https://tokama.dev/schema/template-1.json`. Autocomplete and inline errors start to work once
tokama.dev serves the file.

With the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
(or any editor that uses yaml-language-server), point one template at the schema with a first line:

```yaml
# yaml-language-server: $schema=https://tokama.dev/schema/template-1.json
format: 1
name: Quick fix
```

To cover every template in the repo at once, add this to the repo's `.vscode/settings.json`
instead:

```json
{
  "yaml.schemas": {
    "https://tokama.dev/schema/template-1.json": ".tokama/templates/*.yaml"
  }
}
```
