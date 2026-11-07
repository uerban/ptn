import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { SetupShell, type SetupShellProps } from "./SetupShell.tsx";

/**
 * Render the setup shell into `#root` and resolve once setup is done. The
 * shell's root is unmounted before resolving, so the app can mount its own.
 */
export function showSetupShell(props: Omit<SetupShellProps, "onDone">): Promise<void> {
  const container = document.getElementById("root")!;
  container.replaceChildren();
  const root = createRoot(container);
  return new Promise<void>((resolve) => {
    const onDone = () => {
      // Leave the current render and effects before unmounting.
      setTimeout(() => {
        root.unmount();
        resolve();
      }, 0);
    };
    root.render(
      <StrictMode>
        <I18nProvider>
          <SetupShell {...props} onDone={onDone} />
        </I18nProvider>
      </StrictMode>,
    );
  });
}
