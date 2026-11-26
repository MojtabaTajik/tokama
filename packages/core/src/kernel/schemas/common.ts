// Field shapes that API messages and the records they carry share.
import { z } from "zod";

/** A folder on the engine's machine. The engine checks it: a full path to a git repo's top folder. */
export const folderPath = z.string().min(1).max(4096);
/** The longest check command a repo may have, in repos.yaml and in every message that carries one. */
export const MAX_CHECK_CHARS = 500;
export const checkCommand = z.string().max(MAX_CHECK_CHARS);
