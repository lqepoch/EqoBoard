"use client";

import { useEffect, useState } from "react";

import { parseRecapEnvelope, type ResearchRecapData } from "@/features/research/data";
import type { RecapObservation } from "@/lib/server/research/recap";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type { ResearchDataOperationMap } from "@/features/research/data";
import styles from "./research-widgets.module.css";

export type ResearchRecapConfigV1 = Readonly<{ schemaVersion: 1 }>;

type Props = WidgetProps<ResearchRecapConfigV1, ResearchDataOperationMap, WidgetNoActionMap>;
type RecapEnvelope = NonNullable<ReturnType<typeof parseRecapEnvelope>>;
type ViewState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; envelope: RecapEnvelope }>;

function amount(value: number | null, fractionDigits = 2): string {
  return value === null || !Number.isFinite(value)
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: fractionDigits });
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unavailable" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function observationEvidence<T>(observation: RecapObservation<T>): string {
  return `${observation.source ?? "source unknown"} · as of ${observation.asOf ?? "unknown"}`;
}

function EvidenceLine({ observation, value }: { observation: RecapObservation<number>; value: string }) {
  return <small className={styles.recapEvidence}>{value} · {observationEvidence(observation)}</small>;
}

function SymbolButton({ symbol, onSelect }: { symbol: string; onSelect: (symbol: string) => void }) {
  return <button className={styles.recapSymbol} type="button" onClick={() => onSelect(symbol)}>{symbol}</button>;
}

