import { Component, type ReactNode } from "react";

type Props = {
  /** The procedural stand-in to keep when the model layer fails. */
  fallback: ReactNode;
  children: ReactNode;
};

type State = {
  failed: boolean;
};

/** A 404 or a meshopt decode error must leave the old placeholder, never a blank office. */
export class ModelBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
