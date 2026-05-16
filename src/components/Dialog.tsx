import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "dialog-title" : undefined}
    >
      <div
        className="card w-[560px] max-w-full p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
        {title && (
          <div className="mb-4">
            <h2 id="dialog-title" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <p className="text-sm text-zinc-400 mt-1">{description}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
