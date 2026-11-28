import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import { createLinuxSupport } from "./linux.js";

// Runs the real probes on a Linux machine set up for the sandbox (bubblewrap, socat, user
// namespaces allowed): CI sets TOKAMA_REAL_BWRAP=1 after it installs them. Elsewhere it is skipped.
describe.runIf(process.env["TOKAMA_REAL_BWRAP"] === "1" && process.platform === "linux")("Linux sandbox support on a machine set up for it", () => {
  it("finds bubblewrap able to start the sandbox, with the nested user namespace Claude Code's helper makes", async () => {
    const check = await createLinuxSupport(createProcessRunner()).check(new AbortController().signal);
    expect(check).toEqual({ ok: true });
  });
});
