import { expect, test } from "bun:test";
// Exercise the installed SDK's visited-route action replay, rather than a copy.
import { shouldPreventRemove } from "expo-router/build/react-navigation/core/useOnPreventRemove";
import { createFormExitController } from "./form-exit-controller";
import type { FormExitState } from "./form-guard";

type Action = Parameters<typeof shouldPreventRemove>[4];
type Emitter = Parameters<typeof shouldPreventRemove>[0];

function navigationFixture(initial: FormExitState) {
  let state = initial;
  let routes = [{ key: "browse" }, { key: "manage" }];
  let removals = 0;
  let interceptions = 0;
  let blocked = 0;
  const confirmations: { discard: () => void; cancel: () => void }[] = [];
  const actions: Action[] = [];
  const interceptedActions: Action[] = [];
  const controller = createFormExitController(() => state, {
    blocked: () => blocked++,
    confirm: (discard, cancel) => confirmations.push({ discard, cancel }),
  });
  // This SDK helper only consumes emitter.emit; other event types are not used.
  const emitter = {
    emit(event: { data: { action: Action } }) {
      interceptions++;
      interceptedActions.push(event.data.action);
      controller.beforeRemove(() => dispatch(event.data.action));
      return { ...event, defaultPrevented: true };
    },
  } as unknown as Emitter;
  const childListeners: Parameters<typeof shouldPreventRemove>[1] = {};
  function dispatch(action: Action) {
    actions.push(action);
    const next = [{ key: "browse" }];
    if (!shouldPreventRemove(emitter, childListeners, routes, next, action)) {
      routes = next;
      removals++;
    }
  }
  return {
    controller,
    dispatch,
    confirmations,
    actions,
    interceptedActions,
    childListeners,
    update: (next: Partial<FormExitState>) => {
      state = { ...state, ...next };
    },
    counts: () => ({ removals, interceptions, blocked }),
  };
}

const dirty = { pending: false, dirty: true, revision: 1 };

test("close, continue editing, close, discard replays the SDK action exactly once with interception still enabled", () => {
  const fixture = navigationFixture(dirty);
  fixture.dispatch({ type: "POP" });
  fixture.confirmations[0]!.cancel();
  expect(fixture.counts()).toEqual({ removals: 0, interceptions: 1, blocked: 0 });
  fixture.dispatch({ type: "POP" });
  const confirmation = fixture.confirmations[1]!;
  confirmation.discard();
  expect(fixture.counts()).toEqual({ removals: 1, interceptions: 2, blocked: 0 });
  expect(fixture.actions).toHaveLength(3);
  expect(fixture.actions[2]).toBe(fixture.interceptedActions[1]);
  // The SDK added a private symbol to this replay; spreading only known action
  // fields would lose it and re-enter the guard, prompting a second time.
  expect(Object.getOwnPropertySymbols(fixture.actions[2]!)).toHaveLength(1);
  expect(fixture.confirmations).toHaveLength(2);
  confirmation.discard();
  expect(fixture.counts().removals).toBe(1);
});

test("clean save/replace uses the same intercepted replay without confirmation", () => {
  const fixture = navigationFixture({ ...dirty, dirty: false });
  const action = { type: "REPLACE", payload: { name: "db/new-id" } };
  fixture.dispatch(action);
  expect(fixture.counts()).toEqual({ removals: 1, interceptions: 1, blocked: 0 });
  expect(fixture.actions[1]).toMatchObject(action);
  expect(fixture.confirmations).toHaveLength(0);
});

test("toolbar and system back cannot leave while saving, including a save begun during confirmation", () => {
  const fixture = navigationFixture({ ...dirty, pending: true });
  fixture.dispatch({ type: "POP" });
  fixture.dispatch({ type: "GO_BACK" });
  expect(fixture.counts().blocked).toBe(2);
  fixture.update({ pending: false });
  fixture.dispatch({ type: "POP" });
  fixture.update({ pending: true });
  fixture.confirmations[0]!.discard();
  expect(fixture.counts()).toEqual({ removals: 0, interceptions: 3, blocked: 3 });
});

test("newer input requires another confirmation and superseded/cancelled dialogs cannot navigate", () => {
  const fixture = navigationFixture(dirty);
  fixture.dispatch({ type: "POP" });
  fixture.update({ revision: 2 });
  fixture.confirmations[0]!.discard();
  // Even a delayed dismissal callback from an older dialog cannot cancel the
  // fresh prompt created by the revision check.
  fixture.confirmations[0]!.cancel();
  expect(fixture.confirmations).toHaveLength(2);
  expect(fixture.counts().removals).toBe(0);
  fixture.dispatch({ type: "GO_BACK" });
  fixture.confirmations[1]!.discard();
  expect(fixture.counts().removals).toBe(0);
  fixture.confirmations[2]!.cancel();
  fixture.confirmations[2]!.discard();
  expect(fixture.counts().removals).toBe(0);
  fixture.dispatch({ type: "POP" });
  fixture.confirmations[3]!.discard();
  expect(fixture.counts().removals).toBe(1);
});

test("unmount invalidates an open dialog, including an effect cleanup/setup replay", () => {
  const fixture = navigationFixture(dirty);
  fixture.dispatch({ type: "POP" });
  fixture.controller.deactivate();
  fixture.confirmations[0]!.discard();
  const replacement = navigationFixture(dirty);
  fixture.confirmations[0]!.discard();
  expect(fixture.counts().removals).toBe(0);
  replacement.dispatch({ type: "POP" });
  replacement.confirmations[0]!.discard();
  expect(replacement.counts().removals).toBe(1);
});

test("replay preserves SDK child-beforeRemove semantics for an already visited route", () => {
  const fixture = navigationFixture(dirty);
  let childChecks = 0;
  fixture.childListeners.manage = () => {
    childChecks++;
    return childChecks > 1;
  };
  fixture.dispatch({ type: "POP" });
  fixture.confirmations[0]!.discard();
  // The SDK visited marker skips both this route and its already-checked child.
  expect(childChecks).toBe(1);
  expect(fixture.counts().removals).toBe(1);
});

test("stale dismissal of an old alert cannot cancel a new draft revision prompt", () => {
  const fixture = navigationFixture(dirty);
  fixture.dispatch({ type: "POP" });
  fixture.update({ revision: 2 });
  fixture.confirmations[0]!.discard();
  fixture.confirmations[0]!.cancel();
  expect(fixture.counts().removals).toBe(0);
  fixture.confirmations[1]!.discard();
  expect(fixture.counts().removals).toBe(1);
});
