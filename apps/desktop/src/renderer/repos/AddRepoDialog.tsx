// "+ Add repo", after the folder picker: the engine's suggestions for the folder (id, base branch,
// checks) as editable fields, then Add. The engine checks every field again and answers a refusal
// in plain words, shown here. Engine text is rendered as React text only.
import type { SuggestRepoResult } from "@tokama/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Modal, Problem } from "./Modal.js";

const TEXT = {
  title: "Add repo",
  reading: "Reading the folder…",
  id: "Id",
  idHint: "How Tokama names the repo: lowercase letters, digits and hyphens.",
  baseBranch: "Base branch",
  baseBranchHint: "Work branches start from it.",
  checks: "Checks",
  checksHint: "One command per line, run in the repo to check each change. No &&, | or redirects.",
  add: "Add repo",
  adding: "Adding…",
  cancel: "Cancel",
  failed: (message: string) => `Could not add it: ${message}`,
} as const;

export interface AddRepoDialogProps {
  readonly bridge: TokamaBridge;
  /** The folder the picker returned. */
  readonly path: string;
  readonly onClose: () => void;
}

type Loaded = { readonly ok: true; readonly suggestion: SuggestRepoResult } | { readonly ok: false; readonly message: string };

export function AddRepoDialog({ bridge, path, onClose }: AddRepoDialogProps) {
  const titleId = useId();
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [id, setId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [checks, setChecks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void bridge
      .query({ type: "suggest_repo", path })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }))
      .then((reply) => {
        if (!live) return;
        if (!reply.ok) return setLoaded({ ok: false, message: reply.error.message });
        setLoaded({ ok: true, suggestion: reply.data });
        setId(reply.data.id ?? "");
        setBaseBranch(reply.data.branch ?? "");
        setChecks(reply.data.checks.join("\n"));
      });
    return () => {
      live = false;
    };
  }, [bridge, path]);

  const suggestion = loaded?.ok ? loaded.suggestion : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (suggestion === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    const lines = checks.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const reply = await bridge
      .command({
        type: "add_repo",
        path: suggestion.path,
        ...(id.trim() === "" ? {} : { id: id.trim() }),
        ...(baseBranch.trim() === "" ? {} : { baseBranch: baseBranch.trim() }),
        checks: lines,
      })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    setBusy(false);
    if (reply.ok) onClose();
    else setError(TEXT.failed(reply.error.message));
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <form className="repo-form" onSubmit={(event) => void submit(event)}>
        <h2 id={titleId} className="modal-title">
          {TEXT.title}
        </h2>
        <p className="repo-path mono">{suggestion?.path ?? path}</p>
        {loaded === undefined && <p role="status">{TEXT.reading}</p>}
        {loaded?.ok === false && <Problem text={loaded.message} />}
        {suggestion?.problem != null && <Problem text={suggestion.problem} />}
        {suggestion !== undefined && suggestion.problem === null && (
          <>
            <Field label={TEXT.id} hint={TEXT.idHint}>
              {(props) => <input {...props} className="mono" value={id} onChange={(event) => setId(event.target.value)} autoFocus spellCheck={false} autoComplete="off" />}
            </Field>
            <Field label={TEXT.baseBranch} hint={TEXT.baseBranchHint}>
              {(props) => <input {...props} className="mono" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} spellCheck={false} autoComplete="off" />}
            </Field>
            <Field label={TEXT.checks} hint={TEXT.checksHint}>
              {(props) => <textarea {...props} className="mono" rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} spellCheck={false} />}
            </Field>
          </>
        )}
        {error !== undefined && <Problem text={error} alert />}
        <div className="choices">
          <button type="submit" className="choice primary" disabled={busy || suggestion === undefined || suggestion.problem !== null}>
            {busy ? TEXT.adding : TEXT.add}
          </button>
          <button type="button" className="choice" onClick={onClose}>
            {TEXT.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint: string;
  readonly children: (props: { id: string; "aria-describedby": string }) => React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div className="repo-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": `${id}-hint` })}
      <span id={`${id}-hint`} className="repo-hint">
        {hint}
      </span>
    </div>
  );
}
