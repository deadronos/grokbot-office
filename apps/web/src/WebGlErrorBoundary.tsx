import { Component, type ReactNode } from "react";

export const WEBGL_UNAVAILABLE = "WebGL isn't available";

export function WebGlFallback() {
  return <p className="scene-fallback">{WEBGL_UNAVAILABLE}</p>;
}

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

/** Catches a missing/broken WebGL context (or any scene render throw) and shows a short fallback. */
export class WebGlErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(_error: unknown): State {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) return <WebGlFallback />;
    return this.props.children;
  }
}
