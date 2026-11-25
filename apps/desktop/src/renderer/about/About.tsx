// The About view: what this build is, the product site, the build facts and the licences. All
// text renders as text. The only link that opens is the product site; the window sends it to the
// system browser and follows no other.
import { useEffect, useRef, useState } from "react";
import type { AboutInfo, ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { buildRows } from "../../shared/build-info.js";
import { brand } from "../brand/index.js";
import { notices as noticesFor } from "./notices.js";

/** The product site. The window opens this one address in the system browser; no other link is followed. */
export const WEBSITE_URL = "https://tokama.dev";
const COPIED_FOR_MS = 2000;

export interface AboutProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState["status"];
  readonly onClose: () => void;
}

export function About({ bridge, connection, onClose }: AboutProps) {
  const [info, setInfo] = useState<AboutInfo | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [folderError, setFolderError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(["fa"]));
  const resetCopy = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    bridge.getAboutInfo().then((next) => live && setInfo(next), () => live && setFailed(true));
    return () => {
      live = false;
      clearTimeout(resetCopy.current);
    };
  }, [bridge]);

  const notices = noticesFor(info?.runtime.electron ?? "unknown");
  const allOpen = notices.every((notice) => open.has(notice.id));
  const toggle = (id: string) => setOpen((now) => {
    const next = new Set(now);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const copyInfo = async () => {
    const done = await bridge.copyBuildInfo().then(() => true, () => false);
    setCopy(done ? "copied" : "failed");
    clearTimeout(resetCopy.current);
    resetCopy.current = setTimeout(() => setCopy("idle"), COPIED_FOR_MS);
  };
  const showFolder = async () => {
    const result = await bridge.showDataFolder().catch(() => ({ ok: false as const, message: "The folder could not be opened." }));
    setFolderError(result.ok ? undefined : result.message);
  };

  return (
    <main className="main about" aria-label="About">
      <header className="main-header">
        <h1>About</h1>
        <button type="button" className="about-back" onClick={onClose}>
          Back to work
        </button>
      </header>
      <div className="about-body">
        <div className="about-column">
          <section className="about-id" aria-label={brand.name}>
            <div className="about-logo">
              <img src={brand.markUrl} alt="" width={56} height={56} />
              <img className="about-wordmark" src={brand.wordmarkUrl} alt={brand.name} height={44} />
            </div>
            <p className="about-aka">
              <span>
                Tokama · say <em>to-KA-ma</em>
              </span>
              <span>Named after the Tokay gecko and the Agama lizard.</span>
            </p>
            <p className="about-version">
              Version <span className="mono">{info?.app.version ?? "…"}</span>
              {info === undefined ? null : (
                <>
                  <span aria-hidden="true" className="about-dot">·</span>
                  <span>{info.platform}</span>
                </>
              )}
            </p>
            <p className="about-lead">Agent workbench for engineers. Tokama runs AI coding agents on your repos, one step at a time, following templates you write. You approve what matters.</p>
            <p className="about-links">
              <a href={WEBSITE_URL} target="_blank" rel="noreferrer noopener" className="about-link">
                tokama.dev<span aria-hidden="true">↗</span>
              </a>
              <span className="about-soft">
                Open source under the <a href="#licence" className="about-licence-link">Apache License 2.0</a>
              </span>
            </p>
          </section>

          <section aria-labelledby="about-build" className="about-section">
            <div className="about-section-head">
              <h2 id="about-build" className="about-heading">Build</h2>
              <button type="button" className="about-action about-copy" disabled={info === undefined} onClick={() => void copyInfo()}>
                {copy === "copied" ? "Copied" : copy === "failed" ? "Could not copy" : "Copy build info"}
              </button>
            </div>
            {info === undefined ? (
              <p className="about-soft">{failed ? "The build info could not be read." : "Reading the build info…"}</p>
            ) : (
              <dl className="about-rows">
                {buildRows(info, connection).map(([label, value]) => (
                  <div key={label} className="about-row">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                    {label === "Data folder" ? (
                      <button type="button" className="about-action" onClick={() => void showFolder()}>
                        {info.platform.startsWith("macOS") ? "Show in Finder" : "Show in file manager"}
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
              </dl>
            )}
            {folderError === undefined ? null : <p role="alert" className="about-error">{folderError}</p>}
          </section>

          <section aria-labelledby="about-notices" className="about-section">
            <div className="about-section-head">
              <h2 id="about-notices" className="about-heading">Third-party notices</h2>
              <span className="about-count">{notices.length}</span>
              <button type="button" className="about-action about-all" onClick={() => setOpen(allOpen ? new Set() : new Set(notices.map((notice) => notice.id)))}>
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            </div>
            <ul className="about-notices">
              {notices.map((notice) => {
                const expanded = open.has(notice.id);
                return (
                  <li key={notice.id} className="about-notice">
                    <button type="button" className="about-notice-head" aria-expanded={expanded} onClick={() => toggle(notice.id)}>
                      <span aria-hidden="true" className="about-chev">{expanded ? "▾" : "▸"}</span>
                      <span className="about-notice-name">
                        <span className="about-notice-title">{notice.name}</span>
                        <span className="about-notice-version">{notice.version}</span>
                        <span className="about-notice-role">{notice.role}</span>
                      </span>
                      <span className="about-notice-licence">{notice.licence}</span>
                    </button>
                    {expanded ? (
                      <div className="about-notice-body">
                        <p>{notice.text}</p>
                        <span className="about-notice-copy">{notice.copyright}</span>
                        <span className="about-notice-site">{notice.site}</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          <section id="licence" aria-label="Licence" className="about-foot">
            <span>Tokama · Apache License 2.0</span>
          </section>
        </div>
      </div>
    </main>
  );
}
