// "Open the file" under a cut check output or transcript: the main process opens the saved file
// in the system's app for it. The renderer names the file only by item, step, attempt and check.
import { useState } from "react";
import type { AttemptFileName, TokamaBridge } from "../../shared/bridge.js";
import { Button } from "../ui/Button.js";

const TEXT = {
  open: "Open the file",
  failed: (message: string) => `Could not open it: ${message}`,
} as const;

export function OpenFile({ bridge, name }: { readonly bridge: TokamaBridge; readonly name: AttemptFileName }) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const open = () => {
    setProblem(undefined);
    void bridge
      .openAttemptFile(name)
      .then((result) => setProblem(result.ok ? undefined : result.message))
      .catch((cause: unknown) => setProblem(String(cause)));
  };
  return (
    <>
      <Button variant="plain" className="open-file" onClick={open}>
        {TEXT.open}
      </Button>
      {problem !== undefined && (
        <span className="open-file-problem" role="status">
          <span className="symbol" aria-hidden="true">
            !
          </span>
          {TEXT.failed(problem)}
        </span>
      )}
    </>
  );
}
