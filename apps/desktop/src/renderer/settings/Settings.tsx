// Settings, its own space: a settings nav takes the place of the rail and the sidebar, with Back,
// then the settings pages by group. Pages that are not built yet are listed but marked
// aria-disabled. List-type pages fill the two panes to the right of the nav.
import type { Setup } from "@tokama/core";
import { useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { TemplatesPage } from "../templates/TemplatesPage.js";
import { AgentsPage } from "./AgentsPage.js";
import { AiClisPage } from "./AiClisPage.js";

const TEXT = { nav: "Settings", back: "← Back", title: "Settings", later: "comes later" } as const;

export type SettingsPage = "templates" | "agents" | "ai-clis";

const GROUPS: readonly { readonly name: string; readonly pages: readonly { readonly id: SettingsPage | undefined; readonly label: string }[] }[] = [
  { name: "Personal", pages: [{ id: undefined, label: "Notifications" }, { id: undefined, label: "Usage" }] },
  {
    name: "Setup",
    pages: [
      { id: undefined, label: "Repos" },
      { id: undefined, label: "Connections" },
      { id: "templates", label: "Templates" },
      { id: "agents", label: "Agents" },
      { id: undefined, label: "Privacy" },
    ],
  },
  { name: "Engine", pages: [{ id: "ai-clis", label: "AI CLIs" }, { id: undefined, label: "Local models" }, { id: undefined, label: "Git & worktrees" }, { id: undefined, label: "Run limits" }] },
];

export interface SettingsProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly setup: Setup | undefined;
  readonly onBack: () => void;
  /** The page Settings opens on. Default: Agents. */
  readonly initialPage?: SettingsPage;
}

export function Settings({ bridge, connection, setup, onBack, initialPage = "agents" }: SettingsProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={TEXT.nav}>
        <button type="button" className="settings-back" onClick={onBack}>
          {TEXT.back}
        </button>
        <p className="settings-title">{TEXT.title}</p>
        {GROUPS.map((group) => (
          <div key={group.name} className="settings-group" role="group" aria-label={group.name}>
            <span className="settings-group-name" aria-hidden="true">
              {group.name}
            </span>
            {group.pages.map(({ id, label }) =>
              id === undefined ? (
                <button key={label} type="button" className="settings-entry" aria-disabled="true" title={`${label} ${TEXT.later}`}>
                  {label}
                </button>
              ) : (
                <button key={label} type="button" className="settings-entry" aria-current={id === page ? "page" : undefined} onClick={() => setPage(id)}>
                  {label}
                </button>
              ),
            )}
          </div>
        ))}
      </nav>
      {page === "templates" ? (
        <TemplatesPage bridge={bridge} connection={connection} agents={setup?.agents ?? []} connections={setup?.connections ?? []} />
      ) : page === "ai-clis" ? (
        <AiClisPage bridge={bridge} connection={connection} setup={setup} />
      ) : (
        <AgentsPage bridge={bridge} connection={connection} setup={setup} />
      )}
    </div>
  );
}
