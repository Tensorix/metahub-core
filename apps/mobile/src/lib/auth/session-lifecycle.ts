/** A replacement is prepared offline before it becomes the active workspace. */
export interface ManagedSession {
  activate(): void;
  dispose(): Promise<void>;
}

/** Never publish an intermediate signed-out state between two valid sessions. */
export async function replaceSession<T extends ManagedSession>(options: {
  current: { current: T | null };
  prepare(): Promise<T | null>;
  valid(): boolean;
  publish(session: T | null): void;
  onCleanupError(error: unknown): void;
}): Promise<boolean> {
  const next = await options.prepare();
  if (!options.valid()) {
    await next?.dispose();
    return false;
  }
  const previous = options.current.current;
  // Invalidate old callbacks before notifying React or starting the new transport.
  options.current.current = next;
  options.publish(next);
  try {
    next?.activate();
  } catch (error) {
    // A transport startup failure must not close a usable local workspace.
    options.onCleanupError(error);
  }
  try {
    await previous?.dispose();
  } catch (error) {
    options.onCleanupError(error);
  }
  // Disposal may await network cancellation; do not authorize later credential writes after unmount.
  return options.valid();
}

export interface SessionIdentity {
  id: number;
  workspaceId: string;
}

/** Completed connections reset history; hydration preserves incoming deep links. */
export function shouldResetSessionNavigation(
  previous: SessionIdentity | null | undefined,
  next: SessionIdentity | null,
  route: string | undefined,
): boolean {
  // The first hydrated session may be opening a deep link.
  if (previous === undefined || !next || previous?.id === next.id) return false;
  // Onboarding may sit above the public connect route. Protected removes only
  // onboarding, leaving that route's retired workspace wrapper blank.
  if (previous === null) return true;
  if (route === "add-server" || route === "connect") return true;
  return previous !== null && previous.workspaceId !== next.workspaceId;
}

interface NavigationTree {
  key?: string;
  index?: number;
  routeNames?: readonly string[];
  routes: readonly { name: string; state?: NavigationTree }[];
}

/** SDK 57 wraps the app Stack in an internal navigator; target the app's key. */
export function findWorkspaceStack(
  root: NavigationTree | undefined,
): (NavigationTree & { key: string }) | undefined {
  let state = root;
  while (state) {
    if (state.key && state.routeNames?.includes("(tabs)")) {
      return state as NavigationTree & { key: string };
    }
    state = state.routes[state.index ?? 0]?.state;
  }
  return undefined;
}
