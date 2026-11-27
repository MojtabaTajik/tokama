import { describe, expect, it } from "vitest";
import { isSecretName, isShownName } from "./secrets.js";

describe("isSecretName", () => {
  it.each([
    ".env", ".ENV", ".env.local", ".Env.Production", ".envrc", ".npmrc", ".NPMRC", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials",
    "NuGet.Config", "nuget.config", "gradle.properties", "Gradle.Properties", "local.properties", "settings.xml", "Settings.XML",
    "server.pem", "SERVER.PEM", "tls.key", "a.p12", "a.pfx", "release.jks", "debug.keystore", "prod.tfvars", "PROD.TFVARS",
    "id_rsa", "ID_ED25519", "id_rsa.pub", "credentials", "credentials.json", "Credentials.yml", "secrets", "secrets.yml", "Secrets.json",
  ])("refuses %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(["package.json", "Makefile", "env.ts", "environment.yml", "README.md", "pom.xml", "keys.md", "monkey.keyboard", "settings.json", "identity.py", "secret.md"])("lets %s through", (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it("compares the Unicode-normalized, lower-cased name", () => {
    expect(isSecretName(".env".normalize("NFD"))).toBe(true);
    expect(isSecretName("SECRETS-é".normalize("NFD"))).toBe(true);
  });
});

describe("isShownName", () => {
  it("hides a name with a control, format or separator character, and an empty name", () => {
    for (const name of ["a\nb", "a\u0000b", "a​b", "a‮b", "a b", "a\u0085b", ""]) expect(isShownName(name)).toBe(false);
  });

  it("keeps a decomposed name as it is", () => {
    expect(isShownName("école.md")).toBe(true);
  });
});
