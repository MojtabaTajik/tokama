// The one line the checklist folds into once the first item starts: it says what happens next and
// where the list went. It stays until the user closes it or the first item ends.
import { CloseButton } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";
import { markOf } from "../ui/status.js";
import { TEXT } from "./words.js";

export interface SetupDoneLineProps {
  /** The workflow of the first item ("Quick fix"), or undefined while it is not known. */
  readonly workflow: string | undefined;
  readonly onClose: () => void;
}

export function SetupDoneLine({ workflow, onClose }: SetupDoneLineProps) {
  return (
    <div className="gs-line-done rise-in" role="status">
      <StatusMark status={markOf("passed")} />
      <b className="gs-line-title">{TEXT.line}</b>
      <span className="gs-line-text">
        {TEXT.lineText(workflow ?? TEXT.lineWork)} <b className="gs-strong">{TEXT.lineHelp}</b>.
      </span>
      <CloseButton size="icon-sm" label={TEXT.closeLine} className="gs-line-close" onClick={onClose} />
    </div>
  );
}
