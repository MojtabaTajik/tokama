// Diagnostics: errors, warnings, usage counts and crashes, cleaned and kept on this machine.
export { BODY_OVERHEAD_BYTES, diagnosticsBody, entryBodyBytes, entryText } from "./body.js";
export { cleanStack, describeThrown, fingerprint, nameOfStack, PLACEHOLDERS, redactText, type RedactionContext } from "./redact.js";
export { markStoppedByApp, STOPPED_BY_APP_FILE, STOPPED_BY_APP_MAX_AGE_MS, takeStoppedByApp } from "./stopped-by-app.js";
export { DiagnosticsStore, ENTRIES_FILE, RUNNING_FILE, SETTINGS_FILE, utcDay, type DeleteTarget, type DiagnosticsFilter, type DiagnosticsStoreOptions, type SettingsChange } from "./store.js";
