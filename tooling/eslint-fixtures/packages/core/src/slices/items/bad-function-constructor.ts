export const viaConstructor = (() => undefined).constructor("return import('node:child_process')");
export const viaFunction = new Function("return import('node:child_process')");
export const viaEval = eval("import('node:child_process')");
