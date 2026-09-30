import type { Params } from "../t.ts";

export type Msg = string | ((p: Params) => string);

export const plural = (n: unknown, one: string, other: string): string => (Number(n) === 1 ? one : other);
