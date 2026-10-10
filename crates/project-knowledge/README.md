# Reviewed project knowledge core

This crate prepares a proposed edit from one selected private memory. It has no app command or automatic trigger. The caller must load the selected record from Sail's private memory store by ID and derive repository write access from a trusted source; neither value may come from a browser request alone.

The caller supplies the destination and proposed text explicitly. Preview reads an existing tracked root instruction file or `docs/*.md`, returns the original memory and source session, and shows the exact replacement diff without writing. Rejecting a preview only discards it. Acceptance checks write access, `HEAD`, the destination path, and the original bytes again, then leaves one unstaged local change. A normal signed commit and pull request review must follow before the change is shared.

Issue #584 connects this boundary to the memory UI after the current settings and context changes land. Until then, this crate is exercised by its isolated behavior tests and is not exposed in Sail.
