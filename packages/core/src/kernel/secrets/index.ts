// kernel/secrets: connection credentials in the OS secret store (macOS Keychain first; libsecret
// and Windows Credential Manager later), behind one interface. Values travel as `Secret`, which
// never prints itself, so they stay out of logs, agent prompts and errors.
// See docs/spec/architecture.md, sections 6, 8 and 9.
import type { ProcessRunner } from "../process/index.js";
import { createKeychainStore } from "./keychain.js";
import { unsupportedSecretStore, type SecretStore } from "./store.js";

export { createKeychainStore, type KeychainStoreOptions } from "./keychain.js";
export { Secret } from "./secret.js";
export {
  MAX_SECRET_BYTES,
  SECRET_SERVICE_PREFIX,
  createMemorySecretStore,
  unsupportedSecretStore,
  type SecretError,
  type SecretErrorCode,
  type SecretRef,
  type SecretStore,
} from "./store.js";

/** The OS secret store of this machine; `unsupported_platform` on every call where there is none yet. */
export function createSecretStore(options: { readonly platform?: NodeJS.Platform; readonly runner?: ProcessRunner } = {}): SecretStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return createKeychainStore(options.runner === undefined ? {} : { runner: options.runner });
  return unsupportedSecretStore(platform);
}
