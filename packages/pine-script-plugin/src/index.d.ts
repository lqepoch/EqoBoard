export type PineBar = Readonly<{
  time: number; open: number; high: number; low: number; close: number; volume: number;
}>;
export type PineSourceEvidence = Readonly<{
  provider: string; symbol: string; resolution: string; completeness: string;
  feed?: string; delay?: string;
}>;
export type NormalizedPinePlot = Readonly<{
  id: string; title: string; kind: "line" | "histogram"; pane: "price" | "indicator" | "unknown"; points: readonly Readonly<{time: number;value: number}>[];
}>;
export declare const PINE_LIMITS: Readonly<{sourceBytes:number;bars:number;plots:number;pointsPerPlot:number;titleLength:number}>;
export declare class PinePluginError extends Error { readonly code: string; constructor(code:string,message:string); }
export declare function inspectPineSource(source:string): Readonly<{version:5|6;kind:"indicator";sourceBytes:number}>;
export declare function normalizePineBars(bars:readonly PineBar[]): readonly Readonly<{
  openTime:number;open:number;high:number;low:number;close:number;volume:number;
}>[];
export declare function normalizePinePlots(raw:unknown,bars:readonly Readonly<{openTime:number}>[]):readonly NormalizedPinePlot[];
export interface PineEngine {
  readonly id: string;
  evaluate(args:{source:string;candles:readonly ReturnType<typeof normalizePineBars>[number][];evidence:PineSourceEvidence;version:5|6}):Promise<{plots:unknown}>;
}
export declare function runReadOnlyPineIndicator(args:{
  source:string;bars:readonly PineBar[];evidence:PineSourceEvidence;engine:PineEngine;
}):Promise<Readonly<{
  protocolVersion:1;language:"pine";version:5|6;kind:"indicator";engine:string;
  executionMode:"historical-read-only";source:PineSourceEvidence;barsRead:number;
  plots:readonly NormalizedPinePlot[];orderIntents:readonly never[];alertDeliveries:readonly never[];
}>>;
export declare function createPineTsAdapter(args:{
  PineTS: new (candles:readonly ReturnType<typeof normalizePineBars>[number][]) => {run:(source:string)=>Promise<{plots:unknown}>};
  licenseApproved:boolean;isolatedProcess:boolean;
}):PineEngine;
