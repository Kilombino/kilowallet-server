# Kilowallet server

Kilowallet, the Bitcoin BLAKE2b (XBT) wallet, for a home node: the same wallet code as the
[Android app](https://github.com/Kilombino/kilowallet) (a submodule), with a web app made for the
phone, that reads the chain straight from your own node — no Electrum server.

- **One person, one node.** The node gets a *watch-only* descriptor wallet (the account key only,
  no private keys), which tracks history, the mempool and balances, pruned node included.
- **The keys never enter the node.** A hot wallet's words are encrypted on disk with your password
  (PBKDF2 600 000 rounds + AES-256-GCM) and asked for again before each send. Every input is signed
  with the unified sighash (0x21), so a spend can't be replayed on the SHA-256 chain.
- **Watch-only wallets send through a PSBT**, checked on the way back like in the app.
- Several recipients in one send, coin control, RBF, CPFP, a second confirmation for a fee that looks like a slip, contacts,
  street mode, USD/EUR prices (optional).
- **Coinjoin** (beta, opt-in): the app's COINJOIN tab, in the same pools as the app and
  [Kilojoin](https://github.com/Kilombino/kilojoin) (relay.kilombino.com, the app's own protocol
  code). Open a pool from whole coins with no change (or of an amount you type) or join one, pay up to five
  recipients from SEND through a new pool (a payment pool, Kilojoin v5, when the amounts differ), ask to close, accept or refuse, sign after the server
  checks your output, change and fee; coins in a live round are left out of sends, and mixed coins
  are flagged so they are not spent together with others. Alerts through your own Telegram bot,
  a sound in the browser, StartOS notifications, and an optional sign-on-its-own. Native SegWit
  (bc1q) hot wallets only.
- **Ark** (beta, opt-in): the app's ARK tab, through the Paperclip Ark server
  (ark.paperclippool.xyz), with the same words as the wallet. Receive to an Ark address, a
  Lightning invoice or a reusable BOLT12 offer, or on-chain to a deposit that you MOVE INTO ARK;
  send to Ark, Lightning or an XBT address with the exact cost shown first; renew, coin control,
  emergency exit; alerts (StartOS notifications and Telegram) for payments, renewals and coins
  close to expiry. Hot wallets only.

Packaged for StartOS in [kilowallet-startos](https://github.com/Kilombino/kilowallet-startos).

## Run it

```
./gradlew fatJar
KILOWALLET_DATA=./data KILOWALLET_PORT=8080 \
BITCOIN_RPC_URL=http://127.0.0.1:8332/ BITCOIN_RPC_USER=… BITCOIN_RPC_PASS=… \
java -jar build/libs/kilowallet-server.jar
```

The node needs its wallet feature (not `disablewallet=1`).

On mainnet the server first checks that the node follows the BLAKE2b chain, at start and every
minute: from block 961,640 the BLAKE2b chain's headers are 164 bytes and the SHA-256 chain's are
still 80, so it reads the raw header of the node's best block (or, while it syncs, of its best
header). A node on the SHA-256 chain, a node stopped on the last block before the fork (a Knots
version without BLAKE2b) or one still syncing below it gets a page that says so and nothing else:
no watch-only wallet is created or loaded, nothing is scanned or sent. Tests on regtest or testnet
(`KILOWALLET_NETWORK` other than `blake2b`) skip it.

### Ark

The engine is the app's own: the Paperclip/bark wallet (Rust), as its own process
`kilombino-arkd`, from [Kilombino/paperclip-wallet-app](https://github.com/Kilombino/paperclip-wallet-app)
(branch `kilombino-esplora`, crate `kilombino-ark`). `scripts/build-ark.sh` builds it for amd64 and
arm64 into `ark-bin/` (not in git), where the Dockerfile takes it; outside a container point
`KILOWALLET_ARKD` at the binary. The server starts it on 127.0.0.1 with a random port and bearer
token, hands it the words over a pipe (never to disk) once the wallet is unlocked, and keeps it
running after a lock so it renews coins; after a restart it waits for the next unlock. Its data is
`$KILOWALLET_DATA/ark` (keep it in your backups: it is what the emergency exit needs).
Chain data comes from the node over RPC (needs `txindex=1` and a synced node), or from
mempool.kilombino.com's Esplora API if you choose so when activating.
