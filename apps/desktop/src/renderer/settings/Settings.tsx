// Settings, its own space: a settings nav takes the place of the rail and the sidebar, with Back,
// then the settings pages by group. Only pages that work are listed; a page that is not built yet
// stays in ENTRIES with `shown: false`. To bring it back, add its SettingsPage member and render
// branch, then give the entry that `id` and `shown: true`. List-type pages fill the two panes to
// the right of the nav.
import type { Setup } from "@tokama/core";
import { useState, type ComponentType } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { AgentIcon, BellIcon, BookIcon, PulseIcon, TemplateListIcon, TerminalIcon } from "../ui/icons.js";
import { TemplatesPage } from "../templates/TemplatesPage.js";
import { AgentsPage } from "./AgentsPage.js";
import type { AgentTarget } from "./describe.js";
import { AiClisPage } from "./AiClisPage.js";
import { DiagnosticsPage } from "./DiagnosticsPage.js";
import { NotificationsPage } from "./NotificationsPage.js";
import { ReposPage } from "./ReposPage.js";

type NavIcon = ComponentType;

const TEXT = { nav: "Settings", back: "← Back", title: "Settings" } as const;

export type SettingsPage = "notifications" | "repos" | "templates" | "agents" | "ai-clis" | "diagnostics";

type Entry = { readonly group: string; readonly label: string } & (
  | { readonly shown: true; readonly id: SettingsPage; readonly icon: NavIcon }
  /** A page that is not built yet: it has no page id. */
  | { readonly shown: false; readonly id?: undefined }
);

const ENTRIES: readonly Entry[] = [
  { group: "Personal", label: "Notifications", id: "notifications", icon: BellIcon, shown: true },
  { group: "Personal", label: "Diagnostics", id: "diagnostics", icon: PulseIcon, shown: true },
  { group: "Setup", label: "Repos", id: "repos", icon: BookIcon, shown: true },
  { group: "Setup", label: "Connections", shown: false },
  { group: "Setup", label: "Templates", id: "templates", icon: TemplateListIcon, shown: true },
  { group: "Setup", label: "Agents", id: "agents", icon: AgentIcon, shown: true },
  { group: "Setup", label: "Privacy", shown: false },
  { group: "Engine", label: "AI CLIs", id: "ai-clis", icon: TerminalIcon, shown: true },
  { group: "Engine", label: "Local models", shown: false },
  { group: "Engine", label: "Git & worktrees", shown: false },
  { group: "Engine", label: "Run limits", shown: false },
];

/** The groups with their listed pages; a group with no listed page is left out. */
const shownGroups = (): readonly { readonly name: string; readonly pages: readonly { readonly id: SettingsPage; readonly label: string; readonly Icon: NavIcon }[] }[] => {
  const groups = new Map<string, { id: SettingsPage; label: string; Icon: NavIcon }[]>();
  for (const entry of ENTRIES) {
    if (!entry.shown) continue;
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), { id: entry.id, label: entry.label, Icon: entry.icon }]);
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
            {group.pages.map(({ id, label, Icon }) => (
              <button key={id} type="button" className="settings-entry" aria-current={id === page ? "page" : undefined} onClick={() => setPage(id)}>
                <Icon />
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {page === "notifications" ? (
        <NotificationsPage bridge={bridge} />
      ) : page === "repos" ? (
        <ReposPage bridge={bridge} connection={connection} setup={setup} />
      ) : page === "templates" ? (
        <TemplatesPage bridge={bridge} connection={connection} agents={setup?.agents ?? []} connections={setup?.connections ?? []} />
      ) : page === "ai-clis" ? (
        <AiClisPage bridge={bridge} connection={connection} setup={setup} />
      ) : page === "diagnostics" ? (
        <DiagnosticsPage bridge={bridge} connection={connection} />
      ) : (
        <AgentsPage bridge={bridge} connection={connection} setup={setup} initialAgent={initialAgent} />
      )}
    </div>
  );
}
