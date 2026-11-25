// The two screens that stand in for the list: first launch (no repos yet) and a view with no work.
// All text is fixed app text; nothing from the engine is shown here.
import { EmptyState } from "../ui/EmptyState.js";

const TEXT = {
  noRepos: "Add your first repos",
  noReposBefore: "Tokama reads the repos you work on from ",
  noReposAfter: ". Add one entry for each repo, like this:",
  fields: [
    ["id", "the short name Tokama shows"],
    ["path", "the repo folder on this machine"],
    ["base_branch", "the branch new work starts from"],
  ],
  noWork: "No work yet",
  noWorkHint: "Describe a task or paste an alert below. It starts in the template you pick.",
} as const;

/** Where the engine reads the repos from. */
export const REPOS_FILE = "~/.tokama/repos.yaml";

/** A valid `repos.yaml` with one repo, as the engine reads it. */
export const REPOS_EXAMPLE = `format: 1
repos:
  - id: orders-api
    path: ~/code/orders-api
    base_branch: main
`;

export function FirstLaunch() {
  return (
    <EmptyState className="state" title={TEXT.noRepos}>
      <p className="empty-state-text">
        {TEXT.noReposBefore}
        <code className="mono">{REPOS_FILE}</code>
        {TEXT.noReposAfter}
      </p>
      <pre className="state-code mono">{REPOS_EXAMPLE}</pre>
      <dl className="state-fields">
        {TEXT.fields.map(([name, meaning]) => (
          <div key={name}>
            <dt className="mono">{name}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </EmptyState>
  );
}

export function NoWork() {
  return (
    <EmptyState className="state" title={TEXT.noWork} text={TEXT.noWorkHint} />
  );
}
