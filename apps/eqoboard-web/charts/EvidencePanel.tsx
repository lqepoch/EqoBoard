import type { ChartDisplayEvidence } from "./types";

export function ChartEvidencePanel({ evidence }: Readonly<{ evidence: ChartDisplayEvidence | null }>) {
  if (!evidence) {
    return (
      <div className="native-chart-evidence" data-testid="native-chart-provenance" aria-live="polite">
        <span>Source evidence unavailable.</span>
      </div>
    );
  }
  const entries = [
    { label: "Source", value: evidence.source },
    { label: "Provider", value: evidence.provider },
    { label: "Feed", value: evidence.feed },
    { label: "As of", value: evidence.asOf },
    { label: "Requested window", value: evidence.requestedWindow },
    { label: "Resolution", value: evidence.effectiveResolution },
    { label: "Coverage", value: evidence.coverage },
    { label: "Completeness", value: evidence.completeness },
    { label: "Precision", value: evidence.precision },
    ...evidence.evidence,
  ];
  return (
    <dl
      className="native-chart-evidence"
      data-testid="native-chart-provenance"
      data-chart-mode={evidence.mode}
      data-chart-completeness={evidence.completeness}
      data-chart-precision={evidence.precision}
    >
      {entries.map(({ label, value }, index) => (
        <div className="native-chart-evidence__entry" key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
