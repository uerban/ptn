export function AppErrorFallback({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        An unexpected error occurred. Your data is safe.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Reload
        </button>
      )}
    </div>
  );
}
