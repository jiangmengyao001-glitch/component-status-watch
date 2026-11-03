# Component status watcher

Generic, read-only Xingtu component-status monitor. This repository contains no account IDs, component inventories, chat destinations, credentials or live business data.

Runs a bounded query, validates every page and total count, confirms anomalies with another complete read, and sends messages through the official Feishu intelligent CLI as a bot. Failed reads are monitoring faults, never interpreted as mass component removal. The notification channel is supplied privately and currently used for testing.

Runtime secrets: WATCH_CONFIG_JSON (two captured authenticated read requests and baseline IDs), LARK_APP_ID, LARK_APP_SECRET, NOTIFICATION_CHAT_ID, STATE_KEY (base64 AES-256 key). Credentials are never committed. State stored on the monitor-state branch is AES-256-GCM authenticated ciphertext only.

Run tests with `node --test watcher.test.mjs`. A validation run reads real data and sends one explicit test receipt. Scheduled checks are best effort; GitHub may delay or skip scheduled runs. A separate scheduled watchdog detects stale receipts when the scheduler is operational, but cannot detect a platform-wide GitHub outage in real time. Sessions can expire and require renewed authentication.

Standard GitHub-hosted runners in public repositories are free. No paid runner, artifact upload or cache storage is used. Free service does not guarantee second-level detection or uninterrupted availability.
