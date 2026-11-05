import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [updating, setUpdating] = useState(false);

  if (!needRefresh) return null;

  async function handleUpdate() {
    setUpdating(true);
    try {
      await updateServiceWorker(true);
    } catch (err) {
      console.warn("Service worker update failed:", err);
      setUpdating(false);
    }
  }

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-4 right-4 z-50 flex items-center justify-between rounded-lg bg-blue-600 px-4 py-3 text-sm text-white shadow-lg sm:left-auto sm:right-4 sm:w-80"
    >
      <span>New version available</span>
      <button
        onClick={handleUpdate}
        disabled={updating}
        className="ml-3 rounded bg-white px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-60"
      >
        {updating ? "Updating\u2026" : "Update"}
      </button>
    </div>
  );
}
