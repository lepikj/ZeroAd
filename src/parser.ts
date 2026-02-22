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
  onProgress?: (msg: string, type?: string) => Promise<void>,
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
    if (onProgress) await onProgress(`📡 Fetching: ${url.split("/").pop()}`, "meta");
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ZeroAd/1.0; +https://github.com/lepikj/ZeroAd)",
        },
      });
      
      if (!response.ok) {
        const errorMsg = `❌ Failed to fetch ${url}: ${response.statusText}`;
        if (onProgress) await onProgress(errorMsg, "error");
        console.error(errorMsg);
        continue;
      }

      if (!response.body) continue;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let partialLine = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = (partialLine + chunk).split("\n");
        partialLine = lines.pop() || "";

        for (const line of lines) {
          processLine(line, blocked, allowed);
        }
      }

      if (partialLine) {
        processLine(partialLine, blocked, allowed);
      }
    } catch (e: any) {
      const errorMsg = `❌ Error processing ${url}: ${e.message}`;
      if (onProgress) await onProgress(errorMsg, "error");
      console.error(errorMsg);
    }
  }

  return {
    updated: true,
    blocked,
    allowed,
    metadata: newMetadata,
  };
}

/**
 * Processes a single line from a blocklist.
 * Optimized for minimal CPU usage.
 */
function processLine(line: string, blocked: Set<string>, allowed: Set<string>) {
  const trimmed = line.trim();
  
  // Fast skip for comments and empty lines
  if (!trimmed || trimmed[0] === "!" || trimmed[0] === "#" || trimmed[0] === "[" || (trimmed[0] === "!" && trimmed[1] === "#")) {
    return;
  }

  // Skip cosmetic filters and complex uBO syntax (most common heavy patterns)
  if (trimmed.includes("##") || trimmed.includes("#@#") || trimmed.includes("#$#") || trimmed.includes("#?#")) {
    return;
  }

  let domain = "";
  let isAllowed = false;

  if (trimmed.startsWith("@@||")) {
    isAllowed = true;
    domain = trimmed.substring(4);
  } else if (trimmed.startsWith("||")) {
    domain = trimmed.substring(2);
  } else if (trimmed.startsWith("0.0.0.0 ")) {
    domain = trimmed.substring(8).trim();
  } else if (trimmed.startsWith("127.0.0.1 ")) {
    domain = trimmed.substring(10).trim();
  } else if (/^[a-zA-Z0-9]/.test(trimmed) && !trimmed.includes("/") && !trimmed.includes(" ")) {
    domain = trimmed;
  }

  if (domain) {
    // Clean up domain: remove options like $third-party
    const optionsIndex = domain.indexOf("$");
    if (optionsIndex !== -1) domain = domain.substring(0, optionsIndex);

    // Remove trailing syntax like ^
    if (domain.endsWith("^")) domain = domain.substring(0, domain.length - 1);

    // Remove trailing dots
    while (domain.endsWith(".")) {
      domain = domain.substring(0, domain.length - 1);
    }

    domain = domain.toLowerCase().trim();

    // Final validation
    if (!domain || domain.includes("/") || domain.includes("*")) return;

    // 1. MUST NOT be an IP address (Cloudflare DOMAIN lists reject them)
    // We skip anything that is a valid IPv4
    const isValidIPv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(domain);
    if (isValidIPv4) return;

    // 2. MUST NOT be a partial IP or numeric-only domain
    // (Cloudflare rejects domains that are just numbers and dots)
    if (/^[0-9.]+$/.test(domain)) return;

    // 3. Basic domain structure: no empty labels, no labels > 63 chars
    const labels = domain.split(".");
    for (const l of labels) {
      if (
        l.length === 0 ||
        l.length > 63 ||
        !/^[a-z0-9-]/.test(l) ||
        !/[a-z0-9]$/.test(l)
      ) {
        return;
      }
    }

    if (isAllowed) {
      allowed.add(domain);
    } else {
      blocked.add(domain);
    }
  }
}