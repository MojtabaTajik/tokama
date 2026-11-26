// Checks a packaged Tokama.app (and its zip, dmg and update feed file) and prints one line per check:
//   node scripts/verify-package.ts --app <Tokama.app> [--zip <zip>] [--dmg <dmg>] [--latest <latest-mac.yml>]
//     --version <x.y.z> --feed-url <url> (--unsigned | --signed --team <TEAMID>) [--dir-build]
// The mode is always named, never guessed from the app: a signed build must not pass for lack of
// signing checks. Every check runs; the script exits 1 and names each failure if any failed.
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { feedUrlProblem } from "./package.ts";
import { Report, checkApp, checkDmg, checkZip, type VerifyOptions } from "./verify-package-mac.ts";

/** Reads and checks the command line; throws an Error that names the problem. */
export function parseVerifyArgs(argv: readonly string[]): VerifyOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      app: { type: "string" },
      zip: { type: "string" },
      dmg: { type: "string" },
      latest: { type: "string" },
      version: { type: "string" },
      "feed-url": { type: "string" },
      unsigned: { type: "boolean" },
      signed: { type: "boolean" },
      team: { type: "string" },
      "dir-build": { type: "boolean" },
    },
  });
  if (values["dir-build"] === true && (values.zip !== undefined || values.dmg !== undefined || values.latest !== undefined)) throw new Error("--dir-build means no zip, dmg or latest-mac.yml");
  if (values.unsigned === values.signed) throw new Error("name the mode: exactly one of --unsigned and --signed");
  const team = values.team;
  if (values.signed === true && (team === undefined || !/^[A-Z0-9]{10}$/.test(team))) throw new Error("--signed needs --team with the 10-character team id");
  if (values.unsigned === true && team !== undefined) throw new Error("--team belongs to --signed");
  const { app, version, "feed-url": feedUrl } = values;
  if (app === undefined) throw new Error("--app is required");
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("--version is required, as x.y.z");
  if (feedUrl === undefined) throw new Error("--feed-url is required");
  const problem = feedUrlProblem(feedUrl);
  if (problem !== undefined) throw new Error(problem);
  if (values.latest !== undefined && values.zip === undefined) throw new Error("--latest needs --zip, whose digest it must hold");
  return {
    app,
    version,
    feedUrl,
    mode: values.signed === true && team !== undefined ? { kind: "signed", team } : { kind: "unsigned" },
    ...(values.zip !== undefined && { zip: values.zip }),
    ...(values.dmg !== undefined && { dmg: values.dmg }),
    ...(values.latest !== undefined && { latest: values.latest }),
    ...(values["dir-build"] === true && { dirBuild: true }),
  };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write("verify-package: only macOS packages can be verified.\n");
    process.exit(1);
  }
  let options: VerifyOptions;
  try {
    options = parseVerifyArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-package: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const report = new Report();
  await report.check("app exists", () => (statSync(options.app).isDirectory() ? undefined : `${options.app} is not a folder`));
  if (report.failures.length === 0) {
    await checkApp(report, options.app, options, "app");
    if (options.zip !== undefined) await checkZip(report, options, options.zip);
    if (options.dmg !== undefined) await checkDmg(report, options, options.dmg);
  }
  if (report.failures.length > 0) {
    process.stderr.write(`verify-package: ${report.failures.length} check(s) failed:\n${report.failures.map((failure) => `  ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`verify-package: all checks passed (${options.mode.kind})\n`);
}

if (import.meta.main) await main();
