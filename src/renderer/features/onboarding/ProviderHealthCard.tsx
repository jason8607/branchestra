import React from "react";
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";

export function ProviderHealthCard(props: { health: ProviderHealth; onPick(provider: ProviderId): void }): React.JSX.Element {
  const name = props.health.provider === "claude" ? "Claude" : "Codex";
  return <section aria-label={`${name} health`}>
    <h3>{name}</h3>
    <p>{props.health.authLabel}</p>
    <dl>
      <dt>CLI</dt><dd>{props.health.executableRealpath ?? "Not found"}</dd>
      <dt>Version</dt><dd>{props.health.cliVersion ?? "Unavailable"}</dd>
      <dt>Status</dt><dd>{props.health.state.replaceAll("_", " ")}</dd>
    </dl>
    {props.health.repairAction ? <p role="status">{props.health.repairAction}</p> : null}
    <button type="button" onClick={() => props.onPick(props.health.provider)}>Choose {name} CLI</button>
  </section>;
}
