// kernel/fs-safe: read files that agents or repos may have written (transcripts, evidence,
// templates, prompt files) without following a planted symlink, hanging on a FIFO or loading a
// huge file.
export {
  isInside,
  readJsonFile,
  readTextFile,
  type ReadFailure,
  type ReadFailureReason,
  type ReadTextOptions,
} from "./read.js";
