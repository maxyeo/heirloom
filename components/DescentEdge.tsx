"use client";

import {
  BaseEdge,
  Position,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

import { DESCENT_STUB } from "@/lib/tree-layout";

/**
 * The line from a union marker down to one of its children.
 *
 * ## Why this exists rather than `smoothstep`
 *
 * React Flow's own stepped edge bends halfway between its two ends. Every
 * union on a rank has the same halfway, so every sibship on a rank was drawn
 * at one height, and two whose horizontal runs overlapped merged into a
 * single unbroken line with a drop under each child — a picture that says all
 * of those parents are the parents of all of those children. `getSmoothStepPath`
 * takes an absolute `centerY` and `SmoothStepEdge` does not pass one, so the
 * height a bar is drawn at can only be chosen from here.
 *
 * Which height each union gets is `descentBarLevels` in `lib/tree-layout.ts`,
 * where the family is known and this component's props are not. All that
 * arrives here is the answer, on `data.barY`, in the same flow coordinates as
 * `sourceY` and `targetY`.
 *
 * ## Without a height
 *
 * A union whose descent is a single vertical drop is given none, because a
 * line with no horizontal run cannot be mistaken for anybody else's. Leaving
 * `centerY` undefined is what `getSmoothStepPath` already means by "bend in
 * the middle", so those edges are drawn exactly as they were.
 *
 * `offset` is {@link DESCENT_STUB} rather than the default 20 for the same
 * reason it is that value in the layout: it is the straight run before the
 * path turns, and a bar nearer the marker than the offset is drawn by
 * overshooting past it and coming back. It cancels out of the midpoint
 * `getSmoothStepPath` falls back to, so an edge with no `barY` is drawn
 * exactly where `smoothstep` drew it.
 *
 * ## Everything else is passed through
 *
 * The label, the markers and the id are forwarded rather than dropped, which
 * is the whole difference between this and the four lines it takes to draw
 * one path. `lib/tree-layout.ts` sets none of them on a child link today, so
 * nothing would look wrong if they were left out — and that is exactly the
 * problem: an arrowhead added to the adopted-child edge later would vanish
 * here with no error anywhere, because `EdgeProps` still declares every one
 * of these. Mirroring React Flow's own `SmoothStepEdge` costs a line each.
 */
export function DescentEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition = Position.Bottom,
  targetX,
  targetY,
  targetPosition = Position.Top,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  markerStart,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<Edge<{ barY?: number }>>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    centerY: data?.barY,
    offset: DESCENT_STUB,
  });

  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      markerStart={markerStart}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
    />
  );
}
