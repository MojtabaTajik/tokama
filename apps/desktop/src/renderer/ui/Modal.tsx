// The app's modal: the native <dialog> shown with showModal(), so focus stays inside it and the
// page behind is inert. Escape closes it through `onClose`, and is marked
// handled so the drawer's own Escape does not also close the drawer. Focus goes back to what had
// it before, when that is still on the page.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { CloseButton } from "./Button.js";

export interface ModalProps {
  /** The id of the element that names the dialog (its heading); or `label`, its name in words. */
  readonly labelledBy?: string | undefined;
  readonly label?: string | undefined;
  readonly onClose: () => void;
  /** The screen's class for the dialog's width and layout. */
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function Modal({ labelledBy, label, onClose, className, children }: ModalProps) {
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
      className={["modal", className].filter(Boolean).join(" ")}
      aria-labelledby={labelledBy}
      aria-label={label}
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

export interface DialogFrameProps {
  /** The id the heading gets, for the dialog's aria-labelledby. */
  readonly titleId: string;
  readonly title: string;
  /** A line under the title, in the mono font, such as the folder. */
  readonly subtitle?: string | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** The buttons, right-aligned in the footer. */
  readonly footer: ReactNode;
}

/** A dialog's layout: a header with the close button, a body and a footer. Close is ✕. */
export function DialogFrame({ titleId, title, subtitle, onClose, children, footer }: DialogFrameProps) {
  return (
    <div className="dlg">
      <div className="dlg-head">
        <div className="dlg-titles">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {subtitle !== undefined && <span className="dlg-sub mono">{subtitle}</span>}
        </div>
        <CloseButton className="dlg-close" onClick={onClose} />
      </div>
      <div className="dlg-body">{children}</div>
      <div className="dlg-foot">{footer}</div>
    </div>
  );
}
