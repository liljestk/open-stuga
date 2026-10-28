import { Component, createRef, type ReactNode } from "react";

interface RouteErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  renderFallback: (reload: () => void) => ReactNode;
  onReload: () => void;
}

interface RouteErrorBoundaryState {
  failed: boolean;
}

/** Keeps a rejected lazy route or nested chunk from tearing down the app shell. */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { failed: false };
  private readonly fallbackRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { failed: true };
  }

  override componentDidMount(): void {
    if (this.state.failed) this.fallbackRef.current?.focus();
  }

  override componentDidUpdate(
    previous: RouteErrorBoundaryProps,
    previousState: RouteErrorBoundaryState,
  ): void {
    if (this.state.failed && !previousState.failed) {
      this.fallbackRef.current?.focus();
    }
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div ref={this.fallbackRef} role="alert" aria-atomic="true" tabIndex={-1}>
          {this.props.renderFallback(this.props.onReload)}
        </div>
      );
    }
    return this.props.children;
  }
}
