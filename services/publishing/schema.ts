/**
 * Validation for publishing requests — mirrors every other domain's
 * schema.ts (e.g. services/store-visuals/schema.ts's
 * `StoreVisualTypeSchema`).
 */
import { z } from "zod";
import { PUBLISHING_SOURCE_TYPES } from "./types";

export const PublishingSourceTypeSchema = z.enum(PUBLISHING_SOURCE_TYPES);