function LeaderTable({
  title,
  rows,
  onSelect,
}: {
  title: string;
  rows: ResearchRecapData["gainers"];
  onSelect: (symbol: string) => void;
}) {
  return (
    <section className={styles.recapPanel}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className={styles.empty}>No priced, timestamped SIP rows met the recap cap filter.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Symbol</th><th scope="col">Company</th><th scope="col">Change</th><th scope="col">Price</th><th scope="col">Market cap metadata</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.symbol}>
                <td><SymbolButton symbol={row.symbol} onSelect={onSelect} /></td>
                <td>{row.name}</td>
                <td><span>{percent(row.changePercent.value)}</span><EvidenceLine observation={row.changePercent} value="Change" /></td>
                <td><span>{amount(row.price.value)}</span><EvidenceLine observation={row.price} value="Price" /></td>
                <td><span>{amount(row.marketCap.value, 0)}</span><EvidenceLine observation={row.marketCap} value="Cap" /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecapContent({ data, onSelect }: { data: ResearchRecapData; onSelect: (symbol: string) => void }) {
  return (
    <>
      <div className={styles.evidence} aria-label="Recap source coverage">
        <span>Market metadata: {data.coverage.marketMetadata.status} · {data.coverage.marketMetadata.sampled}/{data.coverage.marketMetadata.returned} sampled · cap-ranked limit {data.coverage.marketMetadata.sampleLimit}</span>
        <span>{data.coverage.marketMetadata.source ?? "metadata source unavailable"} · as of {data.coverage.marketMetadata.asOf ?? "unknown"}</span>
        <span>Gateway SIP: {data.coverage.sipSnapshots.status} · {data.coverage.sipSnapshots.priced}/{data.coverage.sipSnapshots.marketRequested} market rows priced · {data.coverage.sipSnapshots.timed}/{data.coverage.sipSnapshots.marketRequested} timestamped</span>
        <span>{data.coverage.sipSnapshots.source ?? "Gateway source unknown"} · feed=sip · row timestamps vary</span>
        <span>Macro: {data.coverage.macro.status} · {data.coverage.macro.source ?? "source unavailable"}; headlines: {data.coverage.headlines.status} · {data.coverage.headlines.source ?? "source unavailable"}</span>
        <p>Combined observations are not synchronized. No generated market narrative is shown; absent observations remain unavailable.</p>
      </div>

      <section className={styles.recapPanel}>
        <h3>Market proxies and volatility</h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Instrument</th><th scope="col">Last</th><th scope="col">Change</th><th scope="col">VIX close</th></tr></thead>
            <tbody>
              {data.indexes.map((row, index) => (
                <tr key={row.symbol}>
                  <td><SymbolButton symbol={row.symbol} onSelect={onSelect} /> <span>{row.label}</span></td>
                  <td><span>{amount(row.price.value)}</span><EvidenceLine observation={row.price} value="Price" /></td>
                  <td><span>{percent(row.changePercent.value)}</span><EvidenceLine observation={row.changePercent} value="Change" /></td>
                  {index === 0 ? (
                    <td rowSpan={data.indexes.length}>
                      <span>{amount(data.volatility.vix.value)}</span>
                      <EvidenceLine observation={data.volatility.vix} value="VIX" />
                    </td>
                  ) : null}
                </tr>
              ))}
              {data.indexes.length === 0 ? <tr><td colSpan={4}>Index proxy observations unavailable.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.recapColumns}>
        <LeaderTable title="Top gainers" rows={data.gainers} onSelect={onSelect} />
        <LeaderTable title="Top decliners" rows={data.losers} onSelect={onSelect} />
      </div>

      <section className={styles.recapPanel}>
        <h3>Sector performance · sample-weighted equally</h3>
        {data.sectors.length === 0 ? <p className={styles.empty}>No sector aggregate has timestamped SIP changes.</p> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th scope="col">Sector</th><th scope="col">Average change</th><th scope="col">Rows</th><th scope="col">Source time range</th></tr></thead>
              <tbody>{data.sectors.map((row) => (
                <tr key={row.sector}>
                  <td>{row.sector}</td>
                  <td><span>{percent(row.averageChangePercent.value)}</span><EvidenceLine observation={row.averageChangePercent} value="Derived" /></td>
                  <td>{row.sampleCount}</td>
                  <td>{row.sourceTimeRange.earliest ?? "unknown"} – {row.sourceTimeRange.latest ?? "unknown"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.recapPanel}>
        <h3>Headlines</h3>
        {data.headlines.length === 0 ? <p className={styles.empty}>No headlines were returned.</p> : (
          <ul className={styles.recapHeadlines}>
            {data.headlines.map((item, index) => (
              <li key={`${item.provider}-${item.link}-${index}`}>
                <a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
                <small>{item.provider} · {item.publisher} · published {item.publishedAt ?? "unknown"}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function RecapWidget({ host }: Props) {
  const canRead = host.auth.authenticated && host.auth.permissions.includes("research:read") && host.auth.permissions.includes("market:read");
  const [state, setState] = useState<ViewState>({ status: "idle" });
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!canRead) {
      setState({ status: "idle" });
      return undefined;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return undefined;
    return host.refresh.observe("research.recap", {}, { refreshIntervalMs: 15_000 }, (scheduled) => {
      if (scheduled.status === "pending") {
        setState((current) => current.status === "ready" ? current : { status: "loading" });
        return;
      }
      if (scheduled.status === "error") {
        setState({ status: "error", message: scheduled.code === "rate-limited"
          ? "The recap read is rate limited."
          : "The same-origin recap request failed or was not authorized." });
        return;
      }
      const envelope = parseRecapEnvelope(scheduled.value);
      if (!envelope) {
        setState({ status: "error", message: "The recap response did not match its validated source envelope." });
        return;
      }
      setState({ status: "ready", envelope });
    });
  }, [canRead, host.lifecycle, host.refresh, refreshVersion]);

  const selectSymbol = (symbol: string) => {
    host.events.dispatch({ type: "active-symbol.select.v1", symbol });
  };

  return (
    <section className={styles.widget} aria-label="Market recap" data-testid="research-recap">
      <header className={styles.header}>
        <div><h2>Market recap</h2><p>Read-only observations from the approved research and market sources.</p></div>
        <button type="button" onClick={() => setRefreshVersion((value) => value + 1)} disabled={!canRead || state.status === "loading"}>Refresh</button>
      </header>
      {!canRead ? <p className={styles.empty}>Sign in with both research:read and market:read to load the recap.</p> : null}
      {canRead && state.status === "idle" ? <p className={styles.empty}>Waiting for the authorized recap read.</p> : null}
      {canRead && state.status === "loading" ? <p className={styles.empty} role="status">Loading bounded market recap observations…</p> : null}
      {canRead && state.status === "error" ? <p className={styles.error} role="alert">{state.message}</p> : null}
      {canRead && state.status === "ready" ? (
        <>
          <div className={styles.evidence} aria-label="Recap response evidence">
            <span>{state.envelope.status === "available" ? "Complete source requests" : "Partial source coverage"}</span>
            <span>Retrieved {state.envelope.retrievedAt}</span>
            <span>Combined envelope as of {state.envelope.asOf ?? "not applicable"}</span>
            <span>Failed observations {state.envelope.completeness.failedItems ?? "unknown"}{state.envelope.completeness.truncated ? " · truncated" : ""}</span>
            <span>Source set: {state.envelope.source.provider}</span>
            {state.envelope.warning ? <p>{state.envelope.warning}</p> : null}
          </div>
          <RecapContent data={state.envelope.data} onSelect={selectSymbol} />
        </>
      ) : null}
    </section>
  );
}
