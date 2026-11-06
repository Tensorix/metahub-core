import { addDays, daysBetween, toISO } from "../../../../src/shared/views/date";
export function timelineSpan(
  start: Date,
  end: Date | null,
  from: Date,
  to: Date,
) {
  const last = end && end >= start ? end : start;
  return {
    left: Math.max(0, daysBetween(from, start)),
    days: Math.max(
      1,
      daysBetween(start < from ? from : start, last > to ? to : last) + 1,
    ),
    milestone: !end || last.getTime() === start.getTime(),
  };
}
export function moveDates(
  startId: string,
  start: Date,
  endId: string | undefined,
  end: Date | null,
  delta: number,
) {
  return {
    [startId]: toISO(addDays(start, delta)),
    ...(endId && end
      ? { [endId]: toISO(addDays(end < start ? start : end, delta)) }
      : {}),
  };
}
export function resizeDate(
  start: Date,
  end: Date | null,
  edge: "start" | "end",
  delta: number,
) {
  const last = end && end >= start ? end : start;
  const date = addDays(edge === "start" ? start : last, delta);
  return toISO(
    edge === "start"
      ? date > last
        ? last
        : date
      : date < start
        ? start
        : date,
  );
}
