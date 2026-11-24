// The About view: what this build is, the product site, and the licences. The licence text is the
// repo's THIRD_PARTY_NOTICES.md, imported as text, so there is one source. Shown as plain text.
import { brand } from "../brand/index.js";
import notices from "../../../THIRD_PARTY_NOTICES.md?raw";

const TEXT = {
  heading: "About",
  version: "Version",
  licence: "Tokama is open source under the Apache License 2.0.",
  site: "tokama.dev",
  licences: "Third-party licences",
  back: "Back to work",
} as const;

/** The product site. The window opens this one address in the system browser; no other link is followed. */
export const WEBSITE_URL = "https://tokama.dev";

export interface AboutProps {
  readonly version: string;
  readonly onClose: () => void;
}

export function About({ version, onClose }: AboutProps) {
  return (
    <main className="main about" aria-label={TEXT.heading}>
      <header className="main-header">
        <h1>{TEXT.heading}</h1>
        <button type="button" className="about-back" onClick={onClose}>
          {TEXT.back}
        </button>
      </header>
      <div className="about-body">
        <div className="about-id">
          <img src={brand.markUrl} alt="" width={40} height={40} />
          <div>
            <p className="about-name">{brand.name}</p>
            <p className="about-version">
              {TEXT.version} <span className="mono">{version}</span>
            </p>
          </div>
        </div>
        <p className="about-text">{TEXT.licence}</p>
        <p className="about-text">
          <a href={WEBSITE_URL} target="_blank" rel="noreferrer noopener" className="about-link">
            {TEXT.site}
          </a>
        </p>
        <h2 className="about-heading">{TEXT.licences}</h2>
        <pre className="about-notices">{notices}</pre>
      </div>
    </main>
  );
}
