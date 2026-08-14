import { Component, type ReactNode } from 'react';
import { useStore } from '../store';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  message: string;
}

/**
 * Stage-5 error reporting: a 3D/WebGL failure must never blank the whole app —
 * the boundary recovers the canvas area while market panels keep working, and
 * the incident is surfaced in the event feed (sanitized, no third-party service).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    useStore.getState().pushFeed({
      kind: 'warning',
      text: `Renderer error: ${error instanceof Error ? error.message : String(error)}`,
      ts: Date.now(),
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="stage-error" role="alert">
          <h2>3D view unavailable</h2>
          <p>WebGL or renderer error: {this.state.message}</p>
          <p>Market data panels keep working.</p>
          <button onClick={() => this.setState({ hasError: false, message: '' })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
