# ZeroAd: Native Cloudflare Worker AdBlocker

ZeroAd is a high-performance, serverless adblocker designed to run natively on **Cloudflare Workers (Free Tier)**. It automatically synchronizes popular ad-blocking and tracking protection lists with your **Cloudflare Zero Trust Gateway**.

## Features

- **Native Worker Implementation**: No external servers, GitHub Actions, or local scripts required for daily operation.
- **Dynamic Configuration UI**: Manage source list URLs and Cron schedules directly from the browser (KV & Cloudflare API-backed).
- **Stateful Processing**: Uses a Cron-driven State Machine (Workers KV) to bypass the 10ms CPU and 50-subrequest limits of the Cloudflare Free Plan.
- **Smart Updates (ETag/Last-Modified)**: Uses HTTP header checks to detect source list changes, skipping unnecessary processing and saving API/KV units.
- **Streaming Interface**: Includes a `/stream` endpoint for real-time progress monitoring and manual synchronization.
- **Multiple List Support**: Supports AdGuard and uBlock Origin syntax (`||domain^`, `@@||domain^`, etc.) with full whitelisting and prioritization.
- **Large Capacity**: Manages up to 90,000 domains (90 Gateway lists of 1,000 items each).

## Screenshots

### Control Center Dashboard
![Dashboard](docs/images/Dashboard.PNG)

### Dynamic Settings
![Settings](docs/images/Settings.PNG)

## Access Control & Security

Since this worker provides a web-based dashboard and settings page that can modify your Cloudflare account configuration, it is **highly recommended** to protect it:

1.  **Cloudflare Access**: Create a **Zero Trust Application** (Self-hosted) for your worker's domain.
2.  **Restrict Access**: Use an email or identity-based policy to ensure that only you can visit the dashboard, settings, and `/stream` endpoints.
3.  **No Auth by Default**: The worker itself does not implement authentication logic to keep the code lightweight and offload security to the Cloudflare edge.

## Inspiration & Thanks

This project was inspired by and built upon the logic and research of the following excellent projects:

- [cloudflare-zero-trust-adblock](https://github.com/cjscrofani/cloudflare-zero-trust-adblock) by cjscrofani
- [cloudflare-gateway-pihole-scripts](https://github.com/mrrfv/cloudflare-gateway-pihole-scripts) by mrrfv
- [update-cloudflare-gateway-adblock](https://github.com/unixfy/update-cloudflare-gateway-adblock) by unixfy
- [CloudflareGatewayAdBlock](https://github.com/IanDesuyo/CloudflareGatewayAdBlock) by IanDesuyo
- [Alex Wang's Blog Post](https://blog.alexwang.net/cloudflare-zero-trust-gateway-as-an-adblocker/)

## How It Works

ZeroAd breaks the synchronization process into five distinct phases across multiple Cron executions:

1.  **IDLE**: Checks if 24 hours have passed or if headers changed.
2.  **DOWNLOADING**: Fetches and parses configured lists (defaulting to **uBO-et** and **OISD Small**). Applies whitelisting, removes IPs, and deduplicates.
3.  **UPDATING_LISTS**: Iteratively updates Cloudflare Gateway lists (5 per run).
4.  **UPDATING_POLICY**: Synchronizes the Gateway DNS policy with the current list IDs.
5.  **CLEANING_UP**: Automatically deletes any legacy Gateway lists from previous runs that are no longer needed (e.g., if the total domain count decreased).

### Cron Flow & State Machine

Since the Cloudflare Workers Free Plan has a **10ms CPU limit** and a **50-subrequest limit** per invocation, ZeroAd uses a **State Machine** backed by **Workers KV** to handle large blocklists:

-   **Persistence**: The current status, processed domain list, and sync progress are stored in KV.
-   **Batching**: Instead of updating all 90 lists at once (which would exceed the subrequest limit), the worker updates **5 lists per 5-minute cron run**.
-   **Smart Skip (ETags)**: Before starting a sync, the worker performs a lightweight `HEAD` request to check if the source lists have actually changed. If not, it skips the entire cycle, saving KV writes and API units.
-   **Concurrency Protection (Heartbeat)**: To prevent the Cron trigger and a manual Dashboard sync from interfering with each other, the worker maintains a `last_heartbeat` in KV. If an active sync is detected within the last 2 minutes, the cron run is skipped.
-   **Auto-Resumption**: If a worker execution is terminated by the platform, the state remains in KV. The next cron or dashboard load will automatically pick up from the last successful chunk.

## Detailed Setup Guide

To protect your privacy, `wrangler.toml` is excluded from Git. Follow these steps to initialize your local environment:

### 1. Initialize Configuration
Copy the template configuration file:
```bash
cp wrangler.toml.example wrangler.toml
```

### 2. Get your Cloudflare Account ID
Find your Account ID by running:
```bash
npx wrangler whoami
```
Copy the ID from the output and paste it into `wrangler.toml` for both the top-level `account_id` and the `CLOUDFLARE_ACCOUNT_ID` variable.

### 3. Create the KV Namespace
Create the persistent storage for the worker:
```bash
npx wrangler kv:namespace create ADBLOCK_KV
```
Copy the `id` from the output (e.g., `f8b49529...`) and paste it into the `[[kv_namespaces]]` section of your `wrangler.toml`.

### 4. Create an API Token
Go to [My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens) and create a **Custom Token** with these permissions:
- **Account** > **Zero Trust** > **Edit**
- **Account** > **Account Settings** > **Read**
- **Account** > **Workers Scripts** > **Edit** (For dynamic Cron management)

### 5. Set Secrets & Deploy
Add your token to the worker's secure storage and deploy:
```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
# Paste your token when prompted

npm install
npx wrangler deploy
```

## Usage

- **Status**: Visit the root URL `/` of your worker.
- **Stream/Manual Sync**: Visit `/stream` in your browser to see real-time progress.
- **Force Update**: Add `?force=true` to any request to bypass the Smart Skip header checks.
- **Reset**: Visit `/reset` to return the worker to its initial `IDLE` state.

## Potential Next Steps

- **HTTPS/Path-based Blocking**: Leverage Cloudflare Gateway's **TLS Inspection** to block ads by specific URL paths (e.g., `/js/ads.js`) rather than just whole domains.
    - *Requirements*: Installation of the Cloudflare Root Certificate on client devices and enabling TLS decryption in the dashboard.
    - *Implementation*: Extend the parser to extract path-based rules and sync them to `URL` type Gateway lists.
- **Advanced uBlock Origin Syntax**: Support more complex filters like regex-based blocking (where supported by Cloudflare) and more granular rule types.
- **Custom Allowlist Management**: Create a dedicated KV-backed interface or dashboard for managing personal whitelists without editing the source code.

## License

This project is licensed under the **GNU Affero General Public License v3 (AGPL v3)**. See the [LICENSE](LICENSE) file for the full license text.

## Did this save your day?

[![Wanna say thanks?](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.me/lepikj)
