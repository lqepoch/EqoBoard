import type { ReactNode } from "react";
import { getResourceStateLabel } from "./resource-state";
import type { ResourceStateKind } from "./resource-state";

export { getResourceStateLabel } from "./resource-state";
export type { ResourceStateKind } from "./resource-state";

export type ResourceStateProps = Readonly<{
  state: ResourceStateKind;
  title: string;
  detail?: ReactNode;
  metadata?: ReactNode;
  live?: boolean;
}>;

/** Displays a source-provided resource state. It never infers readiness from visual styling. */
export function ResourceState({ state, title, detail, metadata, live = false }: ResourceStateProps) {
  const label = getResourceStateLabel(state);

  return (
    <div
      aria-atomic={live || undefined}
      aria-label={`${title}: ${label}`}
      aria-live={live ? "polite" : undefined}
      className="eq-resource-state"
      data-state={state}
      role={live ? "status" : "group"}
    >
      <span aria-hidden="true" className="eq-resource-state__marker" />
      <div className="eq-resource-state__body">
        <div className="eq-resource-state__heading">
          <span className="eq-resource-state__title">{title}</span>
          <span className="eq-resource-state__status">{label}</span>
        </div>
        {detail ? <div className="eq-resource-state__detail">{detail}</div> : null}
        {metadata ? <div className="eq-resource-state__meta">{metadata}</div> : null}
      </div>
    </div>
  );
}
