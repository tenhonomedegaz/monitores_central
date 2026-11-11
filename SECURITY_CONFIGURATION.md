# Security and local configuration

**Warning (11 Nov 2026):** Real service tokens and business identifiers were committed to this public repository in the past. The current branch no longer tracks `.env`, `sales_cache.json`, `products_cache.json`, or `sync_status.json`. This does **not** remove older revisions, clones, forks, release installers or invalidate credentials.

## Immediate incident response
1. Notify the owner/administrator of every affected API account. Rotate/revoke the `CENTRAL_TOKEN`, all account-specific `TOKEN_*` credentials and the `GEMINI_TOKEN`, and check the respective provider logs for unauthorized use. Do not rely on removing a file from GitHub to secure a token.
2. Check whether the removed caches contain customer, order, payment, staff, or company data. Consult the responsible data controller about incident response and notification requirements.
3. Inspect release installers/artifacts and previously distributed packages: prior `electron-builder` configuration bundled `.env` and caches. Rebuild and replace releases only after safe credential provisioning is designed.
4. Coordinate **Git history rewriting** with every collaborator before using `git filter-repo` or another history-cleanup mechanism. Back up local work safely, rotate credentials first, rewrite exposed files from *all* branches/tags, force-push with coordination, and ensure colleagues discard old clones. GitHub support may need to help purge retained references/caches. Old clones may remain compromised.
5. Re-scan the full repository and history for other credentials and personal data. This pass only removed known root files from the current branch; it does not certify the entire repository clean.

## Local development
Copy `.env.example` to `.env` on your own computer and supply fresh values. The Python backend currently reads a `.env` in `MONITOR_APP_DIR` (with legacy fallback paths). The repository intentionally does not distribute one.

**Packaging limitation:** the code still needs a secure, documented way to provision runtime credentials outside the application bundle. The installer no longer includes `.env` or caches, so deploying the current package without provisioning can disable authenticated integrations. Do not solve this by reinstating shared tokens in a public desktop package. Prefer a server-side gateway with user-scoped authentication; a desktop binary cannot reliably hide an embedded long-lived shared API token.

## Data
`sales_cache.json`, `products_cache.json` and `sync_status.json` are local/generated operational files and should not be part of the public source snapshot. Existing local copies should be protected by filesystem access controls and organization data-handling policies. Use synthetic fixtures for tests and public demos.

## Additional risks to fix before release
- `server.py` currently disables TLS warnings and sets empty `CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE`. Review outbound TLS verification before production use.
- Document the least-privilege permissions of each external integration, authentication/authorization of local endpoints, and safe failure behavior when a token is missing.
- Run tests after the packaging/configuration changes. No installer build or end-to-end test was executed as part of this repository hygiene change.
