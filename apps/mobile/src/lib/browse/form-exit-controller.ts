import {
  createFormExitGuard,
  type ExitDecision,
  type FormExitState,
} from "./form-guard";

type ExitPrompts = {
  blocked: () => void;
  confirm: (discard: () => void, cancel: () => void) => void;
};

/** Only receives a replay of the exact action intercepted by beforeRemove. */
export function createFormExitController(
  read: () => FormExitState,
  prompts: ExitPrompts,
) {
  const guard = createFormExitGuard(read);
  let active = true;
  let request = 0;
  let dialog = 0;
  const consume = (decision: ExitDecision, token: number): void => {
    if (!active || token !== request) return;
    if (decision.kind === "blocked") prompts.blocked();
    else if (decision.kind === "confirm") {
      const shown = ++dialog;
      prompts.confirm(
        () => {
          if (!active || token !== request || shown !== dialog) return;
          // Invalidate this dialog before a newer revision can create another
          // prompt, so a stale dismissal callback cannot cancel the new one.
          dialog++;
          consume(decision.confirm(), token);
        },
        () => {
          if (token === request && shown === dialog) request++;
        },
      );
    } else if (decision.kind === "ready") {
      // Recheck pending writes and draft revision immediately before replay.
      consume(guard.commit(), token);
    }
  };
  return {
    beforeRemove(replay: () => void) {
      if (!active) return;
      const token = ++request;
      consume(
        guard.request(() => {
          if (!active || token !== request) return;
          request++;
          replay();
        }),
        token,
      );
    },
    deactivate() {
      active = false;
      request++;
    },
  };
}
