/**
 * ZeroAd: Shared Types and Constants
 */

export interface Bindings {
  ADBLOCK_KV: KVNamespace;
  SYNC_BUCKET: R2Bucket;
  ADBLOCK_SYNC_WORKFLOW: { create: (options?: any) => Promise<any>, get: (id: string) => Promise<any>, list: (options?: any) => Promise<any> };
  CF_VERSION_METADATA: { id: string, tag: string, timestamp: string };
  SYNC_QUEUE: Queue<any>;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  ADBLOCK_LIST_URLS: string;
  MAX_ITEMS_PER_LIST: string;
  LIST_PREFIX: string;
  MAX_LISTS: string;
  SCRIPT_NAME: string;
}

export type SyncStatus =
  | "IDLE"
  | "DOWNLOADING"
  | "UPDATING_LISTS"
  | "UPDATING_POLICY"
  | "CLEANING_UP";

export interface ChunksMeta {
  total: number;
  current: number;
}

export interface SourceMetadata {
  [url: string]: string; // URL -> ETag/Last-Modified
}

export interface SourceStatus {
  name: string;
  url: string;
  hasUpdate: boolean;
  currentEtag: string;
  storedEtag?: string;
  error?: boolean;
}

// KV Key Constants
export const KV_KEYS = {
  STATUS: "status",
  CHUNKS_META: "chunks_meta",
  LIST_IDS: "list_ids",
  LAST_RUN: "last_run",
  METADATA: "source_metadata",
  HEARTBEAT: "last_heartbeat",
  CUSTOM_URLS: "config_urls",
  FULL_LIST: "FULL_LIST",
  SYNC_INTERVAL: "config_sync_interval",
};

// Logic Constants
export const CONFIG = {
  BATCH_SIZE: 5,
  HEARTBEAT_TTL_MS: 120000, // 2 minutes
  SYNC_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
};
