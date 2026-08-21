/**
 * Publishing taxonomy — deliberately NOT `.server.ts` (mirrors
 * services/store-visuals/types.ts / services/assets/types.ts's identical
 * reasoning): any route component that needs these as a runtime value
 * (e.g. a Publish button rendering per source type) can import them
 * without pulling in server-only code — see
 * https://reactrouter.com/explanation/code-splitting#removal-of-server-code.
 */
export const PUBLISHING_SOURCE_TYPES = ["GENERATION_RESULT", "PROCESSING_RESULT", "STORE_VISUAL_RESULT"] as const;
export type PublishingSourceTypeValue = (typeof PUBLISHING_SOURCE_TYPES)[number];

export const PUBLISHING_STATUSES = ["PENDING", "QUEUED", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type PublishingStatusValue = (typeof PUBLISHING_STATUSES)[number];
