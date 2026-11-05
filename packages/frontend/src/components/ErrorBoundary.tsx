import { Component, type ReactNode, type ErrorInfo } from "react";
import { reportError } from "../services/errorReporter.ts";

interface Props {
  fallback: ReactNode | ((props: { reset: () => void }) => ReactNode);
  children: ReactNode;
  /** Optional context label for error reports (e.g., "map", "departures") */
  context?: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, {
      componentStack: info.componentStack ?? undefined,
      context: this.props.context ? { boundary: this.props.context } : undefined,
    });
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback({ reset: this.reset });
      }
      return fallback;
    }
    return this.props.children;
  }
}
