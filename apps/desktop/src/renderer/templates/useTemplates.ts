// The Templates page's data: the list of template files and the selected one in full. The engine
// reads the files again on every query, so the page asks again when the engine connects, when
// the setup changes, when the window gets focus back (the engineer was in the editor) and when
// asked to.
import type { TemplateDetail, TemplateEntry, TemplateFileKey } from "@tokama/core";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export type Loaded<T> = { readonly state: "loading" } | { readonly state: "ready"; readonly value: T } | { readonly state: "failed"; readonly message: string };

/** A number that goes up each time the files should be read again, and the function that raises it. */
export function useReload(bridge: TokamaBridge): readonly [number, () => void] {
  const [count, setCount] = useState(0);
  const reload = useCallback(() => setCount((value) => value + 1), []);
  useEffect(() => bridge.onEvent((event) => event.event.type === "setup_changed" && reload()), [bridge, reload]);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return [count, reload];
}

const engineIdOf = (connection: ConnectionState): string | undefined => (connection.status === "connected" ? connection.engineId : undefined);

export function useTemplateList(bridge: TokamaBridge, connection: ConnectionState, reload: number): Loaded<readonly TemplateEntry[]> {
  const [list, setList] = useState<Loaded<readonly TemplateEntry[]>>({ state: "loading" });
  const engineId = engineIdOf(connection);
  useEffect(() => {
    if (engineId === undefined) return;
    let live = true;
    void bridge.query({ type: "templates" }).then((reply) => {
      if (!live) return;
      // A failed reload keeps the list it has: the files did not go away.
      if (reply.ok) setList({ state: "ready", value: reply.data.templates });
      else setList((current) => (current.state === "ready" ? current : { state: "failed", message: reply.error.message }));
    });
    return () => {
      live = false;
    };
  }, [bridge, engineId, reload]);
  return list;
}

export function useTemplateDetail(bridge: TokamaBridge, connection: ConnectionState, key: TemplateFileKey | undefined, reload: number): Loaded<TemplateDetail> | undefined {
  const [detail, setDetail] = useState<{ readonly key: string; readonly loaded: Loaded<TemplateDetail> } | undefined>(undefined);
  const engineId = engineIdOf(connection);
  const id = key === undefined ? undefined : keyId(key);
  useEffect(() => {
    if (engineId === undefined || key === undefined || id === undefined) return;
    let live = true;
    void bridge.query({ type: "template_detail", origin: key.origin, file: key.file }).then((reply) => {
      if (!live) return;
      setDetail({ key: id, loaded: reply.ok ? { state: "ready", value: reply.data } : { state: "failed", message: reply.error.message } });
    });
    return () => {
      live = false;
    };
    // `key` is followed through its id, so a new object for the same file does not ask again.
  }, [bridge, engineId, id, reload]);
  if (id === undefined) return undefined;
  return detail?.key === id ? detail.loaded : { state: "loading" };
}

/** One string per file, for React keys and for comparing selections. */
export const keyId = (key: TemplateFileKey): string => `${key.origin}\n${key.file}`;
