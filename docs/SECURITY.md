# Security model

**Tenancy.** Every row carries `org_id`. Every query a request makes is scoped by the organisation of the person, API key, device, SCIM token or Slack channel that made it, and IDs taken from a request are always checked against that organisation. Teams are checked on write, and joins to teams also match the organisation.

**Who can do what.**
- **Roles.** Roles are viewer, operator, approver, admin and owner. Acting on a session needs its owner, the person it was handed to, an approver on its team, or an admin. Owners alone change single sign-on, SCIM, data handling and other owners.
- **API keys.** A key acts as its maker, with the maker's current role, narrowed to the key's scopes. Scopes are matched on the decoded path.
- **Devices.** A device token speaks only for its person's sessions. Another machine in the same organisation cannot read a session's deliveries, consume its stop request, or post results for it. Viewers cannot enrol machines.

**Secrets.**
- **Stored as hashes, shown once.** Passwords use scrypt. Device tokens, API keys, SCIM tokens, invite tokens and browser sessions are stored as SHA-256 hashes and shown only once.
- **Encrypted at rest.** Webhook URLs, the Slack bot token and signing secret, the PagerDuty key, the OIDC client secret and the SIEM URL and header are encrypted with AES-256-GCM under `SECRET_KEY`. None of them is ever returned by the API; for the SIEM destination, only its host is.

**Browser.**
- Cookies are signed and `SameSite=Strict`, and are `Secure` in production.
- Every mutation needs the `X-Tessera-Client` header and a same-origin `Origin`. Bearer keys are exempt, because browsers do not send them on their own.
- The CSP allows scripts only from the server's own origin, and the frame-ancestors directive is `none`.
- The `Host` header is checked in production, except on `/api/health`.

**Audit.** Every change is appended to a log hash-chained per organisation. Writers for an organisation are serialised with an advisory lock held to commit, so concurrent writers on any number of replicas keep one chain, and ids commit in order for the SIEM stream.

**Reporting a vulnerability.** Open a private security advisory on the repository rather than a public issue.

## Independent review, October 2026

Before general availability, a separate reviewer read the server for tenant isolation, authorisation, injection, secret handling and correctness. Every finding is fixed, with a regression test in `apps/server/src/routes/review.db.test.ts`:

| Finding | Fix |
| --- | --- |
| Any device in an organisation could long-poll another person's session deliveries, consume a pending stop, or forge delivery results | `/decide`, `/sessions/:id/deliveries` and `/deliveries/:id/result` check that the session belongs to the device's person |
| Concurrent audit writes could fork the hash chain; an audit id committing late could be skipped by the SIEM stream | Per-organisation advisory lock held to commit |
| An admin could set a person's team to another organisation's team | Team checked on invite and update; team joins match the organisation |
| The SIEM URL was returned with only some secrets masked, and re-saving the form overwrote it | Only the host is returned; an empty URL keeps the saved one |
| API key scope matched the undecoded path | Decoded before matching |
| `startIndex=Infinity` (SCIM) and impossible dates (analytics) caused 500s | Validated |
| Enrolment codes used `Math.random` | `crypto.randomBytes`, with an alphabet that has no look-alike characters |
| SCIM and the SSO callback said when an email belonged to another organisation | Generic refusals |
