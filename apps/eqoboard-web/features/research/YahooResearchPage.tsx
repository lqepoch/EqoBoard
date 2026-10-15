"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useWidgetDataClient } from "@/features/data/MarketDataHost";
import { DEFAULT_YFINANCE_RESEARCH_CONFIG, type YfinanceResearchConfigV1 } from "@/features/research/yfinance";
import { TerminalShell } from "@/components/shell/TerminalShell";
import { YfinanceDailyWidget } from "@/widgets/research/YfinanceDailyWidget";
import styles from "@/widgets/research/research-widgets.module.css";
import { createWidgetLifecycleController } from "@/widgets/sdk/lifecycle";
import { projectWidgetAuthorization } from "@/widgets/sdk/auth";

export function YahooResearchPage({ initialSymbol }: Readonly<{ initialSymbol: string }>) {
  const auth = useAuth();
  const data = useWidgetDataClient();
  const lifecycle = useMemo(() => createWidgetLifecycleController(), []);
  const [config, setConfig] = useState<YfinanceResearchConfigV1>(() => Object.freeze({
    ...DEFAULT_YFINANCE_RESEARCH_CONFIG,
    symbol: initialSymbol,
  }));
  const host = useMemo(() => Object.freeze({
    auth: projectWidgetAuthorization(auth),
    data,
    lifecycle,
  }), [auth, data, lifecycle]);

  useEffect(() => () => lifecycle.dispose(), [lifecycle]);
  useEffect(() => {
    setConfig((current) => current.symbol === initialSymbol ? current : { ...current, symbol: initialSymbol });
  }, [initialSymbol]);

  return (
    <TerminalShell>
      <section className={styles.researchPage} data-testid="yahoo-research-page">
        <header className={styles.researchPageHeader}>
          <div>
            <p>Isolated Research runtime</p>
            <h1>Yahoo daily history · {config.symbol}</h1>
            <p>Provider-native observations with explicit source evidence. This chart is display only.</p>
          </div>
        </header>
        <YfinanceDailyWidget
          config={config}
          inputs={{ symbol: initialSymbol }}
          host={host}
          onConfigChange={setConfig}
        />
      </section>
    </TerminalShell>
  );
}
