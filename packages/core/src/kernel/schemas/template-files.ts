// The records the engine API serves for the Templates page: every template file the engine found,
// loaded or not, and one file in full. A file is named by where it is (`origin` and `file`), not
// by its ref, because a file whose name is not a valid id has no ref.
import { z } from "zod";
import { TemplateRefSchema } from "./ids.js";
import { IconNameSchema, TagColorSchema, TemplateRecordSchema, TemplateStepDefSchema } from "./template.js";

/** The longest template file the engine reads, in bytes; a file's text is never longer. */
export const MAX_TEMPLATE_FILE_BYTES = 256 * 1024;
/** The most template files one `templates` reply lists. */
export const MAX_TEMPLATE_ENTRIES = 2000;
const message = z.string().min(1).max(1000);

/** Where a template file is: `builtin` and the built-in's ref, or a repo id and the repo-relative path. */
export const TemplateFileKeySchema = z.strictObject({
  origin: z.string().min(1).max(64),
  /** e.g. `.tokama/templates/quick-fix.yaml`, or `builtin/quick-fix` for a built-in. */
  file: z.string().min(1).max(300),
});

export const TemplateProblemSchema = z.strictObject({
  /** 1-based; 1 for problems with the file as a whole. */
  line: z.int().min(1),
  message,
});

/** One template file in the list: enough for its row. */
export const TemplateEntrySchema = TemplateFileKeySchema.extend({
  /** Absent when the file name is not a valid template id. */
  ref: TemplateRefSchema.optional(),
  /** Absent when the file does not load. */
  name: z.string().min(1).max(100).optional(),
  icon: IconNameSchema.optional(),
  color: TagColorSchema.optional(),
  /** 0 when the template loads. */
  problemCount: z.int().min(0),
  /** The file is on this machine, so the app can open it in an editor. False for built-ins and sample templates. */
  openable: z.boolean(),
});

/** A step as the page shows it: everything but the instruction text, which can be long. */
export const TemplateStepViewSchema = TemplateStepDefSchema.omit({ instructions: true }).extend({
  /** The instruction file, relative to the template file; absent for inline text. */
  instructionsFile: z.string().min(1).max(200).optional(),
});

export const TemplateViewSchema = TemplateRecordSchema.omit({ steps: true }).extend({
  steps: z.array(TemplateStepViewSchema).min(1).max(20),
});

/** One template file in full. */
export const TemplateDetailSchema = z.strictObject({
  entry: TemplateEntrySchema,
  /** The template as the engine runs it; null when the file does not load. */
  template: TemplateViewSchema.nullable(),
  problems: z.array(TemplateProblemSchema).max(100),
  /** Things the template does that the engineer may not expect. */
  warnings: z.array(message).max(50),
  /** The file as read; null when it could not be read or is too large to send. */
  text: z.string().max(MAX_TEMPLATE_FILE_BYTES).nullable(),
  /** The file was read but left out: with it, the reply would be larger than a message may be. */
  textTooLarge: z.boolean(),
  /** The file's full path on the engine's machine, when `entry.openable`. */
  path: z.string().min(1).max(4096).nullable(),
});

export type TemplateFileKey = z.output<typeof TemplateFileKeySchema>;
export type TemplateProblemRecord = z.output<typeof TemplateProblemSchema>;
export type TemplateEntry = z.output<typeof TemplateEntrySchema>;
export type TemplateStepView = z.output<typeof TemplateStepViewSchema>;
export type TemplateView = z.output<typeof TemplateViewSchema>;
export type TemplateDetail = z.output<typeof TemplateDetailSchema>;
