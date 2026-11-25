// Settings, its own space: a settings nav takes the place of the rail and the sidebar, with Back,
// then the settings pages by group. Only pages that work are listed; a page that is not built yet
// stays in ENTRIES with `shown: false`. To bring it back, add its SettingsPage member and render
// branch, then give the entry that `id` and `shown: true`. List-type pages fill the two panes to
// the right of the nav.
import type { Setup } from "@tokama/core";
import { useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { TemplatesPage } from "../templates/TemplatesPage.js";
import { AgentsPage } from "./AgentsPage.js";
import type { AgentTarget } from "./describe.js";
import { AiClisPage } from "./AiClisPage.js";

const TEXT = { nav: "Settings", back: "← Back", title: "Settings" } as const;

export type SettingsPage = "templates" | "agents" | "ai-clis";

type Entry = { readonly group: string; readonly label: string } & (
  | { readonly shown: true; readonly id: SettingsPage }
  /** A page that is not built yet: it has no page id. */
  | { readonly shown: false; readonly id?: undefined }
);

const ENTRIES: readonly Entry[] = [
  { group: "Personal", label: "Notifications", shown: false },
  { group: "Setup", label: "Repos", shown: false },
  { group: "Setup", label: "Connections", shown: false },
  { group: "Setup", label: "Templates", id: "templates", shown: true },
  { group: "Setup", label: "Agents", id: "agents", shown: true },
  { group: "Setup", label: "Privacy", shown: false },
  { group: "Engine", label: "AI CLIs", id: "ai-clis", shown: true },
  { group: "Engine", label: "Local models", shown: false },
  { group: "Engine", label: "Git & worktrees", shown: false },
  { group: "Engine", label: "Run limits", shown: false },
];

/** The groups with their listed pages; a group with no listed page is left out. */
const shownGroups = (): readonly { readonly name: string; readonly pages: readonly { readonly id: SettingsPage; readonly label: string }[] }[] => {
  const groups = new Map<string, { id: SettingsPage; label: string }[]>();
  for (const { group, label, id, shown } of ENTRIES) {
    if (!shown) continue;
    groups.set(group, [...(groups.get(group) ?? []), { id, label }]);
  }
  return [...groups].map(([name, pages]) => ({ name, pages }));
};

export interface SettingsProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly setup: Setup | undefined;
  readonly onBack: () => void;
  /** The page Settings opens on. Default: Agents. */
  readonly initialPage?: SettingsPage;
  /** On the Agents page: the agent to select first. */
  readonly initialAgent?: AgentTarget;
}

export function Settings({ bridge, connection, setup, onBack, initialPage = "agents", initialAgent }: SettingsProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={TEXT.nav}>
        <button type="button" className="settings-back" onClick={onBack}>
          {TEXT.back}
        </button>
        <p className="settings-title">{TEXT.title}</p>
        {shownGroups().map((group) => (
          <div key={group.name} className="settings-group" role="group" aria-label={group.name}>
            <span className="settings-group-name" aria-hidden="true">
              {group.name}
            </span>
            {group.pages.map(({ id, label }) => (
              <button key={id} type="button" className="settings-entry" aria-current={id === page ? "page" : undefined} onClick={() => setPage(id)}>
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {page === "templates" ? (
        <TemplatesPage bridge={bridge} connection={connection} agents={setup?.agents ?? []} connections={setup?.connections ?? []} />
      ) : page === "ai-clis" ? (
        <AiClisPage bridge={bridge} connection={connection} setup={setup} />
      ) : (
        <AgentsPage bridge={bridge} connection={connection} setup={setup} initialAgent={initialAgent} />
      )}
    </div>
  );
}
