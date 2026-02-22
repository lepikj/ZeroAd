/**
 * ZeroAd: Cloudflare API Interaction Helpers
 */

export interface Bindings {
  ADBLOCK_KV: KVNamespace;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  ADBLOCK_LIST_URLS: string;
  MAX_ITEMS_PER_LIST: string;
  LIST_PREFIX: string;
  MAX_LISTS: string;
  SCRIPT_NAME: string;
}

export interface FetchResult {
  updated: boolean;
  blocked?: Set<string>;
  allowed?: Set<string>;
  metadata?: Record<string, string>;
}

/**
 * Fetches the current Cron schedules for this worker.
 */
export async function getSchedules(
  accountId: string,
  scriptName: string,
  apiToken: string,
): Promise<string[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/schedules`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch schedules: ${response.statusText}`);
    void response.body?.cancel();
    return [];
  }

  const data = (await response.json()) as any;
  const crons = (data.result?.schedules || []).map((s: any) => s.cron);
  return crons;
}

/**
 * Updates the Cron schedules for this worker.
 */
export async function updateSchedules(
  accountId: string,
  scriptName: string,
  apiToken: string,
  crons: string[],
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/schedules`;
  const payload = crons.map((cron) => ({ cron }));

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Failed to update schedules: ${err}`);
    return false;
  }

  void response.body?.cancel();
  return true;
}

/**
 * Retrieves all DOMAIN type Gateway lists from the account.
 */
export async function getGatewayLists(
  accountId: string,
  apiToken: string,
): Promise<any[]> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists?type=DOMAIN`;
  const response = await fetch(baseUrl, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`Failed to list Gateway lists: ${response.statusText}`);
    void response.body?.cancel();
    return [];
  }

  const data = (await response.json()) as any;
  return data.result || [];
}

/**
 * Creates or replaces a Gateway list.
 */
export async function createOrUpdateGatewayList(
  accountId: string,
  apiToken: string,
  listName: string,
  items: string[],
  existingId?: string,
): Promise<string | null> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists`;
  const payload = items.map((item) => ({ value: item }));
  let targetId = existingId;

  if (!targetId) {
    const existingResponse = await fetch(`${baseUrl}?type=DOMAIN`, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!existingResponse.ok) {
      console.error(
        `Failed to list Gateway lists: ${existingResponse.statusText}`,
      );
      void existingResponse.body?.cancel();
      return null;
    }

    const existingData = (await existingResponse.json()) as any;
    const existingList = existingData.result.find(
      (l: any) => l.name === listName,
    );
    if (existingList) {
      targetId = existingList.id;
    }
  }

  if (targetId) {
    const updateUrl = `${baseUrl}/${targetId}`;
    const updateResponse = await fetch(updateUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: listName,
        type: "DOMAIN",
        items: payload,
      }),
    });

    if (!updateResponse.ok) {
      const err = await updateResponse.text();
      console.error(`Failed to update list ${listName}: ${err}`);
      return null;
    }

    void updateResponse.body?.cancel();
    return targetId;
  } else {
    const createResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: listName,
        type: "DOMAIN",
        items: payload,
      }),
    });

    if (!createResponse.ok) {
      const err = await createResponse.text();
      console.error(`Failed to create list ${listName}: ${err}`);
      return null;
    }

    const data = (await createResponse.json()) as any;
    return data.result.id;
  }
}

/**
 * Updates the Gateway Firewall Rule.
 */
export async function updateGatewayPolicy(
  accountId: string,
  apiToken: string,
  policyName: string,
  listIds: string[],
) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/rules`;
  const expression = listIds
    .map((id) => `any(dns.domains[*] in $${id})`)
    .join(" or ");

  const rulesResponse = await fetch(baseUrl, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!rulesResponse.ok) {
    void rulesResponse.body?.cancel();
    throw new Error(`Failed to fetch rules: ${rulesResponse.statusText}`);
  }

  const rulesData = (await rulesResponse.json()) as any;
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
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rulePayload),
    });

    if (!updateRes.ok) {
      const err = await updateRes.text();
      throw new Error(`Failed to update policy: ${err}`);
    }
    void updateRes.body?.cancel();
  } else {
    const createRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rulePayload),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create policy: ${err}`);
    }
    void createRes.body?.cancel();
  }
}

/**
 * Deletes a Gateway list by ID.
 */
export async function deleteGatewayList(
  accountId: string,
  apiToken: string,
  listId: string,
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists/${listId}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`Failed to delete list ${listId}: ${response.statusText}`);
    void response.body?.cancel();
    return false;
  }

  void response.body?.cancel();
  return true;
}