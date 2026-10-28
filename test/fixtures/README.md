# Test-only TLS certificate

`localhost-cert.pem` and `localhost-key.pem` are a self-signed certificate for `localhost` and `127.0.0.1`, used only by `test/safe-http.test.ts` to run a local HTTPS server. They protect nothing; never use them anywhere else.
