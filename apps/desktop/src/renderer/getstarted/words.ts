// All the text of the Get started checklist. Rows say "this computer" and "a terminal" on every
// system; only the install command for git and the Start key differ by system. Engine messages
// are never put through here: they are shown as they come, as text.

/** The oldest git and Claude Code the engine accepts; the window repeats them in its words, and a test holds the copies to the engine's. */
export const GIT_MIN = "2.38";
export const CLAUDE_CODE_MIN = "2.1.315";

/** Pages on the product site that rows link to; the main process opens only the addresses it lists. */
export const LINKS = {
  installClaudeCode: "https://tokama.dev/docs/install-claude-code",
  installGit: "https://tokama.dev/docs/install-git",
} as const;

export const COMMANDS = {
  login: "claude auth login",
  update: "claude update",
  brewGit: "brew install git",
} as const;

/** The first task Start a Quick fix puts in New work. */
export const SAMPLE_TASK = "Fix typos and unclear sentences in README.md";

export const TITLES = {
  aiCli: "Set up an AI CLI",
  git: `Install git ${GIT_MIN} or newer`,
  repo: "Add your first repo",
  quickFix: "Start a Quick fix",
} as const;

export const WORDS = {
  ready: "Ready",
  added: "Added",
  done: "Done",
  todo: "To do",
  notInstalled: "Not installed",
  loggedOut: "Logged out",
  tooOld: "Too old",
  needsFix: "Needs a fix",
  notFound: "Not found",
  checking: "Checking…",
  couldNotCheck: "Could not check",
} as const;

export const TEXT = {
  heading: "Get started",
  progress: (done: number) => `${done} of 4 done`,
  intro: "Four steps to your first change. The list updates by itself as you go.",
  allDone: "Everything is set up. If a step breaks later, its row shows the fix.",
  checkAgain: "Check again",
  close: "Close",
  list: "Steps",
  copy: "Copy",
  copyLabel: (command: string) => `Copy ${command}`,
  external: "↗",

  cliNone: "Tokama works through an AI CLI, such as Claude Code. None was found on this computer. Install it, log in, then come back: this row updates by itself.",
  cliInstall: "Install Claude Code",
  cliChecking: "Looking for an AI CLI on this computer.",
  cliCouldNot: "Tokama could not look for an AI CLI, because its engine did not answer. Check again. If this stays, quit Tokama and open it again.",
  cliLoggedOut: "is installed but not logged in. Run this in a terminal and follow the login steps:",
  cliTooOld: `is too old. Tokama needs ${CLAUDE_CODE_MIN} or newer. Run this in a terminal:`,
  cliSandbox: "is installed and logged in, but its sandbox cannot run on this computer.",
  cliCannotRun: "is installed and logged in, but Tokama cannot run it yet.",
  cliReady: "is installed and logged in.",
  cliName: "Claude Code",

  gitCouldNot: "Tokama could not look for git, because its engine did not answer. Check again. If this stays, quit Tokama and open it again.",
  gitReady: (version: string) => `git ${version}.`,
  gitNone: "No git was found on this computer.",
  gitFound: (version: string | undefined) => (version === undefined ? "Tokama could not read the version of the git it found." : `Found git ${version}.`),
  gitNeeds: `Tokama needs ${GIT_MIN} or newer.`,
  gitRunMac: "Run this in a terminal, or see",
  gitRunLinux: "Install it with your system’s package manager, or see",
  gitOther: "other ways to install git",
  gitSelfUpdates: "This row updates by itself.",

  repoTodo: "Choose the folder of a git repo you work on. Tokama looks for your test and lint commands, so it can check each change.",
  repoAdd: "Add repo",
  repoNoChecks: "no checks",
  repoChecks: (count: number) => (count === 1 ? "1 check" : `${count} checks`),
  repoMore: (count: number) => `${count} more ${count === 1 ? "repo" : "repos"}`,

  quickLocked: "Try one small change on your repo. Finish the three steps above first.",
  quickReady: "Opens New work with a sample task you can change:",
  quickReadyAfter: "Tokama works on its own branch. At the end you merge, open a PR or discard.",
  quickStart: "Start a Quick fix",
  quickNoChecksBefore: "Quick fix runs your checks after the change, and",
  quickNoChecksAfter: "has none yet. Try Quick change instead: you look at the change and approve it yourself. Or",
  quickNoChecksEnd: "first.",
  quickAddCheck: "add a check",
  quickChange: "Start a Quick change",
  quickFirstRunAfter: "was your first run.",
  quickFirstRun: "Your first work has started.",

  safetyTitle: "Agents stay in their own worktree.",
  safety: "An agent changes files only in its own worktree of your repo, and it cannot read your secret files. Checks are your own commands: they run with your access to files and tools. Before you run a workflow, read its steps and commands in",
  safetyLink: "Settings › Templates",

  line: "Setup done",
  /** `what` is the workflow's name ("Quick fix"), or "work" when the item is not known yet. */
  lineText: (what: string) => `Your first ${what} is running. When it finishes, you choose: merge it, open a PR or discard it. This list is under`,
  lineWork: "work",
  closeLine: "Close",
  lineHelp: "Help › Get started",
} as const;
