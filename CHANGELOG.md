# Changelog

## 0.1.4

- Make installation through VSCodium's Open VSX interface the primary documented setup path.
- Document the stock VS Code VSIX fallback, automatic updates, and the published Open VSX listing.

## 0.1.3

- Remove synchronization state version 2 from the documented editor prerequisites.

## 0.1.2

- Reload an unchanged active workspace-data editor after Load while preserving edits made during the operation.
- Detect missing GitHub CLI and offer its setup documentation.
- Detect missing or incompatible `gh-workspace-data` capabilities and offer an explicit install-or-upgrade action.
- Determine compatibility from reported capabilities rather than a package-version threshold.
- Check active GitHub CLI authentication before Load and publication and offer authentication setup guidance.

## 0.1.1

- Add theme-aware Explorer `M` and `U` decorations for modified and newly added workspace-data files.
- Add a Source Control toolbar button for **Publish and Merge Owned**.
- Confirm before Load overwrites detected unpublished or unsaved workspace-data changes.
- Document the complete folded usage workflow and overwrite-style Load behavior.

## 0.1.0

- Add public and private Source Control groups backed by `gh workspace-data` inspection protocol version 1.
- Add immutable loaded-baseline diffs, quick diff, refresh, load, publish, and owned-merge commands.
