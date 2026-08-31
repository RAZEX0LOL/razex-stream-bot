# Security policy

## Supported versions

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting feature on the repository's **Security** tab and include:

- the affected file or endpoint;
- a minimal reproduction;
- expected and actual behavior;
- the potential impact;
- a suggested mitigation, if available.

Do not include real access tokens, customer data, or credentials in the report.

## Operational guidance

- Store Twitch tokens in `.env` with mode `0600` or in a secret manager.
- Run the bot as an unprivileged user.
- Do not expose local demo or administration endpoints directly to the internet.
- Rotate a credential immediately if it is ever committed, even if the commit is later removed.
