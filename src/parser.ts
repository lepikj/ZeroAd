/**
 * ZeroAd: Blocklist Parser logic
 */

import { FetchResult } from "./api";

/**
 * Fetches and parses the configured blocklists.
 * Uses HEAD requests to check ETags/Last-Modified headers first.
 */
export async function fetchAdBlockList(
  urls: string[],
  currentMetadata: Record<string, string> = {},
): Promise<FetchResult> {
  const newMetadata: Record<string, string> = {};
  let anyChanged = false;

  // Step 1: Check Headers (ETag/Last-Modified) using HEAD requests
  console.log("Checking source headers for changes...");
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      const etag =
        response.headers.get("etag") ||
        response.headers.get("last-modified") ||
        "unknown";
      newMetadata[url] = etag;

      if (currentMetadata[url] !== etag) {
        anyChanged = true;
      }
    } catch (e) {
      console.warn(`Failed to fetch headers for ${url}, forcing update.`);
      anyChanged = true;
    }
  }

  // If nothing changed and the URL list is the same length, we can skip
  if (!anyChanged && Object.keys(currentMetadata).length === urls.length) {
    return { updated: false };
  }

  // Step 2: Something changed, fetch and parse everything
  const blocked = new Set<string>();
  const allowed = new Set<string>();

  for (const url of urls) {
    console.log(`Fetching and parsing: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`Failed to fetch ${url}: ${response.statusText}`);
        continue;
      }

      const text = await response.text();
      const lines = text.split("\n");

      for (let line of lines) {
        line = line.trim();
        if (
          !line ||
          line.startsWith("!") ||
          line.startsWith("#") ||
          line.startsWith("[") ||
          line.startsWith("!#")
        ) {
          continue;
        }

        // Skip cosmetic filters and complex uBO syntax
        if (
          line.includes("##") ||
          line.includes("#@#") ||
          line.includes("#$#") ||
          line.includes("#?#")
        ) {
          continue;
        }

        let domain = "";
        let isAllowed = false;

        if (line.startsWith("@@||")) {
          isAllowed = true;
          domain = line.substring(4);
        } else if (line.startsWith("||")) {
          domain = line.substring(2);
        } else if (
          line.startsWith("0.0.0.0 ") ||
          line.startsWith("127.0.0.1 ")
        ) {
          domain = line.split(/\s+/)[1];
        } else if (
          /^[a-zA-Z0-9]/.test(line) &&
          !line.includes("/") &&
          !line.includes(" ")
        ) {
          // Pure domain name line
          domain = line;
        }

        if (domain) {
          // Clean up domain
          const optionsIndex = domain.indexOf("$");
          if (optionsIndex !== -1) domain = domain.substring(0, optionsIndex);

          if (domain.endsWith("^")) {
            domain = domain.substring(0, domain.length - 1);
          }

          // Remove trailing dots
          while (domain.endsWith(".")) {
            domain = domain.substring(0, domain.length - 1);
          }

          domain = domain.toLowerCase().trim();

          // Final validation
          // 1. MUST NOT be an IP address or partial IP
          const isAllNumAndDots = /^[0-9.]+$/.test(domain);
          const isValidIPv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(domain);

          // 2. Basic domain structure
          const labels = domain.split(".");
          const hasInvalidLabel = labels.some(
            (l) =>
              l.length === 0 ||
              l.length > 63 ||
              !/^[a-z0-9-]/.test(l) ||
              !/[a-z0-9]$/.test(l),
          );

          if (
            domain &&
            !domain.includes("/") &&
            !domain.includes("*") &&
            !hasInvalidLabel
          ) {
            if (isAllNumAndDots && !isValidIPv4) {
              // Skip partial IPs
            } else if (isValidIPv4) {
              // Skip full IPs
            } else {
              if (isAllowed) {
                allowed.add(domain);
              } else {
                blocked.add(domain);
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.error(`Error processing ${url}: ${e.message}`);
    }
  }

  return {
    updated: true,
    blocked,
    allowed,
    metadata: newMetadata,
  };
}
