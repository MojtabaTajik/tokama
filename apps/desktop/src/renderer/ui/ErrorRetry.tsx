// A load that failed: ✕ and what could not load, the reason, and Retry. Announced as an alert.
import { Button } from "./Button.js";
import { StatusMark } from "./status.js";

export interface ErrorRetryProps {
  /** What could not load: "Could not load the agents". */
  readonly title: string;
  /** Why, as the engine or the bridge said it. */
  readonly detail?: string | undefined;
  readonly onRetry: () => void;
}

export function ErrorRetry({ title, detail, onRetry }: ErrorRetryProps) {
  return (
    <div className="failure" role="alert">
      <p className="failure-title">
        <StatusMark status="failed" className="symbol" />
        {title}
      </p>
      {detail !== undefined && <p className="detail">{detail}</p>}
      <Button variant="primary" className="retry" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
