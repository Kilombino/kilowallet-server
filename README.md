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
- Coin control, RBF, CPFP, a second confirmation for a fee that looks like a slip, contacts,
  street mode, USD/EUR prices (optional).
- **Coinjoin** (beta, opt-in): the app's COINJOIN tab, in the same pools as the app and
  [Kilojoin](https://github.com/Kilombino/kilojoin) (relay.kilombino.com, the app's own protocol
  code). Open or join pools with one coin, ask to close, accept or refuse, sign after the server
  checks your output, change and fee; coins in a live round are left out of sends, and mixed coins
  are flagged so they are not spent together with others. Alerts through your own Telegram bot,
  a sound in the browser, StartOS notifications, and an optional sign-on-its-own. Native SegWit
  (bc1q) hot wallets only.

Packaged for StartOS in [kilowallet-startos](https://github.com/Kilombino/kilowallet-startos).

## Run it

```
./gradlew fatJar
KILOWALLET_DATA=./data KILOWALLET_PORT=8080 \
BITCOIN_RPC_URL=http://127.0.0.1:8332/ BITCOIN_RPC_USER=… BITCOIN_RPC_PASS=… \
java -jar build/libs/kilowallet-server.jar
```

The node needs its wallet feature (not `disablewallet=1`).
