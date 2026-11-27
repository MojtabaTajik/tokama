import { describe, expect, it } from "vitest";
import { type RepoKind, repoKinds, touchesOf, touchOf } from "./sensitive.js";

const kinds = (...list: RepoKind[]): ReadonlySet<RepoKind> => new Set(list);
const NONE = kinds();

describe("touchOf: kinds that hold in any repo", () => {
  it.each([
    ["db/migrations/0001_add_total.sql", "migrations"],
    ["schema.sql", "migrations"],
    ["src/Migrations/20260101_Init.cs", "migrations"],
    [".github/workflows/ci.yml", "ci"],
    [".gitlab-ci.yml", "ci"],
    ["azure-pipelines.yml", "ci"],
    ["azure-pipelines-release.yml", "ci"],
    ["Jenkinsfile", "ci"],
    ["Dockerfile", "infrastructure"],
    ["api/Dockerfile.prod", "infrastructure"],
    ["docker-compose.override.yml", "infrastructure"],
    ["infra/main.tf", "infrastructure"],
    ["infra/prod.tfvars", "infrastructure"],
    ["infra/app.bicep", "infrastructure"],
    ["k8s/deployment.yaml", "infrastructure"],
    ["deploy/helm/values.yaml", "infrastructure"],
    ["charts/api/Chart.yaml", "infrastructure"],
    [".env", "secrets"],
    [".env.production", "secrets"],
    ["config/secrets.json", "secrets"],
    ["secrets/key.pem", "secrets"],
    ["src/auth/login.ts", "sign_in"],
    ["src/security/policy.ts", "sign_in"],
    ["package.json", "dependencies"],
    ["web/package.json", "dependencies"],
    ["pnpm-lock.yaml", "dependencies"],
    ["yarn.lock", "dependencies"],
    ["go.sum", "dependencies"],
    ["Cargo.lock", "dependencies"],
    ["poetry.lock", "dependencies"],
    ["src/Api/Api.csproj", "dependencies"],
    ["Directory.Packages.props", "dependencies"],
    ["packages.lock.json", "dependencies"],
    ["global.json", "dependencies"],
    ["pyproject.toml", "dependencies"],
    ["services/api/requirements-dev.txt", "dependencies"],
    ["Pipfile", "dependencies"],
    ["services/x/go.mod", "dependencies"],
    ["crates/api/Cargo.toml", "dependencies"],
    ["pom.xml", "dependencies"],
    ["app/build.gradle.kts", "dependencies"],
    ["src/Api/appsettings.Production.json", "secrets"],
  ])("%s is %s, with no repo kind known (a .NET repo with only a .sln, a monorepo)", (path, kind) => {
    expect(touchOf(path, false, NONE)).toBe(kind);
  });

  it.each(["src/total.ts", "README.md", "docs/auth.md", "src/authors/list.ts", "src/total.css", "src/author.ts"])("%s is not sensitive", (path) => {
    expect(touchOf(path, false, kinds("node", "python", "dotnet"))).toBeUndefined();
  });

  it("matches in lowercase, as the protected files do", () => {
    expect(touchOf("DOCKERFILE", false, NONE)).toBe("infrastructure");
    expect(touchOf("SRC/AUTH/Login.ts", false, NONE)).toBe("sign_in");
  });
});

describe("touchOf: kinds that belong to a kind of repo", () => {
  it.each([
    ["node", "prisma/schema.prisma", "migrations"],
    ["python", "alembic/versions/ab12_add.py", "migrations"],
    ["go", "db/migrate/20260101_init.up.sql", "migrations"],
    ["rust", "db/migrate/20260101_init.rb", "migrations"],
    ["java", "db/migrate/V1__init.java", "migrations"],
    ["python", "shop/settings_prod.py", "secrets"],
  ] as const)("%s repo: %s is %s", (kind, path, touched) => {
    expect(touchOf(path, false, kinds(kind))).toBe(touched);
  });

  it.each([
    ["node", "shop/settings_prod.py"],
    ["node", "alembic/versions/ab12_add.py"],
    ["node", "shop/settings.py"],
    ["node", "prisma/other.prisma"],
  ])("%s repo: %s is not sensitive", (kind, path) => {
    expect(touchOf(path, false, kinds(kind as RepoKind))).toBeUndefined();
  });
});

describe("touchOf: test files", () => {
  it("counts a new test file as added and a changed one as edited, whatever folder it is in", () => {
    expect(touchOf("src/total.test.ts", true, NONE)).toBe("tests_added");
    expect(touchOf("src/total.test.ts", false, NONE)).toBe("tests_edited");
    expect(touchOf("pkg/total_test.go", true, NONE)).toBe("tests_added");
    expect(touchOf("src/auth/login.test.ts", true, NONE)).toBe("tests_added");
    expect(touchOf("tests/migrations/up.sql", false, NONE)).toBe("tests_edited");
  });
});

describe("repoKinds", () => {
  it("takes kinds from the markers present in the base commit", () => {
    expect([...repoKinds(["package.json", "go.mod"], [])].sort()).toEqual(["go", "node"]);
    expect([...repoKinds(["pom.xml"], [])]).toEqual(["java"]);
    expect([...repoKinds([], [])]).toEqual([]);
  });

  it("takes kinds from the extensions of the changed files, and a root marker the change adds", () => {
    expect([...repoKinds([], ["Api/Program.cs", "tools/run.py"])].sort()).toEqual(["dotnet", "python"]);
    expect([...repoKinds([], ["Cargo.toml", "src/lib.rs"])]).toEqual(["rust"]);
    expect([...repoKinds([], ["web/package.json"])]).toEqual([]);
  });

  it("lets a repo be several kinds, so each kind's files count in it", () => {
    const all = repoKinds(["package.json"], ["services/api/Api.csproj", "ml/train.py"]);
    expect([...all].sort()).toEqual(["dotnet", "node", "python"]);
    expect(touchOf("services/api/Api.csproj", false, all)).toBe("dependencies");
    expect(touchOf("ml/pyproject.toml", false, all)).toBe("dependencies");
  });
});

describe("touchesOf", () => {
  it("counts the files of each kind, in the order of the kinds", () => {
    const files = [
      { path: "src/total.test.ts", added: true },
      { path: "package.json", added: false },
      { path: "db/migrations/1.sql", added: true },
      { path: "db/migrations/2.sql", added: true },
      { path: "src/total.ts", added: false },
      { path: ".github/workflows/ci.yml", added: false },
      { path: "src/old.test.ts", added: false },
    ];
    expect(touchesOf(files, NONE)).toEqual([
      { kind: "dependencies", files: 1 },
      { kind: "migrations", files: 2 },
      { kind: "ci", files: 1 },
      { kind: "tests_added", files: 1 },
      { kind: "tests_edited", files: 1 },
    ]);
  });

  it("is empty when no file has a kind", () => {
    expect(touchesOf([{ path: "src/total.ts", added: false }], NONE)).toEqual([]);
  });
});
