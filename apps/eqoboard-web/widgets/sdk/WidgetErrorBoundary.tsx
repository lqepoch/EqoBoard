"use client";

import React from "react";
import type { ReactNode } from "react";
import { widgetErrorMessage } from "./errors";
import type { WidgetRuntimeError } from "./contracts";

export type WidgetErrorBoundaryProps = Readonly<{
  children: ReactNode;
  title: string;
  onError?(error: WidgetRuntimeError): void;
}>;

type State = Readonly<{ failed: boolean; attempt: number }>;

/** Contains render failures to one widget instance and exposes a local retry. */
export class WidgetErrorBoundary extends React.Component<WidgetErrorBoundaryProps, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Rendering failures are distinct from host data/action errors; raw details never escape.
    try {
      this.props.onError?.({ code: "render-failed", retryable: false });
    } catch {
      // A reporting hook cannot break this widget's error boundary.
    }
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section role="alert" aria-label={`${this.props.title} unavailable`}>
          <p>{widgetErrorMessage({ code: "render-failed", retryable: false })}</p>
          <button type="button" onClick={this.retry}>Retry</button>
        </section>
      );
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

