// A small modal for the repo dialogs: the native <dialog> shown with showModal(), so focus stays
// inside it and the page behind is inert. Escape closes it through `onClose`, and is marked
// handled so the drawer's own Escape does not also close the drawer. Focus goes back to what had
// it before, when that is still on the page.
import { type ReactNode, useLayoutEffect, useRef } from "react";

export interface ModalProps {
  /** The id of the element that names the dialog (its heading). */
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Modal({ labelledBy, onClose, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element !== null && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      // Another way the browser cancels a dialog; React decides when it closes.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

/** A refusal or failure: a symbol and words, never colour alone. */
export function Problem({ text, alert = false }: { readonly text: string; readonly alert?: boolean }) {
  return (
    <p className="repo-problem" role={alert ? "alert" : undefined}>
      <span aria-hidden="true">✕ </span>
      {text}
    </p>
  );
}
