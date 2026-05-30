<!--
  PR titles must follow Conventional Commits (enforced by .github/workflows/pr.yml):
    fix:   -> patch release
    feat:  -> minor release
    chore: -> no changelog entry / no release
  Scope by area when useful, e.g. `feat(resolver): ...`, `fix(analyzer): ...`.
-->

## What

<!-- A short description of the change and why it is needed. Link the issue: Closes #123 -->

## How

<!-- Notable implementation details, trade-offs, or follow-ups. -->

## Compatibility

<!--
  nftrs is a drop-in rewrite of @vercel/nft. If this changes tracing behaviour,
  note the effect on the compat suite (`node compat/run.mjs --check`).
  If the passing count went up, bump compat/baseline.json in this PR.
-->

- Compat fixtures passing before / after:

## Checklist

- [ ] `cargo fmt --all -- --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo test --workspace` passes
- [ ] `vp run build` (TS typecheck) and `vp test --run` pass (if JS/TS touched)
- [ ] `node compat/run.mjs --check` does not regress (baseline bumped if it improved)
- [ ] PR title follows Conventional Commits
