import { describe, expect, it } from "vitest";
import { REDACTED, scrubTokens } from "./tokens.js";

const GH = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`;
const STRIPE = ["sk", "live", ""].join("_");
const AWS ="AKIAIOSFODNN7EXAMPLE";
const NPM = `npm_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6".slice(0, 36)}`;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("scrubTokens", () => {
  it.each([
    ["a GitHub token", `clone failed with ${GH}`, GH],
    ["a GitHub fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "github_pat_11ABCDEFG"],
    ["an AWS access key id", `key ${AWS} rejected`, AWS],
    ["an npm token", `npm publish with ${NPM}`, NPM],
    ["an Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant-api03"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "xoxb-1234567890"],
    // Built from parts, so the repo's secret scanning does not take the fixture for a real key.
    ["a Stripe key", `${STRIPE}abcdefghijklmnopqrstuvwx`, `${STRIPE}abcdef`],
    ["a JWT", `jwt ${JWT} expired`, JWT],
  ])("hides %s", (_name, text, secret) => {
    const out = scrubTokens(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("hides the value of an environment-style assignment and keeps the command around it", () => {
    expect(scrubTokens("API_KEY=abc123 pnpm test")).toBe(`API_KEY=${REDACTED} pnpm test`);
    expect(scrubTokens("NPM_TOKEN=hunter2 DB_PASSWORD='p w d' pnpm build")).toBe(`NPM_TOKEN=${REDACTED} DB_PASSWORD='${REDACTED}' pnpm build`);
    expect(scrubTokens("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY pnpm test")).toBe(`AWS_SECRET_ACCESS_KEY=${REDACTED} pnpm test`);
    expect(scrubTokens("STRIPE_KEY=rk_abc pnpm test")).toBe(`STRIPE_KEY=${REDACTED} pnpm test`);
    expect(scrubTokens("//registry.npmjs.org/:_authToken=abcdef123456")).toBe(`//registry.npmjs.org/:_authToken=${REDACTED}`);
    expect(scrubTokens("//registry.npmjs.org/:_auth=dXNlcjpwYXNz")).toBe(`//registry.npmjs.org/:_auth=${REDACTED}`);
  });

  it("hides JSON and flag forms", () => {
    expect(scrubTokens('{"client_secret": "s3cr3t value", "name": "orders-api"}')).toBe(`{"client_secret": "${REDACTED}", "name": "orders-api"}`);
    expect(scrubTokens("deploy --api-key=abc123 --token xyz789 --region eu")).toBe(`deploy --api-key=${REDACTED} --token ${REDACTED} --region eu`);
  });

  it("hides a quoted flag value, a PGP key block and a spaced value that looks like a secret", () => {
    expect(scrubTokens('docker login --password "s3cr3t Value9" --username moji')).toBe(`docker login --password ${REDACTED} --username moji`);
    expect(scrubTokens("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\n-----END PGP PRIVATE KEY BLOCK-----")).toBe(REDACTED);
    expect(scrubTokens("password = hunter2value1")).toBe(`password = ${REDACTED}`);
    expect(scrubTokens("password: hunter2value1")).toBe(`password: ${REDACTED}`);
  });

  it("hides curl user:password, a URL password with no user, YAML and connection-string values, and quoted headers", () => {
    expect(scrubTokens("curl -u deploy:s3cr3tP4ss https://x.test --user a:b2c3")).toBe(`curl -u deploy:${REDACTED} https://x.test --user a:${REDACTED}`);
    expect(scrubTokens("docker run -u 1000:1000 --user 0:0 app")).toBe("docker run -u 1000:1000 --user 0:0 app");
    expect(scrubTokens("REDIS_URL=redis://:s3cr3tP4ss@cache:6379")).toBe(`REDIS_URL=redis://:${REDACTED}@cache:6379`);
    expect(scrubTokens("DB_PASS=abc DB_PWD=abc SECRET_KEY_BASE=abc")).toBe(`DB_PASS=${REDACTED} DB_PWD=${REDACTED} SECRET_KEY_BASE=${REDACTED}`);
    expect(scrubTokens("POSTGRES_PASSWORD: hunter2\nDB_PASSWORD: supersecretpassword\nAccountKey=abc/def==;Other=1")).toBe(
      `POSTGRES_PASSWORD: ${REDACTED}\nDB_PASSWORD: ${REDACTED}\nAccountKey=${REDACTED};Other=1`,
    );
    expect(scrubTokens('{"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}')).toBe(`{"Authorization": "Basic ${REDACTED}"}`);
    expect(scrubTokens("GET /x?token=abc123&user=moji")).toBe(`GET /x?token=${REDACTED}&user=moji`);
  });

  it("hides the credential of an authorization header and keeps the scheme", () => {
    expect(scrubTokens("Authorization: Bearer abc.def-123")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(scrubTokens('curl -H "Authorization: Basic dXNlcjpwYXNz" https://api.example.test/v1')).toBe(`curl -H "Authorization: Basic ${REDACTED}" https://api.example.test/v1`);
    expect(scrubTokens("X-Api-Key: 0123456789abcdef")).toBe(`X-Api-Key: ${REDACTED}`);
    expect(scrubTokens("sent Bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(`sent Bearer ${REDACTED}`);
  });

  it("hides the password of a URL and keeps the user, host and path", () => {
    expect(scrubTokens("git clone https://deploy:s3cr3t@git.example.test/orders-api.git")).toBe(`git clone https://deploy:${REDACTED}@git.example.test/orders-api.git`);
    expect(scrubTokens("postgres://app:pw@db.internal:5432/orders")).toBe(`postgres://app:${REDACTED}@db.internal:5432/orders`);
  });

  it("hides a private key block, also one that never ends", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    expect(scrubTokens(`before\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(scrubTokens(`x\n-----BEGIN RSA PRIVATE KEY-----\n${body}`)).toBe(`x\n${REDACTED}`);
    // A message that only quotes the header keeps the output after it.
    const quoted = 'Error: missing "-----BEGIN PRIVATE KEY-----" header\n  at parse (src/pem.ts:3)\nFAIL 3 tests';
    expect(scrubTokens(quoted)).toBe(quoted.replace("-----BEGIN PRIVATE KEY-----", REDACTED));
    expect(scrubTokens(`-----BEGIN PRIVATE KEY-----\n${body}\nFAIL 3 tests`)).toBe(`${REDACTED}\nFAIL 3 tests`);
  });

  it("leaves normal output alone", () => {
    const normal = [
      "FAIL src/orders.test.ts > creates an order",
      "AssertionError: expected 3 to be 4 at /work/orders-api/src/orders.ts:42:7",
      "git ssh://git@github.com/tokama-dev/tokama.git and https://registry.npmjs.org/zod/-/zod-4.6.7.tgz",
      "commit 127620e0a1b2c3d4e5f60718293a4b5c6d7e8f90 and sha512-ZLmY6VaUtXgbfJqS2Hs3fU2m0nq7tGR6yR8CqR1KmS1vWfYQW4nJkP9aXc5eZ3t0uO8bI1dH6lN2rM4sT7wQ==",
      "token_count=5 author=moji keyboard=us tokens: 12 passwordless login ok",
      "Property 'token' is missing; token: string; password: string;",
      "Bearer authentication is required",
      '"auth": "^1.2.3" AUTH=1 auth=basic',
      "--password-stdin --token-count 5 npm login",
      "API_KEY=$API_KEY GITHUB_TOKEN=${GITHUB_TOKEN} PASSWORD=",
      "secret=<redacted> token=***",
      // A failed assertion prints source lines; the agent needs them as they are.
      "> 12 |   const token = await login(user, password);",
      '    13 |   const secret = process.env.JWT_SECRET ?? "dev";',
      "    14 |   if (token == null || password != secret || token === secret) return;",
      "    15 |   const handler = (token) => token => password;",
      "PASSWORD= pnpm test && TOKEN=$(cat token.txt) pnpm build && CACHE_KEY=build1 PRIMARY_KEY=id",
      "sk-loading-placeholder-component and --with-token < token.txt",
    ].join("\n");
    expect(scrubTokens(normal)).toBe(normal);
  });

  it("hides a token in a string that holds many of them, and does not change a clean one", () => {
    expect(scrubTokens(`${GH} and ${AWS}`)).toBe(`${REDACTED} and ${REDACTED}`);
    expect(scrubTokens("")).toBe("");
  });

  // A run the size of a failed check's output (64 Ki): each of these made an unanchored pattern quadratic.
  it.each(["-", "x-", "a.", "a_", "A_", "x:", "token ", "-----BEGIN PRIVATE KEY-----", "--token-", "Bearer ", "KEY_", "a=", "://", "sk-", "eyJ-", "-----BEGIN PRIVATE KEY-----\n", "_auth"])("stays fast on a long run of %j", (unit) => {
    const input = unit.repeat(Math.ceil(65_536 / unit.length));
    const started = performance.now();
    scrubTokens(input);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
