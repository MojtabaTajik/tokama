// The commands that start and stop helpers and Try checks. The real engine answers them with
// `not_implemented` until its runner exists; the sample engine answers them with canned data.
import type { Command } from "@tokama/core";

export type HelperCommand = Extract<Command, { type: "run_helper" | "cancel_helper" | "try_checks" | "cancel_check_trial" }>;

export const isHelperCommand = (command: Command): command is HelperCommand =>
  command.type === "run_helper" || command.type === "cancel_helper" || command.type === "try_checks" || command.type === "cancel_check_trial";
