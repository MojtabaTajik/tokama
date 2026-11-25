// kernel/fs-safe: read files that agents or repos may have written (transcripts, evidence,
// templates, prompt files) without following a planted symlink, hanging on a FIFO or loading a
// huge file.
export {
  isInside,
  listFiles,
  listFolders,
  readJsonFile,
  readLinesFrom,
  readTextFile,
  readTextFileInside,
  readTextHead,
  type ReadFailure,
  type ReadFailureReason,
  type ReadLinesOptions,
  type ReadLinesResult,
  type ReadTextOptions,
} from "./read.js";
