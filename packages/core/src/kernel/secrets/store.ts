import { err, ok, type Result } from "../result/index.js";
import { WorkspaceIdSchema } from "../schemas/index.js";
import { Secret } from "./secret.js";

/**
 * Names one secret: a connection credential of a workspace. The store keeps it under service
 * `dev.tokama.<workspace>` and account `<account>`, so a ref can never name an item outside the
 * Tokama namespace (another app's Keychain item, say).
 */
export interface SecretRef {
  /** A workspace id (`WorkspaceIdSchema`): lowercase letters, digits and hyphens, at most 64 characters. */
  readonly workspace: string;
  /** Usually a connection id: letters, digits, `.`, `_` and `-`, at most 128 characters. */
  readonly account: string;
}

export type SecretErrorCode =
  /** The ref does not match the naming rules. */
  | "invalid_ref"
  /** The value is empty or longer than MAX_SECRET_BYTES. */
  | "invalid_value"
  /** get: no secret under this ref. */
  | "not_found"
  /** The store cannot be used now: keychain locked or missing, tool missing, timed out. */
  | "unavailable"
  /** No secret store for this OS yet. */
  | "unsupported_platform"
  | "failed";

/** Messages never contain the secret value, nor output of the OS tool (which can echo it). */
export interface SecretError {
  readonly code: SecretErrorCode;
  readonly message: string;
}

/** The OS secret store. Every method returns a Result and never throws. */
export interface SecretStore {
  /** Adds the secret, or replaces the one already under `ref`. */
  set(ref: SecretRef, value: Secret): Promise<Result<void, SecretError>>;
  /** `not_found` when nothing is stored under `ref`. */
  get(ref: SecretRef): Promise<Result<Secret, SecretError>>;
  /** Removes the secret; ok when there was none. */
  delete(ref: SecretRef): Promise<Result<void, SecretError>>;
  has(ref: SecretRef): Promise<Result<boolean, SecretError>>;
}

export const SECRET_SERVICE_PREFIX = "dev.tokama.";

/**
 * Largest value, in UTF-8 bytes, every store accepts. The macOS store passes the value to
 * `security -i` as one hex-encoded line, and that tool reads at most 4095 characters per line.
 * Enough for passwords, tokens and connection strings; not for PEM keys or kubeconfigs.
 */
export const MAX_SECRET_BYTES = 1536;

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StoreName {
  readonly service: string;
  readonly account: string;
}

/** The service and account a ref is stored under. These characters need no quoting in `security -i`. */
export function storeName(ref: SecretRef): Result<StoreName, SecretError> {
  if (!WorkspaceIdSchema.safeParse(ref.workspace).success) {
    return err({ code: "invalid_ref", message: "secret ref workspace must be lowercase letters, digits and hyphens (at most 64)" });
  }
  if (!ACCOUNT.test(ref.account)) {
    return err({ code: "invalid_ref", message: "secret ref account must be letters, digits, '.', '_' and '-' (at most 128)" });
  }
  return ok({ service: SECRET_SERVICE_PREFIX + ref.workspace, account: ref.account });
}

export function checkValue(value: Secret): Result<string, SecretError> {
  const text = value.reveal();
  if (text === "") return err({ code: "invalid_value", message: "secret value is empty" });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SECRET_BYTES) {
    return err({ code: "invalid_value", message: `secret value is ${bytes} bytes; the limit is ${MAX_SECRET_BYTES}` });
  }
  return ok(text);
}

/** An in-memory store, for tests and for platforms without an OS store implementation yet (Linux CI). */
export function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  const key = (name: StoreName) => `${name.service}\u0000${name.account}`;
  return {
    set(ref, value) {
      const name = storeName(ref);
      if (!name.ok) return Promise.resolve(name);
      const text = checkValue(value);
      if (!text.ok) return Promise.resolve(text);
      values.set(key(name.value), text.value);
      return Promise.resolve(ok(undefined));
    },
    get(ref) {
      const name = storeName(ref);
      if (!name.ok) return Promise.resolve(name);
      const text = values.get(key(name.value));
      if (text === undefined) return Promise.resolve(err({ code: "not_found", message: "no secret stored under this ref" }));
      return Promise.resolve(ok(new Secret(text)));
    },
    delete(ref) {
      const name = storeName(ref);
      if (!name.ok) return Promise.resolve(name);
      values.delete(key(name.value));
      return Promise.resolve(ok(undefined));
    },
    has(ref) {
      const name = storeName(ref);
      if (!name.ok) return Promise.resolve(name);
      return Promise.resolve(ok(values.has(key(name.value))));
    },
  };
}

/** The store for an OS without an implementation yet (libsecret on Linux and Windows Credential Manager come later). */
export function unsupportedSecretStore(platform: string): SecretStore {
  const fail = () =>
    Promise.resolve(err({ code: "unsupported_platform" as const, message: `no OS secret store for ${platform} yet` }));
  return { set: fail, get: fail, delete: fail, has: fail };
}
