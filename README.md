# ZeroAd: Native Cloudflare Worker AdBlocker

ZeroAd is a high-performance, serverless adblocker designed to run natively on **Cloudflare Workers (Free Tier)**. It automatically synchronizes popular ad-blocking and tracking protection lists with your **Cloudflare Zero Trust Gateway**.

## Features

- **Native Worker Implementation**: No external servers, GitHub Actions, or local scripts required for daily operation.
- **Stateful Processing**: Uses a Cron-driven State Machine (Workers KV) to bypass the 10ms CPU and 50-subrequest limits of the Cloudflare Free Plan.
- **Smart Updates (ETag/Last-Modified)**: Uses HTTP header checks to detect source list changes, skipping unnecessary processing and saving API/KV units.
- **Streaming Interface**: Includes a `/stream` endpoint for real-time progress monitoring and manual synchronization.
- **Multiple List Support**: Supports AdGuard and uBlock Origin syntax (`||domain^`, `@@||domain^`, etc.) with full whitelisting and prioritization.
- **Large Capacity**: Manages up to 90,000 domains (90 Gateway lists of 1,000 items each).

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

## Setup

1.  **Configure `wrangler.toml`**: Add your `account_id` and `ADBLOCK_KV` namespace ID.
2.  **API Token**: Create a Cloudflare API Token with `Zero Trust: Edit` and `Account Settings: Read` permissions.
3.  **Secrets**:
    ```bash
    npx wrangler secret put CLOUDFLARE_API_TOKEN
    ```
4.  **Deploy**:
    ```bash
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
