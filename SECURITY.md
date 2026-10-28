# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately
through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. If that isn't available to you, email
team@modelriver.com.

Include what you found, how to reproduce it, and the version or commit you
tested. We'll reply to confirm we received it and keep you updated until it's
fixed. Please give us a reasonable time to release a fix before you disclose
it.

## Supported versions

Security fixes go into the latest release on the `main` branch. Run the
current release and keep its dependencies installed from the committed
lockfile (`npm ci`).

## Scope

In scope: this repository's code, including the chat widget, help center,
dashboard, connectors and deploy scripts.

Out of scope: vulnerabilities in ModelRiver itself (report those to
team@modelriver.com), in third-party services you connect, or in a
deployment's own configuration.
