import { inspect } from "node:util";

const MASK = "[secret]";

/**
 * A secret value that renders as `[secret]` in String(), template literals, JSON.stringify and
 * util.inspect (console.log, loggers), so it cannot leak through logging or JSON by accident.
 * Callers read the value with `reveal()`, explicitly and as late as possible.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [Symbol.toPrimitive](): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
