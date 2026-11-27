// Checks a packaged Tokama.app (and its zip, dmg and update feed file) and prints one line per check:
//   node scripts/verify-package.ts --app <Tokama.app> [--zip <zip>] [--dmg <dmg>] [--latest <latest-mac.yml>]
//     --version <x.y.z> --feed-url <url> [--min-safe-version <x.y.z>] (--unsigned | --signed --team <TEAMID>) [--dir-build] [--allow-gatekeeper-off]
// The mode is always named, never guessed from the app: a signed build must not pass for lack of
// signing checks. Every check runs; the script exits 1 and names each failure if any failed.
// On Linux it checks the .deb and the .rpm, and the update feed file that lists both:
//   node scripts/verify-package.ts --linux [--deb <deb>] [--rpm <rpm>] [--latest <latest-linux.yml>]
//     --version <x.y.z> --feed-url <url> [--min-safe-version <x.y.z>]
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { feedUrlProblem, minSafeVersionProblem } from "./package.ts";
import { Report } from "./verify-package-common.ts";
import { type LinuxVerifyOptions, checkLatest, checkPackage } from "./verify-package-linux.ts";
import { checkApp, checkDmg, checkZip, type VerifyOptions } from "./verify-package-mac.ts";

/** Reads and checks the command line of a Linux run; throws an Error that names the problem. */
export function parseLinuxVerifyArgs(argv: readonly string[]): LinuxVerifyOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { linux: { type: "boolean" }, deb: { type: "string" }, rpm: { type: "string" }, latest: { type: "string" }, version: { type: "string" }, "feed-url": { type: "string" }, "min-safe-version": { type: "string" } },
  });
  if (values.deb === undefined && values.rpm === undefined) throw new Error("name at least one package: --deb or --rpm");
  if (values.latest !== undefined && (values.deb === undefined || values.rpm === undefined)) throw new Error("--latest lists both packages, so it needs --deb and --rpm, whose digests it must hold");
  const { version, "feed-url": feedUrl, "min-safe-version": minSafeVersion } = values;
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("--version is required, as x.y.z");
  if (feedUrl === undefined) throw new Error("--feed-url is required");
  const problem = feedUrlProblem(feedUrl, true);
  if (problem !== undefined) throw new Error(problem);
  if (minSafeVersion !== undefined) {
    const safeProblem = minSafeVersionProblem(minSafeVersion, version);
    if (safeProblem !== undefined) throw new Error(safeProblem);
  }
  return { version, feedUrl, ...(minSafeVersion !== undefined && { minSafeVersion }), ...(values.deb !== undefined && { deb: values.deb }), ...(values.rpm !== undefined && { rpm: values.rpm }), ...(values.latest !== undefined && { latest: values.latest }) };
}

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
      "min-safe-version": { type: "string" },
      unsigned: { type: "boolean" },
      signed: { type: "boolean" },
      team: { type: "string" },
      "dir-build": { type: "boolean" },
      "allow-gatekeeper-off": { type: "boolean" },
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
  // The URL the build used: a loopback one is only ever built for a trial on one machine.
  const problem = feedUrlProblem(feedUrl, true);
  if (problem !== undefined) throw new Error(problem);
  const minSafeVersion = values["min-safe-version"];
  if (minSafeVersion !== undefined) {
    const safeProblem = minSafeVersionProblem(minSafeVersion, version);
    if (safeProblem !== undefined) throw new Error(safeProblem);
  }
  if (values.latest !== undefined && values.zip === undefined) throw new Error("--latest needs --zip, whose digest it must hold");
  return {
    app,
    version,
    feedUrl,
    ...(minSafeVersion !== undefined && { minSafeVersion }),
    mode: values.signed === true && team !== undefined ? { kind: "signed", team } : { kind: "unsigned" },
    ...(values.zip !== undefined && { zip: values.zip }),
    ...(values.dmg !== undefined && { dmg: values.dmg }),
    ...(values.latest !== undefined && { latest: values.latest }),
    ...(values["dir-build"] === true && { dirBuild: true }),
    ...(values["allow-gatekeeper-off"] === true && { allowGatekeeperOff: true }),
  };
}

function finish(report: Report, passed: string): void {
  if (report.failures.length > 0) {
    process.stderr.write(`verify-package: ${report.failures.length} check(s) failed:\n${report.failures.map((failure) => `  ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`verify-package: all checks passed (${passed})\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const linux = argv.includes("--linux");
  if (process.platform !== (linux ? "linux" : "darwin")) {
    process.stderr.write(`verify-package: ${linux ? "the Linux packages" : "macOS packages"} can only be verified on ${linux ? "Linux" : "macOS"}.\n`);
    process.exit(1);
  }
  let options: VerifyOptions | LinuxVerifyOptions;
  try {
    options = linux ? parseLinuxVerifyArgs(argv) : parseVerifyArgs(argv);
  } catch (error) {
    process.stderr.write(`verify-package: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const report = new Report();
  if ("mode" in options) {
    await report.check("app exists", () => (statSync(options.app).isDirectory() ? undefined : `${options.app} is not a folder`));
    if (report.failures.length === 0) {
      await checkApp(report, options.app, options, "app");
      if (options.zip !== undefined) await checkZip(report, options, options.zip);
      if (options.dmg !== undefined) await checkDmg(report, options, options.dmg);
    }
    finish(report, options.mode.kind);
    return;
  }
  if (options.deb !== undefined) await checkPackage(report, options, "deb", options.deb);
  if (options.rpm !== undefined) await checkPackage(report, options, "rpm", options.rpm);
  if (options.latest !== undefined && options.deb !== undefined && options.rpm !== undefined) await checkLatest(report, options, options.latest, options.deb, options.rpm);
  finish(report, "linux");
}

if (import.meta.main) await main();
