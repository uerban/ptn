import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { PrivacyRequestField } from "@pt/shared";
import {
  resolveNetworkDecision,
  type CapabilityFlowId,
} from "@pt/shared/privacy";
import { useTranslation, usePrivacyNamespace } from "../../i18n/index.ts";
import {
  usePresentationText,
  type PresentationStringKey,
} from "../../i18n/presentationStrings.ts";
import { findDataFlow } from "../../privacy/dataFlowRegistry.ts";
import {
  answerContextualPrompt,
  type ContextualAnswer,
} from "../../privacy/contextualPrompts.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";

export interface FlowDisclosureProps {
  flowId: CapabilityFlowId;
  providerId?: string;
  /** Names the asking surface, for the session's **Not now** memory. */
  surface: string;
  heading: string;
  /** Label of the Allow action, naming what it turns on. */
  allowLabel: string;
  /** Who receives the requests, for provider flows (the provider's name). */
  recipientName?: string;
  /** Flow-specific consequences: traffic, caching, cadence. */
  details?: ReactNode;
  /** `dialog`: a modal over the page; `inline`: a section in place. */
  variant?: "dialog" | "inline";
  /** Called after the answer has been recorded. */
  onClose: (answer: ContextualAnswer) => void;
}

/**
 * The reusable disclosure behind every contextual network choice. Name,
 * purpose, recipient and request contents come from the data-flow registry,
 * so this, onboarding and Settings describe the same flow the same way.
 *
 * Opened only by a deliberate action, so it takes focus: the prompt itself,
 * never the Allow button, so a stray Enter grants nothing. **Allow** grants
 * exactly this flow (and provider); **Not now** leaves it unset; **Don't ask
 * again** records `denied` and is not offered again once the flow is denied.
 * Escape answers **Not now**: anywhere on the page for the modal dialog,
 * which also keeps Tab inside itself; within the prompt for the inline one.
 */
export function FlowDisclosure({
  flowId,
  providerId,
  surface,
  heading,
  allowLabel,
  recipientName,
  details,
  variant = "dialog",
  onClose,
}: FlowDisclosureProps) {
  const { t } = useTranslation();
  const text = usePresentationText();
  const privacyReady = usePrivacyNamespace();
  const headingId = useId();
  const bodyId = useId();
  const containerRef = useRef<HTMLElement & HTMLDivElement>(null);
  const decision = useNetworkDecisionsStore(
    (s) => resolveNetworkDecision(s.decisions, flowId, providerId).value,
  );
  const flow = findDataFlow(flowId);

  const answer = (value: ContextualAnswer) => {
    answerContextualPrompt(value, flowId, surface, providerId);
    onClose(value);
  };
  const answerRef = useRef(answer);
  useEffect(() => {
    answerRef.current = answer;
  });

  useEffect(() => {
    containerRef.current?.focus();
    if (variant !== "dialog") return;
    // Capture phase on window, so Escape closes this modal prompt and not the
    // sheet or page underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answerRef.current("not-now");
      } else if (e.key === "Tab") {
        keepFocusInside(containerRef.current, e);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [variant]);

  const onInlineKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    answer("not-now");
  };

  const recipient =
    flow?.destination === "operator"
      ? text("flow.recipientOperator")
      : (recipientName ?? providerId ?? "");
  const fields: readonly PrivacyRequestField[] = flow?.requestFields ?? [];

  const body = (
    <>
      <h2 id={headingId} className="text-base font-semibold">
        {heading}
      </h2>
      <div id={bodyId} className="mt-2 space-y-2 text-sm text-fg-secondary">
        {flow && privacyReady ? (
          <p>{t(flow.purposeKey, "")}</p>
        ) : flow ? (
          <p>{text("flow.loading")}</p>
        ) : null}
        {details && <div>{details}</div>}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {text("flow.recipientHeading")}
          </h3>
          <p data-testid="flow-recipient">{recipient}</p>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {text("flow.revealsHeading")}
          </h3>
          <ul className="list-disc pl-5" data-testid="flow-reveals">
            {fields.map((field) => (
              <li key={field}>
                {text(`flow.field.${field}` as PresentationStringKey)}
              </li>
            ))}
            <li>{text("flow.networkAddress")}</li>
          </ul>
        </div>
        <p className="text-xs text-fg-muted">{text("flow.changeLater")}</p>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {decision !== "denied" && (
          <button
            type="button"
            onClick={() => answer("denied")}
            className="min-h-11 px-4 rounded-lg text-sm text-fg-secondary underline-offset-2 hover:underline"
          >
            {text("flow.dontAskAgain")}
          </button>
        )}
        <button
          type="button"
          onClick={() => answer("not-now")}
          className="min-h-11 px-4 rounded-lg border border-divider text-sm"
        >
          {text("flow.notNow")}
        </button>
        <button
          type="button"
          onClick={() => answer("allowed")}
          className="min-h-11 px-4 rounded-lg bg-primary text-white text-sm font-semibold"
        >
          {allowLabel}
        </button>
      </div>
    </>
  );

  if (variant === "inline") {
    return (
      <section
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={onInlineKeyDown}
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        data-testid="flow-disclosure"
        data-flow={flowId}
        className="mx-3 my-2 rounded-lg border border-divider bg-surface-raised p-3 text-fg"
      >
        {body}
      </section>
    );
  }

  // Portalled to the body so no overlay's stacking context can cover it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        data-testid="flow-disclosure"
        data-flow={flowId}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-surface-raised p-4 shadow-2 text-fg"
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Wrap Tab and Shift+Tab around the dialog's own controls. */
function keepFocusInside(container: HTMLElement | null, e: KeyboardEvent): void {
  if (!container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof Node && container.contains(active);
  if (e.shiftKey && (!inside || active === first || active === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}
