// A command to run in a terminal, in mono, with a Copy button that says "✓ Copied" for two seconds.
// The command is text the app wrote (never run by Tokama); the button copies it as it shows.
import { CopyButton, toClipboard } from "./CopyButton.js";
import { CopyIcon } from "./icons.js";

export function CommandCopy({ command }: { readonly command: string }) {
  return (
    <span className="command-copy">
      <code className="mono command-copy-text">{command}</code>
      <CopyButton variant="plain" className="command-copy-button" icon={<CopyIcon />} ariaLabel={`Copy ${command}`} copy={toClipboard(command)} />
    </span>
  );
}
