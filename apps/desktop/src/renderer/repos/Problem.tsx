import { StatusMark } from "../ui/status.js";

/** A refusal or failure: a symbol and words, never colour alone. */
export function Problem({ text, alert = false }: { readonly text: string; readonly alert?: boolean }) {
  return (
    <p className="repo-problem" role={alert ? "alert" : undefined}>
      <StatusMark status="failed" />{" "}
      {text}
    </p>
  );
}
