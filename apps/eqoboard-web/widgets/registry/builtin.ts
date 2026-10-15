import { chartWidgetRegistration } from "../implementations/charts/registration";
import { marketWidgetRegistrations } from "../implementations/market/registry";
import { researchWidgetRegistrations } from "../research/registrations";
import { portfolioWidgetRegistration } from "../../features/portfolio/registration";
import { createWidgetRegistry } from "./create";
import type { AnyWidgetRegistration } from "./types";

/**
 * The only V1 renderer catalog. All modules are statically compiled imports;
 * manifest strings never resolve code or select an arbitrary module path.
 */
const registrations: readonly AnyWidgetRegistration[] = [
  ...marketWidgetRegistrations,
  chartWidgetRegistration,
  ...researchWidgetRegistrations,
  portfolioWidgetRegistration,
];

export const builtinWidgetRegistry = createWidgetRegistry(registrations);

