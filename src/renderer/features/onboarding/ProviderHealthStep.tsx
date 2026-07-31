import React from "react";
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";
import { ProviderHealthCard } from "./ProviderHealthCard";

export function ProviderHealthStep(props: {
  health: readonly ProviderHealth[];
  onPick(provider: ProviderId): void;
  onRefresh(): void;
}): React.JSX.Element {
  return <section aria-labelledby="provider-health-title">
    <h2 id="provider-health-title">Connect external coding agents</h2>
    <p>Branchestra history and Git results are saved on this Mac.</p>
    <p>When an Agent runs, selected chat, code, diffs, and tool results in its context is sent to the selected Provider.</p>
    <p>Install and sign in with each official CLI outside Branchestra. Branchestra never stores or displays credentials.</p>
    <div>{props.health.map((item) => <ProviderHealthCard key={item.provider} health={item} onPick={props.onPick} />)}</div>
    <button type="button" onClick={props.onRefresh}>Check again</button>
  </section>;
}
