# EqoBoard native terminal

This is the native terminal development target authorized on 2026-10-15. It is
not the default production terminal until parity, identity, source, persistence,
performance, container and rollback acceptance pass on the same candidate.

- Preserve `apps/openterminal`, OpenBB sources, patches, tests and license files.
  They remain the comparison baseline; production imports from that application
  or `references/legacy` are forbidden. Adapted source needs a pinned source path,
  provenance record and its original license/NOTICE. Never call it original.
- Use the pinned trading-core package for financial wire contracts. Never make a
  second financial model or use UI floats for exact financial decisions.
- One host owns market transport, resource budgets and subscription lifetimes.
  Widgets consume that host; they never open provider/broker connections.
- UI permissions are visibility hints. Every BFF route verifies the current
  trusted session and required permission. Keep existing service issuer,
  audience, kid, scope and key isolation. Browser bundles contain no secrets.
- Native widgets must not inherit the legacy Pro route's simulated order,
  account, depth or tape fallbacks as real provider capabilities. Missing market
  data remains missing. Paper and Live execution remain disabled.
- Use one static builtin registry. External plugin code cannot execute in V1;
  a manifest's claimed signature or trust flag is not verification.
- Layout imports are bounded, versioned and validated. Ownership comes only
  from verified issuer and subject. Anonymous legacy data requires explicit
  migration and never belongs automatically to the first signed-in user.
- Keep source modules small with meaningful boundaries. Add tests beside each
  implementation and wire them into real Actions before claiming verification.
- Public builds, typecheck, unit/component/API/browser/security/container tests
  run in GitHub Actions. Do not run local builds, dev servers or Docker.
- Shared config, dependencies, Compose, CI, provenance integration and PRs are
  owned by the coordinator; concurrent agents edit only assigned paths.
