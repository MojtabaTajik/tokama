import * as fs from "node:fs";
import fsDefault from "fs";

export const save = (path: string) => (fs.writeFileSync(path, "x"), fsDefault.renameSync(path, `${path}.old`));
