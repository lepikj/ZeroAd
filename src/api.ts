export interface Bindings {
  ADBLOCK_KV: KVNamespace;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  ADBLOCK_LIST_URLS: string; // Comma-separated URLs
  MAX_ITEMS_PER_LIST: string; 
  LIST_PREFIX: string;
  MAX_LISTS: string;
}

export interface FetchResult {
  updated: boolean;
  blocked?: Set<string>;
  allowed?: Set<string>;
  metadata?: Record<string, string>;
}

export async function fetchAdBlockList(
  urls: string[], 
  currentMetadata: Record<string, string> = {}
): Promise<FetchResult> {
  const newMetadata: Record<string, string> = {};
  let anyChanged = false;

  // Step 1: Check Headers (ETag/Last-Modified) using HEAD requests
  // This is extremely fast and saves CPU/Bandwidth
  console.log('Checking source headers for changes...');
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const etag = response.headers.get('etag') || response.headers.get('last-modified') || 'no-version';
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
      const lines = text.split('\n');

      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[') || line.startsWith('!#')) continue;

        // Skip cosmetic filters and complex uBO syntax
        if (line.includes('##') || line.includes('#@#') || line.includes('#$#') || line.includes('#?#')) continue;

        let domain = '';
        let isAllowed = false;

        if (line.startsWith('@@||')) {
          isAllowed = true;
          domain = line.substring(4);
        } else if (line.startsWith('||')) {
          domain = line.substring(2);
        } else if (line.startsWith('0.0.0.0 ') || line.startsWith('127.0.0.1 ')) {
          domain = line.split(/\s+/)[1];
        } else if (/^[a-zA-Z0-9]/.test(line) && !line.includes('/') && !line.includes(' ')) {
          // Pure domain name line
          domain = line;
        }

        if (domain) {
          // Clean up domain
          const optionsIndex = domain.indexOf('$');
          if (optionsIndex !== -1) domain = domain.substring(0, optionsIndex);

          if (domain.endsWith('^')) domain = domain.substring(0, domain.length - 1);
          
          // Remove trailing dots (Cloudflare Gateway doesn't like them)
          while (domain.endsWith('.')) {
            domain = domain.substring(0, domain.length - 1);
          }

          domain = domain.toLowerCase().trim();

          // Final validation: 
          // 1. No paths, no wildcards
          // 2. MUST NOT BE AN IP ADDRESS (Cloudflare DOMAIN lists reject IPs)
          const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(domain);

          if (domain && !domain.includes('/') && !domain.includes('*') && !isIP) {
            if (isAllowed) {
              allowed.add(domain);
            } else {
              blocked.add(domain);
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
    metadata: newMetadata 
  };
}

export async function getGatewayLists(accountId: string, apiToken: string): Promise<any[]> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists?type=DOMAIN`;
  const response = await fetch(baseUrl, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
     console.error(`Failed to list Gateway lists: ${response.statusText}`);
     void response.body?.cancel();
     return [];
  }

  const data = await response.json() as any;
  return data.result || [];
}

export async function createOrUpdateGatewayList(
  accountId: string,
  apiToken: string,
  listName: string,
  items: string[],
  existingId?: string // Optimization: pass ID if known to skip fetch
): Promise<string | null> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists`;
  const payload = items.map(item => ({ value: item }));

  let targetId = existingId;

  // If ID not provided, we must look it up (1 extra subrequest)
  if (!targetId) {
    const existingResponse = await fetch(`${baseUrl}?type=DOMAIN`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!existingResponse.ok) {
       console.error(`Failed to list Gateway lists: ${existingResponse.statusText}`);
       void existingResponse.body?.cancel();
       return null;
    }

    const existingData = await existingResponse.json() as any;
    const existingList = existingData.result.find((l: any) => l.name === listName);
    if (existingList) {
      targetId = existingList.id;
    }
  }

  if (targetId) {
    // Update existing list
    const updateUrl = `${baseUrl}/${targetId}`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: listName,
        type: 'DOMAIN',
        items: payload
      })
    });
    
    if (!updateResponse.ok) {
       const err = await updateResponse.text();
       console.error(`Failed to update list ${listName}: ${err}`);
       return null;
    }
    void updateResponse.body?.cancel();
    return targetId;
  } else {
    // Create new list
    const createResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: listName,
        type: 'DOMAIN',
        items: payload
      })
    });

    if (!createResponse.ok) {
       const err = await createResponse.text();
       console.error(`Failed to create list ${listName}: ${err}`);
       return null;
    }
    const data = await createResponse.json() as any;
    return data.result.id;
  }
}

export async function updateGatewayPolicy(
  accountId: string,
  apiToken: string,
  policyName: string,
  listIds: string[]
) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/rules`;
  
  // Construct traffic expression: "dns.content_category in { ... } or dns.domain in $list_id ..."
  // For lists, it is `any(dns.domains[*] in $list_id)`
  
  // Syntax: any(dns.domains[*] in $list_id_1) or any(dns.domains[*] in $list_id_2) ...
  const expression = listIds.map(id => `any(dns.domains[*] in $${id})`).join(' or ');

  // Fetch existing rules to find the one to update
  const rulesResponse = await fetch(baseUrl, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!rulesResponse.ok) {
    void rulesResponse.body?.cancel();
    throw new Error(`Failed to fetch rules: ${rulesResponse.statusText}`);
  }
  
  const rulesData = await rulesResponse.json() as any;
  const existingRule = rulesData.result.find((r: any) => r.name === policyName);

  const rulePayload = {
    name: policyName,
    description: "Block Ads (Managed by Worker)",
    action: "block",
    enabled: true,
    filters: ["dns"],
    traffic: expression,
  };

  if (existingRule) {
    const updateUrl = `${baseUrl}/${existingRule.id}`;
    const updateRes = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rulePayload)
    });
    if (!updateRes.ok) {
      const err = await updateRes.text();
      throw new Error(`Failed to update policy: ${err}`);
    }
    void updateRes.body?.cancel();
  } else {
    const createRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rulePayload)
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create policy: ${err}`);
    }
    void createRes.body?.cancel();
  }
}
