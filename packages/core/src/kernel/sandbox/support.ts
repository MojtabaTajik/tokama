/** Whether this machine can run the AI CLI's sandbox. */
export type SandboxCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** What is wrong, as a plain sentence. */
      readonly problem: string;
      /** What to do about it, when there is something to do. */
      readonly fix?: string;
    };

export interface SandboxSupport {
  /** Never cached by the caller: a tool may be installed between two calls. */
  check(signal: AbortSignal): Promise<SandboxCheck>;
}
