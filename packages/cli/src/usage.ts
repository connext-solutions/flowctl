/** The CLI usage text, printed by `--help` and after a usage error. */
export const USAGE = `Usage:
  flowctl replay [name...] [--tag <tag>] [--env <env>] [--repeat <n>] [--heal [--accept-heals]] [--json] [--headed] [--trace safe|full] [--video] [--config <path>]
  flowctl login <profile> [--env <env>] [--config <path>]
  flowctl cleanup <run id> [--json] [--config <path>]
                                         remove the records a replay on a shared env created and left (from its
                                         ledger in the trust store); exits 2 while records are left; re-runnable
  flowctl observe [--env <env>] [--profile <profile>] [--start <path>] [--json] [--out <file.json>] [--config <path>]
                                         crawl the app read-only and write its map (appmap.json) into the run
                                         directory, and to --out inside the flows directory (early)
  flowctl trust init [--anchor-dir <abs dir>] [--config <path>]
                                         create this machine's trust store and owner key (interactive); the
                                         store head is also kept in the keychain, or in --anchor-dir without one
  flowctl trust init --replace [--anchor-dir <abs dir>] [--config <path>]
                                         replace this machine's store and owner key with new ones; nothing is
                                         carried over and the old store is kept as <store>.replaced-<date>.<n>
  flowctl trust hook <name...> [--hook-env NAME] [--pin NAME=VALUE] [--config <path>]
                                         review and consent to the flows' setup/teardown hooks (interactive)
  flowctl trust add env <env> [--config <path>]
                                         classify an env added to the config after init (interactive)
  flowctl trust add profile <profile> <NAME> <secret|username> [--config <path>]
                                         allow a flow env input for a profile (interactive)
  flowctl trust add default-env <env> [--config <path>]
  flowctl trust add language <code> [--config <path>]
  flowctl trust add locale <locale> [--config <path>]
                                         change this project's default env, language or locale (interactive)
  flowctl trust add production-origin <origin> [--config <path>]
                                         mark an origin as production (interactive)
  flowctl trust add origin <env> <visit|call> <origin> [--config <path>]
                                         let runs on an env open (visit) or send requests to (call) another
                                         origin, e.g. its API or SSO (interactive)
  flowctl trust add system1 <host:port> <KEY_ENV> <env...> [--config <path>]
                                         allow a System 1 endpoint, its key variable and the envs it may run in
                                         (interactive)
  flowctl trust add project [<name>] [--config <path>]
                                         register this checkout (or record its identity) in the trust store (interactive)
  flowctl trust add destructive <flow> --env <env> --from-run <run id> [--days <n>] [--config <path>]
                                         confirm the writes a flow may send on a shared env, derived from a
                                         passing run of it on a local env; you attest what no recording shows
                                         (interactive)
  flowctl trust add destructive --renew <id>... [--days <n>] [--config <path>]
  flowctl trust add destructive --renew-env <env> [--days <n>] [--config <path>]
                                         give unchanged flows' confirmations a new expiry (and the env's new
                                         origin) (interactive)
  flowctl trust revoke destructive <id> [--config <path>]
                                         remove a stored destructive confirmation and the mutate entries that
                                         depend on it (interactive)
  flowctl trust key rotate-owner [--config <path>]
                                         replace the owner key and re-sign every entry; a rerun finishes or rolls
                                         back a rotation that was interrupted (interactive)

Every command except --help and trust init needs a trust store: run flowctl trust init once per machine.`;
